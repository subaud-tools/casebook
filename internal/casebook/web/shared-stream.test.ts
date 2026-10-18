// shared-stream.test.ts — every tab shares one live connection (Court,
// 2026-10-17: seven tabs used the browser's six connections and the page
// stopped loading).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedEventSource, type SharedDeps } from './shared-stream.ts';

// A fake browser: tabs share a channel and a lock; the real stream is a fake
// EventSource the test drives.
function browser() {
  const chans: Array<{ onmessage: ((e: { data: unknown }) => void) | null }> =
    [];
  let busy = false;
  const queue: Array<() => void> = [];
  const real: Real[] = [];
  class Real {
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string; lastEventId: string }) => void) | null =
      null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(url: string) {
      this.url = url;
      real.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const tab = (): SharedDeps => ({
    EventSource: Real,
    channel() {
      const me = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage(data: unknown) {
          for (const c of chans) if (c !== me) c.onmessage?.({ data });
        },
        close() {
          chans.splice(chans.indexOf(me), 1);
        },
      };
      chans.push(me);
      return me;
    },
    lock(granted, signal) {
      const run = () => {
        if (signal.aborted) return next();
        busy = true;
        void granted().then(next);
      };
      const next = () => {
        busy = false;
        const n = queue.shift();
        if (n) n();
      };
      if (busy) queue.push(run);
      else run();
    },
  });
  return { tab, real };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the first tab opens the one real stream; a second tab opens none', async () => {
  const b = browser();
  const A = sharedEventSource(b.tab());
  const B = sharedEventSource(b.tab());
  const a = new A('/api/events?since=1');
  const bb = new B('/api/events?since=1');
  await flush();
  assert.equal(b.real.length, 1);
  assert.equal(b.real[0].url, '/api/events?since=1');
  void a;
  void bb;
});

test('events reach every tab, with their cursor; open reaches a tab that joins late', async () => {
  const b = browser();
  const a = new (sharedEventSource(b.tab()))('/e');
  const got: string[] = [];
  let opened = 0;
  a.onmessage = (m) => got.push(`a ${m.data} ${m.lastEventId}`);
  await flush();
  b.real[0].onopen?.();
  const c = new (sharedEventSource(b.tab()))('/e');
  c.onopen = () => opened++;
  c.onmessage = (m) => got.push(`c ${m.data} ${m.lastEventId}`);
  await flush();
  b.real[0].onmessage?.({ data: '{"type":"x"}', lastEventId: '7' });
  assert.equal(opened, 1);
  assert.deepEqual(got.sort(), ['a {"type":"x"} 7', 'c {"type":"x"} 7']);
});

test('the stream failing tells every tab; the leader closing hands the lock on', async () => {
  const b = browser();
  const a = new (sharedEventSource(b.tab()))('/e?since=1');
  const c = new (sharedEventSource(b.tab()))('/e?since=1');
  let aErr = 0;
  let cErr = 0;
  a.onerror = () => aErr++;
  // As the kit's live() does: a stream that errs is closed and a new one
  // opened from the newest cursor.
  let c2: unknown = null;
  c.onerror = () => {
    cErr++;
    c.close();
    c2 = new (sharedEventSource(b.tab()))('/e?since=9');
  };
  await flush();
  b.real[0].onopen?.();
  await flush();
  // The leader's tab closes: the follower is told to reconnect, and its
  // next stream (a fresh cursor) becomes the real one.
  a.close();
  await flush();
  await flush();
  assert.equal(b.real[0].closed, true);
  assert.equal(cErr, 1);
  assert.ok(c2);
  assert.equal(b.real.at(-1)?.url, '/e?since=9');
  assert.equal(b.real.filter((r) => !r.closed).length, 1);
  assert.equal(aErr, 0);
});

test('a stream error at the leader reaches every tab', async () => {
  const b = browser();
  const a = new (sharedEventSource(b.tab()))('/e');
  const c = new (sharedEventSource(b.tab()))('/e');
  const errs: string[] = [];
  a.onerror = () => errs.push('a');
  c.onerror = () => errs.push('c');
  await flush();
  b.real[0].onerror?.();
  assert.deepEqual(errs.sort(), ['a', 'c']);
});

// A tab Chrome froze in the background misses the events another tab
// passed on (Court, 2026-10-18: a job stayed "0 of 1" after it was done).
// When it wakes it errs, so live() reads what it missed from its cursor.
test('a following tab that wakes asks live() to catch up', async () => {
  const b = browser();
  const wakes: Array<() => void> = [];
  const lead = new (sharedEventSource(b.tab()))('/e');
  const follow = new (sharedEventSource({
    ...b.tab(),
    onWake: (cb) => wakes.push(cb),
  }))('/e');
  let errs = 0;
  follow.onerror = () => errs++;
  await flush();
  b.real[0].onopen?.();
  await flush();
  for (const w of wakes) w();
  assert.equal(errs, 1);
  void lead;
});

// A tab that follows another's stream joins after its own cursor: what
// happened between (Court's own decisions in another tab) came over the
// channel before it listened (review, 2026-10-18). Told "open", it reads
// /api/state?since=<its cursor> itself, holding what is passed on meanwhile.
function follower(since: string) {
  const b = browser();
  const asked: string[] = [];
  let answer: (v: {
    cursor: string;
    events: Array<{ type: string; data: unknown }>;
  }) => void = () => {};
  const lead = new (sharedEventSource(b.tab()))('/e');
  const got: string[] = [];
  const f = new (sharedEventSource({
    ...b.tab(),
    catchUp(s) {
      asked.push(s);
      return new Promise((r) => (answer = r));
    },
  }))(`/e?since=${since}`);
  f.onmessage = (m) =>
    got.push(
      `${(JSON.parse(m.data) as { type: string }).type} ${m.lastEventId}`,
    );
  return {
    b,
    lead,
    f,
    got,
    asked,
    answer: (v: Parameters<typeof answer>[0]) => answer(v),
  };
}

test('an event passed on while a joining tab catches up reaches it once, after what it caught up', async () => {
  const t = follower('3');
  await flush();
  t.b.real[0].onopen?.();
  await flush();
  assert.deepEqual(t.asked, ['3']);
  t.b.real[0].onmessage?.({ data: '{"type":"x6"}', lastEventId: '6' });
  assert.deepEqual(
    t.got,
    [],
    'nothing passed on is delivered before the catch-up',
  );
  t.answer({
    cursor: '5',
    events: [
      { type: 'x4', data: {} },
      { type: 'x5', data: {} },
    ],
  });
  await flush();
  assert.deepEqual(t.got, ['x4 5', 'x5 5', 'x6 6']);
  void t.lead;
});

test('an event the catch-up already delivered is not delivered again', async () => {
  const t = follower('3');
  await flush();
  t.b.real[0].onopen?.();
  await flush();
  t.b.real[0].onmessage?.({ data: '{"type":"x6"}', lastEventId: '6' });
  t.answer({
    cursor: '6',
    events: [
      { type: 'x5', data: {} },
      { type: 'x6', data: {} },
    ],
  });
  await flush();
  t.b.real[0].onmessage?.({ data: '{"type":"x7"}', lastEventId: '7' });
  assert.deepEqual(t.got, ['x5 6', 'x6 6', 'x7 7']);
  void t.lead;
});
