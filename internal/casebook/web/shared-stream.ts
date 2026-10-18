// shared-stream.ts — one live connection for every casebook tab.
//
// A browser keeps at most six connections open to one site, and each tab's
// live stream holds one for good: with six tabs open, every other request of
// every tab waited (Court, 2026-10-17). So the tabs share one stream: the tab
// holding a lock opens the real EventSource and passes each event to the
// others over a BroadcastChannel; when it closes, the next tab takes the lock
// and its own stream.
//
// sharedEventSource returns a class the kit's live() takes as its
// EventSource: it has onopen, onmessage, onerror and close, which is all
// live() uses. A tab that joins after the stream opened asks for "open" and
// gets it, then reads what happened after its own cursor (the since in its
// address: events passed on before it listened) and delivers that first,
// holding what is passed on meanwhile. When the stream errs, or the tab holding it closes, every tab's
// stream errs, and live() reconnects each with its newest cursor (polling
// meanwhile), so nothing between is lost.

/** What a stream message carries, as live() reads it. */
export interface StreamMessage {
  data: string;
  lastEventId: string;
}

/** A poll's answer: what happened after since, and the cursor after it. */
export interface PollBody {
  cursor: string;
  events: Array<{ type: string; data: unknown }>;
}

interface Channel {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

/** The browser parts it needs (injected in tests). */
export interface SharedDeps {
  EventSource: new (url: string) => {
    onopen: (() => void) | null;
    onmessage: ((m: StreamMessage) => void) | null;
    onerror: (() => void) | null;
    close(): void;
  };
  channel(): Channel;
  /** Run granted while holding the one lock; its promise ending releases it. */
  lock(granted: () => Promise<void>, signal: AbortSignal): void;
  /**
   * Calls cb when the tab comes back (shown again, or unfrozen): a following
   * tab may have missed what was passed on while it was frozen. Returns a
   * function that stops it.
   */
  onWake?(cb: () => void): () => void;
  /**
   * Reads what happened after cursor since (GET <poll>?since=): a following
   * tab catches up with it. A poll answers at most POLL_MAX events.
   */
  catchUp?(since: string): Promise<PollBody>;
}

// POLL_MAX is the most events serve's poll answers at once.
const POLL_MAX = 500;

// sinceOf is the cursor in a stream address ("" for none).
function sinceOf(url: string): string {
  return new URL(url, 'http://x').searchParams.get('since') ?? '';
}

type Note =
  | { k: 'open' }
  | { k: 'msg'; data: string; id: string }
  | { k: 'error' }
  | { k: 'hello' };

export interface SharedSource {
  onopen: (() => void) | null;
  onmessage: ((m: StreamMessage) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export function sharedEventSource(
  deps: SharedDeps,
): new (url: string) => SharedSource {
  return class Shared implements SharedSource {
    onopen: (() => void) | null = null;
    onmessage: ((m: StreamMessage) => void) | null = null;
    onerror: (() => void) | null = null;
    private closed = false;
    private opened = false;
    private leading = false;
    private real: InstanceType<SharedDeps['EventSource']> | null = null;
    private release: (() => void) | null = null;
    private readonly abort = new AbortController();
    private readonly ch: Channel;
    private unwake: (() => void) | null = null;
    // A follower with a cursor catches up before it delivers what is passed
    // on (held meanwhile); last is the newest cursor it delivered.
    private readonly since: string;
    private catching: boolean;
    private held: Array<{ data: string; id: string }> = [];
    private last = '';

    constructor(url: string) {
      this.since = sinceOf(url);
      this.catching = !!this.since && !!deps.catchUp;
      this.ch = deps.channel();
      this.ch.onmessage = (e) => this.heard(e.data as Note);
      // Some tab may already hold the stream: ask whether it is open, once
      // live() has set its handlers.
      queueMicrotask(() => {
        if (!this.closed) this.ch.postMessage({ k: 'hello' } satisfies Note);
      });
      deps.lock(() => this.granted(url), this.abort.signal);
      // A following tab that wakes reconnects: live() reads what it missed
      // from its cursor (the leader's stream does that itself).
      this.unwake =
        deps.onWake?.(() => {
          if (!this.closed && !this.leading && this.opened) this.onerror?.();
        }) ?? null;
    }

    // heard is another tab's note.
    private heard(n: Note): void {
      if (this.closed) return;
      if (this.leading) {
        if (n.k === 'hello' && this.opened)
          this.ch.postMessage({ k: 'open' } satisfies Note);
        return;
      }
      if (n.k === 'open' && !this.opened) {
        this.opened = true;
        this.onopen?.();
        if (this.catching) void this.catchUp();
      } else if (n.k === 'msg') {
        if (this.catching) this.held.push({ data: n.data, id: n.id });
        else this.passOn(n.data, n.id);
      } else if (n.k === 'error') {
        this.onerror?.();
      }
    }

    // passOn delivers an event passed on, unless its cursor was delivered
    // already (cursors are increasing integers).
    private passOn(data: string, id: string): void {
      if (id && this.last && Number(id) <= Number(this.last)) return;
      if (id) this.last = id;
      this.onmessage?.({ data, lastEventId: id });
    }

    // catchUp reads what happened after this stream's cursor, delivers it,
    // then what was passed on meanwhile. A failed read errs the stream:
    // live() polls from its cursor.
    private async catchUp(): Promise<void> {
      const read = deps.catchUp?.bind(deps);
      if (!read) return;
      let cur = this.since;
      try {
        for (;;) {
          const body = await read(cur);
          if (this.closed) return;
          const evs = body.events ?? [];
          for (const e of evs)
            this.onmessage?.({
              data: JSON.stringify({ type: e.type, data: e.data }),
              lastEventId: body.cursor,
            });
          if (body.cursor) cur = this.last = body.cursor;
          if (evs.length < POLL_MAX) break;
        }
      } catch {
        if (this.closed) return;
        this.catching = false;
        this.held = [];
        this.onerror?.();
        return;
      }
      this.catching = false;
      const held = this.held;
      this.held = [];
      for (const m of held) {
        if (this.closed) return;
        this.passOn(m.data, m.id);
      }
    }

    // granted: this tab holds the lock. A stream that was following another
    // tab's has an old cursor in its address: it asks live() to reconnect
    // (a fresh one takes the lock) instead of replaying from it.
    private granted(url: string): Promise<void> {
      if (this.closed) return Promise.resolve();
      if (this.opened) {
        this.onerror?.();
        return Promise.resolve();
      }
      this.leading = true;
      const done = new Promise<void>((r) => (this.release = r));
      const real = new deps.EventSource(url);
      this.real = real;
      real.onopen = () => {
        if (this.closed) return;
        this.opened = true;
        this.ch.postMessage({ k: 'open' } satisfies Note);
        this.onopen?.();
      };
      real.onmessage = (m) => {
        if (this.closed) return;
        this.ch.postMessage({
          k: 'msg',
          data: m.data,
          id: m.lastEventId,
        } satisfies Note);
        this.onmessage?.(m);
      };
      real.onerror = () => {
        if (this.closed) return;
        this.ch.postMessage({ k: 'error' } satisfies Note);
        this.onerror?.();
      };
      return done;
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      if (this.leading) {
        // The others followed this stream: they reconnect.
        this.ch.postMessage({ k: 'error' } satisfies Note);
        this.real?.close();
        this.real = null;
      }
      this.abort.abort();
      this.release?.();
      this.unwake?.();
      this.ch.close();
    }
  };
}

/**
 * browserShared is the EventSource live() takes: shared between tabs where
 * the browser has locks and BroadcastChannel, the plain one otherwise.
 */
export function browserShared(name: string, poll: string): typeof EventSource {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof BroadcastChannel === 'undefined') return EventSource;
  return sharedEventSource({
    EventSource: EventSource as unknown as SharedDeps['EventSource'],
    channel: () => new BroadcastChannel(name) as unknown as Channel,
    lock(granted, signal) {
      locks.request(name, { signal }, granted).catch(() => {
        // aborted while waiting: the stream closed before its turn
      });
    },
    async catchUp(since) {
      const res = await fetch(`${poll}?since=${encodeURIComponent(since)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`poll: HTTP ${res.status}`);
      return (await res.json()) as PollBody;
    },
    onWake(cb) {
      const shown = (): void => {
        if (document.visibilityState === 'visible') cb();
      };
      document.addEventListener('visibilitychange', shown);
      document.addEventListener('resume', cb);
      return () => {
        document.removeEventListener('visibilitychange', shown);
        document.removeEventListener('resume', cb);
      };
    },
  }) as unknown as typeof EventSource;
}
