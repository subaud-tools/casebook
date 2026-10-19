// shared-stream.ts
var POLL_MAX = 500;
function sinceOf(url) {
  return new URL(url, "http://x").searchParams.get("since") ?? "";
}
function sharedEventSource(deps) {
  return class Shared {
    onopen = null;
    onmessage = null;
    onerror = null;
    closed = false;
    opened = false;
    leading = false;
    real = null;
    release = null;
    abort = new AbortController();
    ch;
    unwake = null;
    // A follower with a cursor catches up before it delivers what is passed
    // on (held meanwhile); last is the newest cursor it delivered.
    since;
    catching;
    held = [];
    last = "";
    constructor(url) {
      this.since = sinceOf(url);
      this.catching = !!this.since && !!deps.catchUp;
      this.ch = deps.channel();
      this.ch.onmessage = (e) => this.heard(e.data);
      queueMicrotask(() => {
        if (!this.closed) this.ch.postMessage({ k: "hello" });
      });
      deps.lock(() => this.granted(url), this.abort.signal);
      this.unwake = deps.onWake?.(() => {
        if (!this.closed && !this.leading && this.opened) this.onerror?.();
      }) ?? null;
    }
    // heard is another tab's note.
    heard(n) {
      if (this.closed) return;
      if (this.leading) {
        if (n.k === "hello" && this.opened)
          this.ch.postMessage({ k: "open" });
        return;
      }
      if (n.k === "open" && !this.opened) {
        this.opened = true;
        this.onopen?.();
        if (this.catching) void this.catchUp();
      } else if (n.k === "msg") {
        if (this.catching) this.held.push({ data: n.data, id: n.id });
        else this.passOn(n.data, n.id);
      } else if (n.k === "error") {
        this.onerror?.();
      }
    }
    // passOn delivers an event passed on, unless its cursor was delivered
    // already (cursors are increasing integers).
    passOn(data, id) {
      if (id && this.last && Number(id) <= Number(this.last)) return;
      if (id) this.last = id;
      this.onmessage?.({ data, lastEventId: id });
    }
    // catchUp reads what happened after this stream's cursor, delivers it,
    // then what was passed on meanwhile. A failed read errs the stream:
    // live() polls from its cursor.
    async catchUp() {
      const read = deps.catchUp?.bind(deps);
      if (!read) return;
      let cur = this.since;
      try {
        for (; ; ) {
          const body = await read(cur);
          if (this.closed) return;
          const evs = body.events ?? [];
          for (const e of evs)
            this.onmessage?.({
              data: JSON.stringify({ type: e.type, data: e.data }),
              lastEventId: body.cursor
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
    granted(url) {
      if (this.closed) return Promise.resolve();
      if (this.opened) {
        this.onerror?.();
        return Promise.resolve();
      }
      this.leading = true;
      const done = new Promise((r) => this.release = r);
      const real = new deps.EventSource(url);
      this.real = real;
      real.onopen = () => {
        if (this.closed) return;
        this.opened = true;
        this.ch.postMessage({ k: "open" });
        this.onopen?.();
      };
      real.onmessage = (m) => {
        if (this.closed) return;
        this.ch.postMessage({
          k: "msg",
          data: m.data,
          id: m.lastEventId
        });
        this.onmessage?.(m);
      };
      real.onerror = () => {
        if (this.closed) return;
        this.ch.postMessage({ k: "error" });
        this.onerror?.();
      };
      return done;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.leading) {
        this.ch.postMessage({ k: "error" });
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
function browserShared(name, poll) {
  const locks = navigator.locks;
  if (!locks || typeof BroadcastChannel === "undefined") return EventSource;
  return sharedEventSource({
    EventSource,
    channel: () => new BroadcastChannel(name),
    lock(granted, signal) {
      locks.request(name, { signal }, granted).catch(() => {
      });
    },
    async catchUp(since) {
      const res = await fetch(`${poll}?since=${encodeURIComponent(since)}`, {
        credentials: "same-origin"
      });
      if (!res.ok) throw new Error(`poll: HTTP ${res.status}`);
      return await res.json();
    },
    onWake(cb) {
      const shown = () => {
        if (document.visibilityState === "visible") cb();
      };
      document.addEventListener("visibilitychange", shown);
      document.addEventListener("resume", cb);
      return () => {
        document.removeEventListener("visibilitychange", shown);
        document.removeEventListener("resume", cb);
      };
    }
  });
}

// status-text.ts
function pushStatus(s) {
  if (s.queued <= 0) return null;
  if (s.error)
    return { text: `push failed · ${s.queued} queued`, tone: "danger" };
  if (s.offline)
    return { text: `offline · ${s.queued} queued`, tone: "danger" };
  return { text: `saving ${s.queued}`, tone: "muted" };
}

// app.ts
import {
  bar,
  createApi,
  createKeys,
  live,
  initTheme,
  h
} from "/_kit/kit.js";

// router-helpers.ts
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function pathEscape(s) {
  return encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%40/gi, "@");
}
function parse(hash) {
  const full = hash.replace(/^#\//, "");
  const q = full.indexOf("?");
  const path = q === -1 ? full : full.slice(0, q);
  const query = q === -1 ? "" : full.slice(q + 1);
  const slash = path.indexOf("/");
  const head = slash === -1 ? path : path.slice(0, slash);
  if (head === "attention" || head === "rules") {
    const id = slash === -1 ? "" : safeDecode(path.slice(slash + 1));
    return {
      section: "decide",
      sub: "",
      query: head === "rules" && id ? `rule=${encodeURIComponent(id)}` : query
    };
  }
  if (head === "apply") {
    return slash === -1 ? { section: "review", sub: "", query } : { section: "run", sub: safeDecode(path.slice(slash + 1)), query };
  }
  if (slash === -1) {
    return { section: path || "decide", sub: "", query };
  }
  return { section: head, sub: safeDecode(path.slice(slash + 1)), query };
}
function decideQuery(o) {
  const parts = [];
  if (o.rule) parts.push(`rule=${o.rule}`);
  if (o.filters.length) parts.push(`filters=${o.filters.join(",")}`);
  if (o.q) parts.push(`q=${encodeURIComponent(o.q)}`);
  if (o.flat) parts.push("flat");
  return parts.join("&");
}
function ruleHash(id) {
  return `#/decide?rule=${encodeURIComponent(id)}`;
}
function flatFor(explicit, query, stored) {
  return explicit ? new URLSearchParams(query).has("flat") : stored;
}

// router.ts
var listeners = [];
function go(section, sub, query) {
  const path = sub ? `#/${section}/${pathEscape(sub)}` : `#/${section}`;
  location.hash = query ? `${path}?${query}` : path;
}
function onRoute(cb) {
  listeners.push(cb);
}
function fire() {
  const r = parse(location.hash);
  for (const cb of listeners) cb(r);
}
window.addEventListener("hashchange", fire);
function dispatchCurrent() {
  fire();
}

// key-layer.ts
function navKeys(nav) {
  const ks = [
    { keys: "j", label: "next", run: () => nav.move(1) },
    { keys: "↓", label: "next", run: () => nav.move(1) },
    { keys: "k", label: "previous", run: () => nav.move(-1) },
    { keys: "↑", label: "previous", run: () => nav.move(-1) },
    { keys: "o", label: "open", run: () => nav.open() },
    { keys: "↵", label: "open", run: () => nav.open() }
  ];
  if (typeof nav.focusSearch === "function") {
    const search = nav.focusSearch.bind(nav);
    ks.push({ keys: "/", label: "search", run: () => search() });
  }
  return ks.map((k) => ({ ...k, group: "family" }));
}
function groupKeys(jump) {
  return [
    { keys: "[", label: "previous group", group: "page", run: () => jump(-1) },
    { keys: "]", label: "next group", group: "page", run: () => jump(1) }
  ];
}
function makeKeyLayer(create, report) {
  const page = [];
  let current = create();
  let shown;
  let shownList = null;
  let shownKeys = [];
  const clash = (where, b, err) => report(
    `[casebook] key clash in ${where}: "${b.keys}" (${b.label}): ${err instanceof Error ? err.message : String(err)}`
  );
  function rebuild() {
    current.destroy();
    const l = shownList;
    current = create(l && l.selects ? l.nav : void 0);
    if (l && !l.selects) {
      for (const b of navKeys(l.nav)) {
        try {
          current.register(b);
        } catch (err) {
          clash(`section ${shown?.id} (list)`, b, err);
        }
      }
    }
    for (const p of page) {
      try {
        p.unbind = current.register(p.b);
      } catch (err) {
        p.unbind = null;
        clash("the page", p.b, err);
      }
    }
    for (const b of shownKeys) {
      try {
        current.register(b);
      } catch (err) {
        clash(`section ${shown?.id}`, b, err);
      }
    }
  }
  const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  return {
    keys: {
      register(b) {
        const p = { b, unbind: current.register(b) };
        page.push(p);
        return () => {
          p.unbind?.();
          p.unbind = null;
          const i = page.indexOf(p);
          if (i >= 0) page.splice(i, 1);
        };
      },
      showHelp: (open) => current.showHelp(open),
      bindings: () => current.bindings(),
      destroy() {
        page.length = 0;
        current.destroy();
      }
    },
    bind(sec) {
      const l = sec?.listKeys?.() ?? null;
      const ks = sec?.keys?.() ?? [];
      if (sec === shown && l?.nav === shownList?.nav && l?.selects === shownList?.selects && same(ks, shownKeys))
        return;
      shown = sec;
      shownList = l;
      shownKeys = ks;
      rebuild();
    }
  };
}

// walkthrough.ts
var WALKTHROUGH_SEEN = "casebook.walkthrough";
var WALKTHROUGH_STEPS = [
  {
    id: "decide",
    target: '.kit-ctl[data-id="decide"]',
    note: "decide lists everything that needs a decision: branches, pull requests, issues, repos and worktrees."
  },
  {
    id: "filters",
    target: ".kit-list:not([hidden]) .cb-filters",
    note: "Filters narrow the list. Pick one or more; + filter saves a new one."
  },
  {
    id: "rules",
    target: ".kit-list:not([hidden]) .cb-rule-row",
    note: "Rules recommend a decision for many items at once. Each rule’s recommendations are a group in the list, with one button for all of them."
  },
  {
    id: "decision",
    target: ".kit-read:not([hidden]) .cb-decide-row .cb-choice",
    note: "A button like this decides the item. Nothing happens yet: what you decide waits in review."
  },
  {
    id: "review",
    target: '.kit-ctl[data-id="review"]',
    note: "review shows what each group of decisions will do, command by command. Its button runs it, and run shows the job as it goes."
  },
  {
    id: "agent",
    target: ".kit-rail",
    note: "Ask the agent at any point. It knows what you’re looking at."
  }
];
var MARGIN = 8;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
function placeNote(target, card6, view, gap = 12) {
  const maxX = Math.max(MARGIN, view.width - card6.width - MARGIN);
  const maxY = Math.max(MARGIN, view.height - card6.height - MARGIN);
  const x = clamp(target.x, MARGIN, maxX);
  const y = clamp(target.y, MARGIN, maxY);
  const below = target.y + target.height + gap;
  if (below + card6.height <= view.height - MARGIN) return { x, y: below };
  const above = target.y - gap - card6.height;
  if (above >= MARGIN) return { x, y: above };
  const left = target.x - gap - card6.width;
  if (left >= MARGIN) return { x: left, y };
  const right = target.x + target.width + gap;
  if (right + card6.width <= view.width - MARGIN) return { x: right, y };
  return {
    x: clamp((view.width - card6.width) / 2, MARGIN, maxX),
    y: clamp((view.height - card6.height) / 2, MARGIN, maxY)
  };
}
function walkthroughSeen() {
  try {
    return localStorage.getItem(WALKTHROUGH_SEEN) === "seen";
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(WALKTHROUGH_SEEN, "seen");
  } catch {
  }
}
function el(tag, cls, text = "") {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(sel, ms) {
  const end = Date.now() + ms;
  for (; ; ) {
    const e = document.querySelector(sel);
    if (e && e.getBoundingClientRect().width > 0) return e;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}
var ROW = ".kit-list:not([hidden]) .kit-row:not(.cb-left-open)";
var UNDECIDED = '.kit-list:not([hidden]) .cb-group:not([data-group="left-open"])';
var GROUP_CARET = `${UNDECIDED}.collapsed .cb-group-caret`;
var HAS_ITEMS = `${ROW}, ${UNDECIDED}`;
function makeWalkthrough(ctx) {
  let running = false;
  function start2() {
    if (running) return;
    running = true;
    ctx.pauseLive(true);
    if (!location.hash) history.replaceState(history.state, "", "#/decide");
    const startHash = location.hash;
    const pane = ctx.dockPane();
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = el("div", "cb-walk");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "walkthrough");
    const ring = el("div", "cb-walk-ring");
    const card6 = el("div", "cb-walk-card");
    const count2 = el("p", "cb-walk-count");
    const note = el("p", "cb-walk-note");
    const skipBtn = el("button", "kit-btn cb-walk-skip", "skip");
    const nextBtn = el("button", "kit-btn fill cb-walk-next", "next");
    skipBtn.type = "button";
    nextBtn.type = "button";
    const acts = el("div", "cb-walk-acts");
    acts.append(skipBtn, nextBtn);
    card6.append(count2, note, acts);
    ring.hidden = true;
    card6.hidden = true;
    overlay.append(ring, card6);
    document.body.append(overlay);
    let steps = WALKTHROUGH_STEPS;
    let at2 = -1;
    let ended = false;
    let raf = 0;
    let moving = false;
    let pushed = 0;
    function onHash() {
      if (moving) pushed++;
      else finish(false);
    }
    window.addEventListener("hashchange", onHash);
    function place() {
      const step = steps[at2];
      const target = step ? document.querySelector(step.target) : null;
      if (target) {
        const r = target.getBoundingClientRect();
        ring.style.left = `${r.x}px`;
        ring.style.top = `${r.y}px`;
        ring.style.width = `${r.width}px`;
        ring.style.height = `${r.height}px`;
        const p = placeNote(
          r,
          { width: card6.offsetWidth, height: card6.offsetHeight },
          { width: innerWidth, height: innerHeight }
        );
        card6.style.left = `${p.x}px`;
        card6.style.top = `${p.y}px`;
      }
      raf = requestAnimationFrame(place);
    }
    async function show(i) {
      for (; i < steps.length; i++) {
        const step = steps[i];
        if (step.id === "decision") {
          let row = document.querySelector(ROW);
          if (!row) {
            document.querySelector(GROUP_CARET)?.click();
            row = await waitFor(ROW, 4e3);
            if (ended) return;
          }
          if (!row) continue;
          row.click();
        }
        if (step.id === "agent") ctx.setDockPane(true);
        const target = await waitFor(step.target, 4e3);
        if (ended) return;
        if (!target) continue;
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
        at2 = i;
        overlay.dataset.step = step.id;
        count2.textContent = `${i + 1} of ${steps.length}`;
        note.textContent = step.note;
        nextBtn.textContent = i === steps.length - 1 ? "done" : "next";
        ring.hidden = false;
        card6.hidden = false;
        nextBtn.focus();
        return;
      }
      finish();
    }
    function next() {
      if (moving || ended) return;
      moving = true;
      void show(at2 + 1).finally(() => {
        moving = false;
      });
    }
    function finish(restore = true) {
      if (ended) return;
      ended = true;
      markSeen();
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("hashchange", onHash);
      overlay.remove();
      if (restore && pushed > 0) history.go(-pushed);
      else if (restore && location.hash !== startHash) {
        if (startHash) location.hash = startHash;
        else ctx.route.go("decide");
      }
      ctx.setDockPane(pane);
      if (focused?.isConnected) focused.focus();
      ctx.pauseLive(false);
      running = false;
    }
    function onKey(e) {
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === nextBtn ? skipBtn : nextBtn).focus();
        return;
      }
      const onButton = e.target === skipBtn || e.target === nextBtn;
      if (onButton && (e.key === "Enter" || e.key === " ")) return;
      e.preventDefault();
    }
    skipBtn.addEventListener("click", () => finish());
    nextBtn.addEventListener("click", () => next());
    window.addEventListener("keydown", onKey, true);
    raf = requestAnimationFrame(place);
    moving = true;
    void (async () => {
      const at3 = ctx.route.current().section;
      if (at3 === "review" || at3 === "run") ctx.route.go("decide");
      await waitFor(".kit-list:not([hidden]) .kit-rows > *", 4e3);
      if (ended) return;
      if (!document.querySelector(HAS_ITEMS))
        steps = WALKTHROUGH_STEPS.filter((s) => s.id !== "decision");
      await show(0);
      moving = false;
    })();
  }
  return { start: start2 };
}

// app.ts
var sectionMakers = [];
var dockMakers = [];
function registerSection(make) {
  sectionMakers.push(make);
}
function registerDock(make) {
  dockMakers.push(make);
}
var liveListeners = /* @__PURE__ */ new Map();
function onLiveEvent(type, cb) {
  let list2 = liveListeners.get(type);
  if (!list2) {
    list2 = [];
    liveListeners.set(type, list2);
  }
  list2.push(cb);
}
function emitLive(type, data) {
  const list2 = liveListeners.get(type);
  if (list2) for (const cb of list2) cb(data);
}
var booted = false;
function boot() {
  if (booted) return;
  booted = true;
  void fetch("/api/summary", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((first) => start(first));
}
function start(first) {
  let stale = false;
  const gated = (input, init) => stale ? Promise.reject(
    new Error("casebook serve restarted: this tab has stopped")
  ) : fetch(input, init);
  const api = createApi({
    fetch: gated,
    onStale() {
      goStale();
    }
  });
  function svgEl(tag, attrs, ...children) {
    const NS = "http://www.w3.org/2000/svg";
    const el2 = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el2.setAttribute(k, v);
    for (const child of children) el2.appendChild(child);
    return el2;
  }
  const mark = svgEl(
    "svg",
    {
      viewBox: "0 0 64 64",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true"
    },
    // ink tile
    svgEl("rect", { width: "64", height: "64", rx: "14", fill: "#14161d" }),
    // open book outline
    svgEl("path", {
      d: "M32 18C25 13 16 13 8 15V49C16 47 25 47 32 52C39 47 48 47 56 49V15C48 13 39 13 32 18Z",
      fill: "none",
      stroke: "#d98a9e",
      "stroke-width": "5",
      "stroke-linejoin": "round"
    }),
    // spine
    svgEl("path", { d: "M32 18V52", stroke: "#d98a9e", "stroke-width": "4.4" }),
    // one neutral rule on the left page
    svgEl("path", {
      d: "M15 29H25",
      stroke: "#9aa0ab",
      "stroke-width": "5",
      "stroke-linecap": "round"
    }),
    // tick on the right page (fully drawn — resting frame)
    svgEl("path", {
      d: "M37 33L42 38L50 26",
      fill: "none",
      stroke: "#d98a9e",
      "stroke-width": "6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    })
  );
  const handle = bar({
    brand: { name: "casebook", mark },
    sections: [
      { id: "decide", label: "decide" },
      { id: "review", label: "review" },
      { id: "run", label: "run" }
    ],
    active: "decide",
    onSection(id) {
      go(id);
    },
    staleText: "restarted · continued in a new tab"
  });
  initTheme("casebook", handle.themeControl);
  const retryBtn = h(
    "button",
    {
      class: "kit-btn",
      type: "button",
      "data-testid": "down-retry",
      onclick: () => retry()
    },
    "retry"
  );
  const banner = h(
    "div",
    { class: "cb-down", role: "alert", "data-testid": "down-banner" },
    h(
      "span",
      { class: "cb-down-text" },
      "disconnected · the casebook server isn’t answering; this page keeps trying"
    ),
    retryBtn
  );
  banner.hidden = true;
  let down = false;
  function setDown(on) {
    if (down && !on && !stale) loadSummary();
    down = on;
    banner.hidden = !on;
    retryBtn.disabled = false;
    retryBtn.textContent = "retry";
  }
  const pushText = h("span", { class: "cb-down-text" });
  const pushStrip = h(
    "div",
    {
      class: "cb-down cb-push-error",
      role: "alert",
      "data-testid": "push-error"
    },
    pushText
  );
  pushStrip.hidden = true;
  function paintPushError(reason) {
    const text = reason ? `push failed · ${reason}` : "";
    if (pushText.textContent !== text) pushText.textContent = text;
    pushStrip.title = reason;
    pushStrip.hidden = !reason;
  }
  const app = h("div", { class: "kit-app" });
  app.append(handle.el, banner, pushStrip);
  let currentRoute = { section: "decide", sub: "", query: "" };
  const dockHandles = [];
  let lastAttached = {};
  let lastTitle = "";
  let agent = "";
  const agentListeners = [];
  let dockSession = "";
  const dockSessionListeners = [];
  let dockTarget = null;
  const dockTargetListeners = [];
  let livePaused = false;
  const held = [];
  const layer = makeKeyLayer(
    (list2) => createKeys(list2 ? { list: list2 } : {}),
    (m) => console.error(m)
  );
  const ctx = {
    api,
    bar: handle,
    keys: layer.keys,
    route: {
      current: () => currentRoute,
      go
    },
    on: onLiveEvent,
    setPrimary(p) {
      handle.setPrimary(p);
    },
    setAttached(a, jobTitle2 = "") {
      lastAttached = a;
      lastTitle = jobTitle2;
      for (const d of dockHandles) d.setAttached(a, jobTitle2);
    },
    focusComposer() {
      dockHandles[0]?.focusComposer();
    },
    agentName: () => agent,
    setAgentName(name) {
      if (name === agent) return;
      agent = name;
      for (const cb of agentListeners) cb(name);
    },
    onAgentName(cb) {
      agentListeners.push(cb);
    },
    dockSession: () => dockSession,
    setDockSession(id) {
      if (id === dockSession) return;
      dockSession = id;
      for (const cb of dockSessionListeners) cb(id);
    },
    onDockSession(cb) {
      dockSessionListeners.push(cb);
    },
    dockTarget: () => dockTarget,
    setDockTarget(t) {
      if (t?.id === dockTarget?.id && t?.name === dockTarget?.name) return;
      dockTarget = t ? { ...t } : null;
      for (const cb of dockTargetListeners) cb(dockTarget);
    },
    onDockTarget(cb) {
      dockTargetListeners.push(cb);
    },
    askSession(body, attached, purpose) {
      const d = dockHandles[0];
      return d ? d.sendText(body, attached, purpose) : Promise.resolve("no agent session");
    },
    pauseLive(on) {
      livePaused = on;
      if (on) return;
      for (const e of held.splice(0)) deliver(e.type, e.data);
    },
    dockPane: () => dockHandles[0]?.pane() ?? null,
    setDockPane(v) {
      dockHandles[0]?.setPane(v);
    }
  };
  const sections = /* @__PURE__ */ new Map();
  for (const make of sectionMakers) {
    const sec = make(ctx);
    sections.set(sec.id, sec);
    sec.list.hidden = true;
    sec.read.hidden = true;
    app.append(sec.list, sec.read);
  }
  if (sections.size === 0) {
    const list2 = h("div", { class: "kit-list" });
    const read = h("div", { class: "kit-read" });
    app.append(list2, read);
  }
  const rail = h("div", { class: "kit-rail" });
  for (const make of dockMakers) {
    const d = make(ctx);
    d.setAttached(lastAttached, lastTitle);
    dockHandles.push(d);
  }
  if (dockHandles.length > 0) {
    for (const d of dockHandles) rail.append(d.el);
  }
  app.append(rail);
  document.body.append(app);
  const sharedStream = browserShared("casebook-live", "/api/state");
  function startLive(cursor) {
    return live({
      events: "/api/events",
      poll: "/api/state",
      // One connection for every tab: each tab holding its own used up the
      // browser's six and stopped every other request.
      EventSource: sharedStream,
      cursor,
      onEvent(e) {
        if (livePaused) held.push({ type: e.type, data: e.data });
        else deliver(e.type, e.data);
      },
      onStatus,
      fetch: async (url, init) => {
        const res = await gated(url, init);
        if (res.ok && down && !stale) {
          setDown(false);
          handle.setLive("polling");
        }
        return res;
      }
    });
  }
  function onStatus(s) {
    if (stale) return;
    switch (s) {
      case "stale":
        goStale();
        return;
      case "down":
        setDown(true);
        handle.setLive("down", "disconnected");
        return;
      case "live":
        setDown(false);
        handle.setLive("live");
        return;
      case "polling":
        if (!down) handle.setLive("polling");
        return;
    }
  }
  function deliver(type, data) {
    if (type === "gap") loadSummary();
    emitLive(type, data);
    for (const sec of sections.values()) sec.onLive(type, data);
  }
  function retry() {
    if (stale) return;
    const cursor = liveClient.cursor();
    liveClient.stop();
    retryBtn.disabled = true;
    retryBtn.textContent = "retrying…";
    liveClient = startLive(cursor);
  }
  function goStale() {
    if (stale) return;
    stale = true;
    liveClient?.stop();
    setDown(false);
    handle.setLive("stale");
  }
  let liveClient = startLive(
    first && typeof first.cursor === "number" ? String(first.cursor) : void 0
  );
  for (const [k, id, label] of [
    ["g d", "decide", "go to decide"],
    ["g v", "review", "go to review"],
    ["g r", "run", "go to run"]
  ]) {
    ctx.keys.register({ keys: k, label, run: () => go(id) });
  }
  const walkthrough = makeWalkthrough(ctx);
  ctx.keys.register({
    keys: "g w",
    label: "show the walkthrough",
    run: () => walkthrough.start()
  });
  onRoute((r) => {
    currentRoute = r;
    if (/^#\/(attention|rules|apply)(\/|\?|$)/.test(location.hash)) {
      const path = r.sub ? `#/${r.section}/${pathEscape(r.sub)}` : `#/${r.section}`;
      const hash = r.query ? `${path}?${r.query}` : path;
      history.replaceState(
        null,
        "",
        location.pathname + location.search + hash
      );
    }
    const step = r.section === "review" || r.section === "run" ? r.section : "";
    const sectionId = step ? "apply" : "decide";
    handle.setSection(step || "decide");
    for (const [id, sec] of sections) {
      const active = id === sectionId;
      sec.list.hidden = !active;
      sec.read.hidden = !active;
      if (!active) sec.hide();
    }
    const activeSec = sections.get(sectionId);
    if (activeSec) {
      activeSec.show(r.sub, r.query);
      layer.bind(activeSec);
      ctx.setPrimary(activeSec.primary());
    } else {
      layer.bind(void 0);
      ctx.setPrimary(null);
      ctx.setAttached({});
    }
  });
  let summaryAsked = 0;
  let summaryShown = 0;
  let summary = null;
  function loadSummary() {
    const mine = ++summaryAsked;
    void api.get("/summary").then((s) => showSummary(s, mine)).catch(() => {
    });
  }
  function showSummary(s, mine) {
    if (mine < summaryShown) return;
    summaryShown = mine;
    summary = s;
    const counts = s.counts ?? {};
    handle.setCount("decide", counts["all"] ?? 0);
    handle.setCount("review", counts["to-apply"] ?? 0);
    paintStatus();
  }
  function paintStatus() {
    const s = summary;
    if (!s) return;
    paintPushError(s.push_error ?? "");
    const pushing = pushStatus({
      queued: s.offline_queued,
      offline: s.push_offline,
      error: s.push_error ?? ""
    });
    if (pushing) {
      handle.setStatus(pushing.text, { tone: pushing.tone });
      return;
    }
    const synced = s.synced_at ? Date.parse(s.synced_at) : NaN;
    const mins = Number.isFinite(synced) ? Math.max(0, Math.floor((Date.now() - synced) / 6e4)) : null;
    handle.setStatus(
      mins !== null ? `synced ${mins}m ago · ${s.machine}` : s.machine,
      { tone: "muted" }
    );
  }
  setInterval(paintStatus, 15e3);
  if (first) showSummary(first, ++summaryAsked);
  else loadSummary();
  onLiveEvent("index", loadSummary);
  onLiveEvent("push", loadSummary);
  dispatchCurrent();
  if (!walkthroughSeen()) walkthrough.start();
}

// apply.ts
import {
  ApiError as ApiError2,
  createSelection,
  h as h8,
  facts,
  buttons as buttons3,
  card as card2,
  sheet as sheet2
} from "/_kit/kit.js";

// sessions.ts
function folderOf(s) {
  return s.cwd ? s.cwd.split("/").filter(Boolean).pop() ?? "" : "";
}
function sessionTitle(s) {
  return s.name || folderOf(s) || s.harness || s.id;
}
function sessionName(s, source) {
  if (s) return sessionTitle(s);
  const i = source.indexOf(":");
  return i === -1 ? source : source.slice(0, i);
}
function sessionMeta(s) {
  const folder = folderOf(s);
  const parts = s.name && folder ? [folder, s.harness] : [s.harness];
  return parts.filter(Boolean).join(" · ");
}
function pickable(sessions) {
  return sessions.filter((s) => s.eligible).sort((a, b) => {
    const t = sessionTitle(a).localeCompare(sessionTitle(b), void 0, {
      sensitivity: "base"
    });
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
function resolveAttachment(urlSession2, sessions) {
  if (urlSession2) return { id: urlSession2, auto: false };
  const ps = pickable(sessions);
  return ps.length === 1 ? { id: ps[0].id, auto: true } : { id: "", auto: false };
}
function attachedState(id, sessions) {
  if (!id) return "none";
  const s = sessions.find((x) => x.id === id);
  if (!s) return "unknown";
  return s.left ? "left" : "here";
}
function urlSession(href) {
  return new URL(href).searchParams.get("session") ?? "";
}
function urlWithSession(href, session) {
  const u = new URL(href);
  if (session) u.searchParams.set("session", session);
  else u.searchParams.delete("session");
  return u.toString();
}
function lookingLine(l) {
  return l ? `${sessionTitle(l.session)} is looking into it` : "";
}

// decide-math.ts
function kindFromKey(key) {
  const i = key.indexOf(":");
  return i > 0 ? key.slice(0, i) : "";
}
function keyWithoutKind(key) {
  const i = key.indexOf(":");
  return i > 0 ? key.slice(i + 1) : key;
}
function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural ?? singular + "s"}`;
}
function stripOwnKey(subject, key) {
  if (!key) return subject;
  const withSpace = key + " ";
  if (subject.includes(withSpace)) {
    return subject.replace(withSpace, "");
  }
  if (subject.includes(key)) {
    return subject.replace(key, "");
  }
  return subject;
}
var MORE = /* @__PURE__ */ Symbol("more");
function nextInView(order, current, fresh, complete) {
  const live2 = fresh.filter((k) => k !== current);
  const inView = new Set(live2);
  const pos = new Map(order.map((k, i2) => [k, i2]));
  let reached = -1;
  for (const k of live2) reached = Math.max(reached, pos.get(k) ?? -1);
  const i = order.indexOf(current);
  for (const k of i >= 0 ? order.slice(i + 1) : order) {
    if (inView.has(k)) return k;
    if (!complete && (pos.get(k) ?? 0) > reached) return MORE;
  }
  let last = -1;
  live2.forEach((k, j) => {
    if (pos.has(k)) last = j;
  });
  const past = live2.slice(last + 1).find((k) => !pos.has(k));
  if (past) return past;
  if (!complete) return MORE;
  return live2[0] ?? null;
}
function localDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function notNowUntil(form, value, now) {
  if (!form.asks) return form.template;
  let v = value.trim();
  if (form.asks === "days") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + (form.days ?? 0));
    v = localDate(d);
  }
  if (!v) return null;
  return form.template.replace("%s", v);
}
function choicesForKeys(vocab2, keys) {
  const kinds = [...new Set(keys.map(kindFromKey).filter(Boolean))];
  const lists = kinds.map(
    (k) => (vocab2.kinds ?? []).find((v) => v.kind === k)?.choices ?? []
  );
  if (lists.length === 0) return [];
  const out = [];
  for (const first of lists[0]) {
    const same = lists.map(
      (l) => l.find((x) => x.disposition === first.disposition)
    );
    if (same.some((x) => !x)) continue;
    const labels = [...new Set(same.map((x) => x.label))];
    out.push({
      ...first,
      label: labels.join(" / "),
      outward: same.some((x) => x.outward)
    });
  }
  return out;
}
function choiceLabel(vocab2, key, disposition) {
  const d = disposition === "watch" ? "wait" : disposition;
  if (!vocab2) return disposition;
  return choicesForKeys(vocab2, [key]).find((c) => c.disposition === d)?.label ?? disposition;
}
function recommendLine(vocab2, key, source, disposition, ruleName = "") {
  const who = recommendsWho(vocab2, source, ruleName);
  return `${who} ${choiceLabel(vocab2, key, disposition)}`;
}
function recommendsWho(vocab2, source, ruleName = "") {
  if (source.startsWith("rule:"))
    return vocab2.rule_recommends.replaceAll(
      "{rule}",
      ruleName || source.slice(5)
    );
  return vocab2.recommends;
}
var CAME_BACK = "came-back";
function standsLine(vocab2, it, flat) {
  const looking = lookingLine(it.looking);
  if (looking) return { text: looking, tone: "agent" };
  if (it.status === "left-open")
    return { text: leftOpenMeta(it.decision?.decided_at), tone: "muted" };
  const back = it.group === CAME_BACK ? it.due_reason || vocab2?.came_back?.[it.status] : it.new_activity ? it.due_reason : "";
  if (back) return { text: back, tone: "signal" };
  const p = it.proposal?.state === "pending" ? it.proposal : void 0;
  if (!p) return { text: "not recommended yet", tone: "muted" };
  const label = choiceLabel(vocab2, it.key, p.disposition);
  const text = flat ? [label, p.note].filter(Boolean).join(" · ") : p.note || label;
  return { text, tone: "muted" };
}
function decideSummary(groups, total, rules, vocab2) {
  const w = vocab2.summary;
  const n = (t, k) => t.replaceAll("{n}", String(k));
  const lines = [n(w.to_decide, total)];
  const back = groups.find((g) => g.id === CAME_BACK);
  if (back?.total) lines.push(n(w.came_back, back.total));
  for (const g of groups) {
    if (!g.source || !g.total) continue;
    const rule = g.source.startsWith("rule:") ? g.source.slice(5) : "";
    const who = rule ? rules.find((r) => r.rule.id === rule)?.rule.name || rule : sessionName(g.by, g.source);
    lines.push(
      n(w.group, g.total).replaceAll("{who}", who).replaceAll("{decision}", g.label)
    );
  }
  const none = groups.find((g) => g.id === "none");
  if (none?.total) lines.push(n(w.not_recommended, none.total));
  return lines;
}
function countWord(total, ticked, words) {
  if (ticked > 0 && ticked < total)
    return words.some.replaceAll("{n}", String(ticked));
  if (total === 1) return words.one;
  if (total === 2) return words.two;
  return words.all.replaceAll("{n}", String(total));
}
function groupButtons(g, ticked, vocab2) {
  const n = countWord(g.total, ticked, vocab2.count_words);
  const fill = (s) => s.replaceAll("{n}", n);
  return {
    act: fill(g.many || g.label),
    discard: fill(vocab2.discard_many)
  };
}
function lookIntoCard(words, session, key) {
  return {
    label: words.label,
    says: words.says.replaceAll("{session}", session),
    message: words.message.replaceAll("{key}", key)
  };
}
function discardConfirm(vocab2, n, view) {
  const count2 = n === 1 ? vocab2.discard_one : vocab2.discard_some.replaceAll("{n}", String(n));
  return vocab2.discard_confirm.replaceAll("{count}", count2).replaceAll("{view}", view);
}
var PICK_KINDS = {
  pr: ["pr"],
  "pr-or-issue": ["pr", "issue"],
  repo: ["repo"]
};
var NAME = "[\\w.-]+";
var GH_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${NAME})/(${NAME})(?:/(pull|issues)/(\\d+))?(?:[/?#].*)?$`,
  "i"
);
var KIND_KEY = new RegExp(`^(pr|issue):(${NAME})/(${NAME})#(\\d+)$`, "i");
var REPO_KEY = new RegExp(`^(?:repo:)?(${NAME})/(${NAME})$`, "i");
var BARE_KEY = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
function pastedKeys(text, asks) {
  const kinds = PICK_KINDS[asks] ?? [];
  const s = text.trim();
  const repo = (o, r) => `${o}/${r.replace(/\.git$/i, "")}`.toLowerCase();
  const num = (n) => Number(n) > 0 ? Number(n) : null;
  const url = GH_URL.exec(s);
  const kindKey = KIND_KEY.exec(s);
  const repoKey = REPO_KEY.exec(s);
  const bare = BARE_KEY.exec(s);
  let out = [];
  if (url) {
    const [, o, r, part, n] = url;
    if (!part) out = [`repo:${repo(o, r)}`];
    else if (num(n) !== null)
      out = [`${part === "pull" ? "pr" : "issue"}:${repo(o, r)}#${num(n)}`];
  } else if (kindKey) {
    const [, k, o, r, n] = kindKey;
    if (num(n) !== null) out = [`${k.toLowerCase()}:${repo(o, r)}#${num(n)}`];
  } else if (repoKey) {
    out = [`repo:${repo(repoKey[1], repoKey[2])}`];
  } else if (bare) {
    const [, o, r, n] = bare;
    if (num(n) !== null)
      out = ["pr", "issue"].map((k) => `${k}:${repo(o, r)}#${num(n)}`);
  }
  out = out.filter((k) => kinds.includes(kindFromKey(k)));
  return out.length ? out : null;
}
function latestSearch(find, publish, delay, stale) {
  let seq = 0;
  let timer;
  const run = async (my, text) => {
    const found = await find(text);
    if (my !== seq) return;
    publish(text, found);
  };
  return {
    input(text) {
      const my = ++seq;
      stale();
      clearTimeout(timer);
      timer = setTimeout(() => void run(my, text), delay);
    },
    cancel() {
      seq++;
      clearTimeout(timer);
    }
  };
}
function leftOpenMeta(decidedAt, now = /* @__PURE__ */ new Date()) {
  if (!decidedAt) return "left open";
  const d = new Date(decidedAt);
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `left open · ${d.toLocaleDateString("en-US", opts)}`;
}
function navTargets(order, groups, key) {
  const i = order.findIndex((r) => r.key === key);
  if (i < 0) return { pos: 0, total: 0, label: "" };
  const group = order[i].group;
  const firsts = [];
  order.forEach((r, j) => {
    if (j === 0 || order[j - 1].group !== r.group)
      firsts.push({ group: r.group, at: j });
  });
  const g = firsts.findIndex((f) => f.group === group && f.at <= i);
  const start2 = firsts[g].at;
  const gv = groups.find((x) => x.id === group);
  const out = {
    pos: i - start2 + 1,
    total: gv?.total ?? order.filter((r) => r.group === group).length,
    label: gv?.label ?? ""
  };
  if (i > 0) out.prev = order[i - 1].key;
  if (i + 1 < order.length) out.next = order[i + 1].key;
  if (g > 0) out.prevGroup = order[firsts[g - 1].at].key;
  if (g + 1 < firsts.length) out.nextGroup = order[firsts[g + 1].at].key;
  return out;
}
function shortKey(key) {
  const k = keyWithoutKind(key);
  const i = k.indexOf("/");
  return i >= 0 ? k.slice(i + 1) : k;
}
function decideRoute(pending, d, until) {
  if (!pending) return { path: "decide" };
  const same = pending.disposition === d && (until ?? "") === (pending.until ?? "");
  return { path: same ? "accept" : "change", id: pending.id };
}
function doneWords(vocab2, d, of) {
  if ("key" in of) {
    const kind = kindFromKey(of.key);
    const c = (vocab2.kinds ?? []).find((k) => k.kind === kind)?.choices?.find((c2) => c2.disposition === d);
    return c?.done ?? "";
  }
  for (const k of vocab2.kinds ?? [])
    for (const c of k.choices ?? [])
      if (c.disposition === d && c.label === of.label)
        return c.done_many.replaceAll(
          "{n}",
          countWord(of.total, of.ticked, vocab2.count_words)
        );
  return "";
}
function waitingStrip(w, done) {
  const parts = [];
  for (const piece of w.text.split(/(\{apply\}|\{undo\})/)) {
    if (piece === "{apply}") parts.push({ link: w.apply });
    else if (piece === "{undo}") parts.push({ button: w.undo });
    else if (piece) parts.push(piece.replaceAll("{done}", done));
  }
  return parts;
}
function applyGroupLink(disposition, key) {
  const kind = key.slice(0, key.indexOf(":"));
  return `#/review?group=${encodeURIComponent(`${disposition}|${kind}`)}`;
}

// decide.ts
import { sheet, h as h3, noteField as noteField2 } from "/_kit/kit.js";

// choices.ts
import { h as h2, noteField, buttons } from "/_kit/kit.js";
var CLOSE = "close";
var COMMENT_PLACEHOLDER = "closing comment, posted when you approve the plan";
var CLOSE_WITH = "close with this comment";
var CLOSE_WITHOUT = "close without comment";
function asNotNow(d) {
  return d === "watch" ? "wait" : d;
}
var PICK_EXAMPLE = {
  pr: "tackle#58, a title, or https://github.com/owner/repo/pull/58",
  "pr-or-issue": "tackle#58, a title, or https://github.com/owner/repo/pull/58",
  repo: "tackle, a name, or https://github.com/owner/repo"
};
function showChoiceError(root, message5) {
  const err = root.querySelector(".cb-choice-err");
  if (!err) return;
  err.textContent = message5;
  err.hidden = !message5;
}
function renderChoices(ctx, kind, opts) {
  const grid = h2("div", { class: "cb-choices" });
  const notNow = h2("div", { class: "cb-notnow", hidden: true });
  const comment = opts.keys ? null : closeComment();
  const err = h2("p", { class: "cb-choice-err", hidden: true });
  const root = h2(
    "div",
    { class: "cb-choices-wrap" },
    grid,
    notNow,
    comment?.el ?? null,
    err
  );
  void getVocab(ctx).then((vocab2) => {
    const choices2 = opts.keys ? choicesForKeys(vocab2, opts.keys) : (vocab2.kinds ?? []).find((k) => k.kind === kind)?.choices ?? [];
    const rec = asNotNow(opts.recommended);
    const cards = choices2.map(
      (c, i) => choiceCard(c, i + 1, c.disposition === rec)
    );
    grid.append(...cards);
    grid.dataset.cards = String(cards.length);
    if (opts.chosen) mark(asNotNow(opts.chosen));
    opts.onCards?.(grid);
    notNow.append(...notNowPicker(vocab2.not_now ?? []));
  });
  function mark(d) {
    for (const card6 of grid.querySelectorAll(
      ".cb-choice[data-d]"
    )) {
      card6.classList.toggle("on", card6.dataset.d === d);
      const k = card6.querySelector(".cb-choice-mark");
      if (k) k.textContent = markText(card6);
    }
  }
  function markText(card6) {
    const parts = [];
    if (card6.classList.contains("rec")) parts.push("recommended");
    if (card6.classList.contains("on")) parts.push("chosen");
    return parts.join(" · ");
  }
  function choiceCard(c, n, rec) {
    const card6 = h2(
      "button",
      {
        type: "button",
        class: "kit-btn cb-choice" + (rec ? " rec" : "") + (c.disposition === "delete" ? " danger" : ""),
        title: c.says,
        dataset: { d: c.disposition, n: String(n) },
        onclick() {
          showChoiceError(root, "");
          mark(c.disposition);
          if (c.needs_until) {
            comment?.close();
            notNow.hidden = false;
            return;
          }
          notNow.hidden = true;
          if (comment && c.disposition === CLOSE) {
            comment.open();
            return;
          }
          comment?.close();
          opts.onPick(c.disposition);
        }
      },
      h2("span", { class: "cb-choice-mark" }),
      h2("span", { class: "cb-choice-label" }, c.label)
    );
    const k = card6.querySelector(".cb-choice-mark");
    if (k) k.textContent = markText(card6);
    return card6;
  }
  function closeComment() {
    const field = noteField({
      value: "",
      placeholder: COMMENT_PLACEHOLDER,
      // The buttons read the field as typed; a blur's commit decides nothing.
      onCommit() {
      }
    });
    field.setAttribute("aria-label", "closing comment");
    const decide = (note) => opts.onPick(CLOSE, void 0, note.trim());
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) decide(field.value);
    });
    const el2 = h2(
      "div",
      { class: "cb-close-comment", hidden: true },
      field,
      buttons([
        { label: CLOSE_WITH, fill: true, run: () => decide(field.value) },
        { label: CLOSE_WITHOUT, run: () => decide("") }
      ])
    );
    const onEsc = (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!el2.isConnected || el2.hidden) {
        document.removeEventListener("keydown", onEsc, true);
        return;
      }
      const t = e.target;
      if (t !== field && t instanceof HTMLElement && (t.isContentEditable || t.matches("input, textarea, select")))
        return;
      e.preventDefault();
      e.stopPropagation();
      close();
      mark(asNotNow(opts.chosen));
    };
    function close() {
      if (document.activeElement === field) field.blur();
      el2.hidden = true;
      document.removeEventListener("keydown", onEsc, true);
    }
    function open() {
      field.value = opts.chosen === CLOSE ? opts.note ?? "" : "";
      el2.hidden = false;
      document.addEventListener("keydown", onEsc, true);
      field.focus({ preventScroll: true });
    }
    return { el: el2, open, close };
  }
  function notNowPicker(forms) {
    const input = h2("input", { class: "cb-sheet-input" });
    let form = null;
    const searching = () => !!form && form.asks in PICK_KINDS;
    const commit = () => {
      if (!form) return;
      const until = notNowUntil(form, input.value, /* @__PURE__ */ new Date());
      if (until) opts.onPick("wait", until);
    };
    const choose = (key) => {
      if (form) opts.onPick("wait", form.template.replace("%s", key));
    };
    const options = h2("div", {
      class: "cb-pick-opts",
      role: "listbox",
      hidden: true
    });
    const example = h2("p", { class: "cb-pick-eg", hidden: true });
    const show = (found) => {
      options.replaceChildren(
        ...found.map(
          (o) => h2(
            "button",
            {
              type: "button",
              class: "cb-pick-opt",
              role: "option",
              dataset: { key: o.key },
              onclick: () => choose(o.key)
            },
            o.says
          )
        )
      );
      options.hidden = found.length === 0;
    };
    const search = latestSearch(
      async (text) => text ? pick(form?.asks ?? "", text) : [],
      (text, found) => {
        show(found);
        input.dataset.searched = text;
      },
      150,
      // What is shown is for older text: it can't be chosen until the
      // answer for this text is in.
      () => {
        for (const b of options.querySelectorAll(
          ".cb-pick-opt"
        ))
          b.disabled = true;
      }
    );
    input.addEventListener("input", () => {
      if (!searching()) return;
      delete input.dataset.searched;
      search.input(input.value.trim());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!searching()) {
        commit();
        return;
      }
      const first = options.querySelector(
        ".cb-pick-opt:not(:disabled)"
      );
      if (input.dataset.searched === input.value.trim() && first) first.click();
    });
    input.addEventListener("change", () => {
      if (input.type === "date") commit();
    });
    const set = h2(
      "button",
      { type: "button", class: "kit-btn", onclick: commit },
      "set"
    );
    const field = h2(
      "div",
      { class: "cb-notnow-field", hidden: true },
      h2("div", { class: "cb-pick" }, input, example, options),
      set
    );
    const chips = h2(
      "div",
      { class: "kit-chips cb-notnow-chips" },
      forms.map(
        (f) => h2(
          "button",
          {
            type: "button",
            class: "kit-chip",
            dataset: { id: f.id },
            onclick(e) {
              showChoiceError(root, "");
              for (const c of chips.querySelectorAll(".kit-chip"))
                c.classList.toggle("on", c === e.currentTarget);
              form = f;
              if (!f.asks || f.asks === "days") {
                field.hidden = true;
                commit();
                return;
              }
              search.cancel();
              show([]);
              delete input.dataset.searched;
              input.type = f.asks === "date" ? "date" : "text";
              input.value = "";
              example.textContent = PICK_EXAMPLE[f.asks] ?? "";
              example.hidden = !searching();
              set.hidden = searching();
              field.hidden = false;
              input.focus();
            }
          },
          f.label
        )
      )
    );
    return [chips, field];
  }
  async function pick(asks, text) {
    const kinds = PICK_KINDS[asks] ?? [];
    const tracked = async (kind2, q, limit) => (await ctx.api.get("/items", {
      view: "tracked",
      kind: kind2,
      q,
      limit: String(limit)
    }).catch(() => ({ items: [] }))).items ?? [];
    const says = (key, title) => ({
      key,
      says: title ? `${key} · ${title}` : key
    });
    const pasted = pastedKeys(text, asks);
    if (pasted) {
      const hits = (await Promise.all(
        pasted.map(
          async (key) => (await tracked(kindFromKey(key), key, 5)).find((it) => it.key === key)
        )
      )).filter((it) => !!it);
      if (hits.length) return hits.map((it) => says(it.key, it.title));
      return pasted.map((key) => ({
        key,
        says: `${key} · not tracked; checked on the next sync`
      }));
    }
    const lists = await Promise.all(kinds.map((k) => tracked(k, text, 8)));
    return lists.flat().map((it) => says(it.key, it.title));
  }
  return root;
}

// decide.ts
var _vocab = null;
async function getVocab(ctx) {
  if (_vocab !== null) return _vocab;
  _vocab = await ctx.api.get("/decisions/vocabulary");
  return _vocab;
}
var DANGER_DISPS = /* @__PURE__ */ new Set(["close", "delete", "archive"]);

// apply-text.ts
function runOrder(jobs) {
  const out = { running: [], done: [] };
  for (const j of [...jobs].sort((a, b) => b.id - a.id)) {
    if (j.state === "planned" || j.state === "cancelled") continue;
    if (FINISHED_JOB.has(j.state)) out.done.push(j);
    else out.running.push(j);
  }
  return out;
}
var FINISHED_JOB = /* @__PURE__ */ new Set(["done", "failed", "cancelled"]);
function isRunning(job) {
  return job.state !== "planned" && !FINISHED_JOB.has(job.state);
}
function isFinished(job) {
  return FINISHED_JOB.has(job.state);
}
function applyLabel(many, noun, nouns, n) {
  return many.replace("{n}", `${n} ${n === 1 ? noun : nouns}`);
}
var TITLES = {
  "branch-delete-local": "Delete local branches",
  "branch-delete-remote": "Delete remote branches",
  "worktree-remove": "Remove worktrees",
  "repo-archive": "Archive repos",
  "repo-delete": "Delete repos",
  "pr-close": "Close PRs",
  "pr-merge": "Merge PRs",
  "issue-close": "Close issues"
};
function actionTitle(action) {
  return TITLES[action] ?? action;
}
function planTitle(job, nouns) {
  const parts = groupSteps(job.steps ?? []).map((g) => {
    const n = new Set(g.steps.map((s) => s.key)).size;
    const kind = g.steps[0]?.key.slice(0, g.steps[0].key.indexOf(":")) ?? "";
    const [one, many] = nouns(kind);
    const words = actionTitle(g.action).split(" ");
    const mid = words.slice(1, -1);
    return [words[0], String(n), ...mid, n === 1 ? one : many].join(" ");
  });
  if (!parts.length) return `job #${job.id}`;
  return parts.map((t, i) => i ? t.charAt(0).toLowerCase() + t.slice(1) : t).join(", ");
}
var PAST = {
  "branch-delete-local": "deleted",
  "branch-delete-remote": "deleted on the remote",
  "worktree-remove": "removed",
  "repo-archive": "archived",
  "repo-delete": "deleted",
  "pr-close": "closed",
  "pr-merge": "merged",
  "issue-close": "closed"
};
var VERB = {
  "branch-delete-local": "delete",
  "branch-delete-remote": "delete",
  "worktree-remove": "remove",
  "repo-archive": "archive",
  "repo-delete": "delete",
  "pr-close": "close",
  "pr-merge": "merge",
  "issue-close": "close"
};
function actionVerb(action) {
  return VERB[action] ?? "run";
}
function laneLabel(lane, agent) {
  return lane === "agent" ? `${agent || "agent"} · outward` : "casebook · local";
}
function groupSteps(steps) {
  const out = [];
  const at2 = /* @__PURE__ */ new Map();
  for (const s of steps) {
    const k = `${s.action}\0${s.lane}`;
    const i = at2.get(k);
    if (i === void 0) {
      at2.set(k, out.length);
      out.push({
        action: s.action,
        lane: s.lane,
        undo: s.undo_note ?? "",
        steps: [s]
      });
    } else out[i].steps.push(s);
  }
  return out;
}
function jobTitle(job) {
  const titles = [
    ...new Set(groupSteps(job.steps ?? []).map((g) => actionTitle(g.action)))
  ];
  if (!titles.length) return `job #${job.id}`;
  return titles.map((t, i) => i ? t.charAt(0).toLowerCase() + t.slice(1) : t).join(", ");
}
function jobLanes(job) {
  const have = new Set((job.steps ?? []).map((s) => s.lane));
  return ["casebook", "agent"].filter((l) => have.has(l));
}
var FINISHED = /* @__PURE__ */ new Set(["verified", "reported", "skipped", "failed"]);
function progress(job) {
  const p = {
    total: 0,
    finished: 0,
    byLane: {},
    verified: 0,
    paused: 0,
    skipped: 0,
    failed: 0,
    started: job.state === "running"
  };
  for (const s of job.steps ?? []) {
    p.total++;
    if (s.state !== "pending") p.started = true;
    if (FINISHED.has(s.state)) {
      p.finished++;
      p.byLane[s.lane] = (p.byLane[s.lane] ?? 0) + 1;
    }
    if (s.state === "verified") p.verified++;
    if (s.state === "paused") p.paused++;
    if (s.state === "skipped") p.skipped++;
    if (s.state === "failed") p.failed++;
  }
  return p;
}
function needsLine(needsYou, paused) {
  const parts = [];
  if (needsYou)
    parts.push(`${needsYou} ${needsYou === 1 ? "needs" : "need"} you`);
  if (paused) parts.push(`${paused} paused`);
  return parts.join(" · ");
}
function openCardsByJob(cards) {
  const m = /* @__PURE__ */ new Map();
  for (const c of cards) {
    if (c.state !== "open") continue;
    m.set(c.job_id, (m.get(c.job_id) ?? 0) + 1);
  }
  return m;
}
function stepMark(s, next) {
  const past = PAST[s.action] ?? "done";
  const why = (glyph, text, tone) => s.detail ? { glyph, text, why: s.detail, tone } : { glyph, text, tone };
  if (s.undone_at) return { glyph: "↺", text: "undone", tone: "muted" };
  switch (s.state) {
    case "verified":
      return { glyph: "✓", text: `${past} · verified`, tone: "ok" };
    case "reported":
      return {
        glyph: "✓",
        text: `${past} · reported`,
        tone: "muted"
      };
    case "running":
      return {
        glyph: "▸",
        text: "running",
        tone: s.lane === "agent" ? "agent" : "signal"
      };
    case "paused":
      return why("‖", "paused", "agent");
    case "needs_you":
      return { glyph: "!", text: "needs you", tone: "signal" };
    case "failed":
      return why("✗", "failed", "signal");
    case "skipped":
      return why("–", "skipped", "muted");
    default:
      return { glyph: "·", text: next ? "next" : "queued", tone: "wait" };
  }
}
function nextSteps(steps) {
  const out = /* @__PURE__ */ new Set();
  const seen2 = /* @__PURE__ */ new Set();
  for (const s of steps) {
    if (s.state !== "pending" || seen2.has(s.lane)) continue;
    seen2.add(s.lane);
    out.add(s.id);
  }
  return out;
}
function needsSession(steps) {
  return steps.some((s) => s.lane === "agent");
}
function makeSeq() {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (n) => n === latest
  };
}
function startedKeys(jobs) {
  const m = /* @__PURE__ */ new Map();
  for (const j of jobs) {
    if (!STARTED.has(j.state)) continue;
    for (const s of j.steps ?? []) {
      const was = m.get(s.key);
      if (was === void 0 || j.id > was) m.set(s.key, j.id);
    }
  }
  return m;
}
var STARTED = /* @__PURE__ */ new Set(["approved", "running", "paused"]);
function runsThrough(steps, agent) {
  if (!needsSession(steps)) return { text: "", can: true };
  if (agent === null)
    return { text: "Open casebook from an agent to run this.", can: false };
  return { text: `runs through ${agent || "agent"}`, can: true };
}
function ageText(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h17 = Math.floor(m / 60);
  if (h17 < 24) return `${h17}h`;
  return `${Math.floor(h17 / 24)}d`;
}
function observations(builtAt, intervalMs, now) {
  const age = now - builtAt;
  if (!intervalMs || age <= intervalMs)
    return { text: "observations fresh", stale: false };
  return { text: `observations ${ageText(age)} old`, stale: true };
}
var STEP_DISPOSITION = {
  "branch-delete-local": "delete",
  "branch-delete-remote": "delete",
  "worktree-remove": "delete",
  "repo-archive": "archive",
  "repo-delete": "delete",
  "pr-close": "close",
  "pr-merge": "merge",
  "issue-close": "close"
};
function stepGroup(s) {
  return `${STEP_DISPOSITION[s.action] ?? ""}|${s.key.slice(0, s.key.indexOf(":"))}`;
}
function heldOutside(jobs, id, loaded) {
  const held = /* @__PURE__ */ new Set();
  for (const j of jobs) {
    if (!STARTED.has(j.state)) continue;
    for (const s of j.steps ?? [])
      if (!loaded.has(s.key) && stepGroup(s) === id) held.add(s.key);
  }
  return held.size;
}
var ACTION_TAGS = {
  "repo-delete": ["permanent"],
  "pr-merge": ["permanent"],
  "pr-close": ["github-undo"],
  "issue-close": ["github-undo"],
  "repo-archive": ["github-undo"]
};
function actionTags(action) {
  return ACTION_TAGS[action] ?? [];
}
function stepTags(steps) {
  const n = {
    permanent: 0,
    posts: 0,
    "github-undo": 0
  };
  for (const s of steps) {
    for (const k of actionTags(s.action)) n[k]++;
    if (s.posts) n.posts++;
  }
  return ["permanent", "posts", "github-undo"].filter((k) => n[k] > 0).map((kind) => ({ kind, n: n[kind] }));
}
function tagText(t, of) {
  const counted = of === 0 || t.n < of;
  const lead = counted ? `${count(t.n)} ` : "";
  switch (t.kind) {
    case "permanent":
      return `${lead}can't be undone`;
    case "github-undo":
      return `${lead}undo on GitHub`;
    case "posts":
      return `${lead}${counted && t.n > 1 ? "post" : "posts"} a public comment`;
  }
}
function publicLine(s) {
  return `posts publicly${s.public ? " on a public repo" : ""}: “${s.comment ?? ""}”`;
}
function count(n) {
  return n.toLocaleString("en-US");
}
function runsNow(plan) {
  const steps = plan.steps ?? [];
  const by = (a) => steps.filter((s) => s.action === a).length;
  const agent = steps.filter((s) => s.lane === "agent").length;
  const wt = by("worktree-remove");
  const remote = by("branch-delete-remote");
  const local = by("branch-delete-local");
  let first;
  if (steps.length && agent === steps.length) {
    first = `${pluralize(steps.length, "step")} · all on GitHub, through the agent.`;
  } else if (!steps.length) {
    first = "Nothing runs now.";
  } else {
    const parts = [];
    if (wt)
      parts.push(
        `${count(wt)} ${wt === 1 ? "worktree" : "worktrees"} removed${remote + local ? " first" : ""}`
      );
    if (remote) parts.push(`${count(remote)} deleted on GitHub`);
    if (local) parts.push(`${count(local)} deleted here`);
    if (agent) parts.push(`${count(agent)} on GitHub, through the agent`);
    first = `Runs now: ${parts.join(", ")}.`;
  }
  const rest = [];
  const waits = /* @__PURE__ */ new Map();
  for (const w of plan.waiting ?? [])
    waits.set(w.machine, (waits.get(w.machine) ?? 0) + 1);
  for (const [m, n] of waits)
    rest.push(
      `Waits for ${m}: ${count(n)} ${n === 1 ? "local copy" : "local copies"}.`
    );
  const held = plan.held_back?.length ?? 0;
  if (held) rest.push(`Held: ${count(held)}.`);
  return rest.length ? `${first}
${rest.join(" ")}` : first;
}
function reviewKick(n, groups) {
  const where = groups.length === 1 ? groups[0] : `${groups.length} groups`;
  return `review · ${n} ticked in ${where}`;
}
function reviewLine(it, done) {
  const d = it.decision?.disposition ?? "";
  const hold = (it.holds ?? []).find((x) => (x.stops ?? []).includes(d));
  if (hold) return { text: `held: ${hold.text}`, tone: "agent" };
  if (it.kind === "branch") {
    const there = (it.copies ?? []).filter((c) => !c.absent);
    const gh = there.some((c) => !c.machine);
    const here = there.some((c) => !!c.machine);
    if (gh || here)
      return {
        text: `deleted ${[gh ? "on GitHub" : "", here ? "here" : ""].filter(Boolean).join(" and ")}`,
        tone: "muted"
      };
  }
  return { text: done.toLowerCase(), tone: "muted" };
}
function untickHidden(ticked, shown) {
  return ticked.filter((k) => !shown.has(k));
}
function waitBlocks(waits, steps) {
  const github = new Set(
    steps.filter((s) => s.action === "branch-delete-remote").map((s) => s.key)
  );
  const out = [];
  for (const w of waits) {
    const m = w.machine;
    let text;
    if (w.key.startsWith("worktree:"))
      text = `They are only on ${m}. They are removed from review the next time casebook runs there.`;
    else if (github.has(w.key))
      text = `Their local copies are only on ${m}; their GitHub copies are deleted above. They run from review the next time casebook runs there.`;
    else
      text = `Their local copies are only on ${m}. They run from review the next time casebook runs there.`;
    const block = out.find((b) => b.text === text);
    if (block) block.waits.push(w);
    else out.push({ text, waits: [w] });
  }
  return out;
}
var heldText = "Not run here. Each says what holds it; settle that and it joins the next run.";
function otherHalf(key, steps) {
  return steps.some((s) => s.key === key) ? " · its other half runs above" : "";
}

// coalesce.ts
function coalesced(load) {
  let running = null;
  let queued = null;
  function call() {
    if (!running) {
      running = load().finally(() => {
        running = null;
      });
      return running;
    }
    if (!queued) {
      queued = running.catch(() => {
      }).then(() => {
        queued = null;
        return call();
      });
    }
    return queued;
  }
  return call;
}

// list-pane.ts
import { list, h as h6 } from "/_kit/kit.js";

// filters.ts
import { h as h5, ApiError, buttons as buttons2, card } from "/_kit/kit.js";

// conditions.ts
import { h as h4 } from "/_kit/kit.js";

// rules-text.ts
function trackRecord(r) {
  const parts = [];
  if (r.accepted) parts.push(`${r.accepted} accepted`);
  if (r.decided_differently)
    parts.push(`${r.decided_differently} decided differently`);
  if (r.rejected) parts.push(`${r.rejected} rejected`);
  if (r.pending) parts.push(`${r.pending} pending`);
  return parts.join(" · ");
}
function authorOf(createdBy) {
  const i = createdBy.indexOf(":");
  if (i > 0) return { agent: true, name: createdBy.slice(0, i) };
  if (createdBy === "casebook") return { agent: false, name: "casebook" };
  return { agent: false, name: "you" };
}
function reasonSummary(by) {
  const rs = by ?? [];
  if (rs.length === 1 && rs[0].reason === "matched") return "";
  return rs.map((r) => `${r.count} ${r.reason.toLowerCase()}`).join(" · ");
}
function matchesHeading(total, by) {
  const why = reasonSummary(by);
  return `matches now · ${total}` + (why ? ` · ${why}` : "");
}
function conditionErrorIndex(message5) {
  const m = /^condition (\d+): /.exec(message5);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n - 1 : -1;
}
function orList(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function fieldLabel(f) {
  return f.label || f.name;
}
function opLabel(ops, op) {
  return ops.find((o) => o.name === op)?.label || op;
}
function valueLabel(f, v) {
  return f?.value_labels?.[v] || v;
}
function conditionText(c, fields, ops) {
  const f = fields.find((x) => x.name === c.field);
  const name = f ? fieldLabel(f) : c.field;
  if (c.op === "in" || c.op === "not-in") {
    const { values } = pickedValues(c);
    const words = orList(values.map((v) => valueLabel(f, v)));
    return `${name} ${opLabel(ops, c.op === "in" ? "is" : "is-not")} ${words}`;
  }
  return `${name} ${opLabel(ops, c.op)} ${valueLabel(f, c.value)}`;
}
function pickedValues(c) {
  const not = c.op === "is-not" || c.op === "not-in";
  const values = c.op === "in" || c.op === "not-in" ? c.value.split(",").map((v) => v.trim()).filter((v) => v !== "") : c.value === "" ? [] : [c.value];
  return { not, values };
}
function pickedCondition(field, not, values) {
  if (values.length > 1) {
    return { field, op: not ? "not-in" : "in", value: values.join(",") };
  }
  return { field, op: not ? "is-not" : "is", value: values[0] ?? "" };
}
function typesOf(conds, all) {
  const c = conds.find((x) => x.field === "kind");
  if (!c) return null;
  const { not, values } = pickedValues(c);
  return all.filter((k) => values.includes(k) !== not);
}
function fieldApplies(f, types) {
  const ks = f.kinds ?? [];
  if (!types || ks.length === 0) return true;
  return types.every((t) => ks.includes(t));
}
function fieldTypes(f, kind) {
  return (f.kinds ?? []).map((k) => valueLabel(kind, k)).join(", ");
}
function fieldFound(f, q) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return fieldLabel(f).toLowerCase().includes(s) || (f.help ?? "").toLowerCase().includes(s);
}

// conditions.ts
var ENUM = 0;
var DURATION = 2;
var BOOL = 3;
var COUNT = 4;
var vocab = null;
var errors = /* @__PURE__ */ new WeakMap();
function ruleVocabularyView(ctx) {
  if (!vocab) {
    vocab = ctx.api.get("/rules/vocabulary");
    vocab.catch(() => {
      vocab = null;
    });
  }
  return vocab;
}
function ruleVocabulary(ctx) {
  return ruleVocabularyView(ctx).then((v) => v.fields ?? []);
}
function ruleOperators(ctx) {
  return ruleVocabularyView(ctx).then((v) => v.operators ?? []);
}
function picks(f) {
  return f.type === BOOL || f.type === ENUM && (f.values?.length ?? 0) > 0;
}
function choices(f) {
  return f.type === BOOL ? ["true", "false"] : f.values ?? [];
}
function durationWords(op, v) {
  const m = /^(\d+)([hdw])$/.exec(v.trim());
  if (!m) return v;
  const n = Number(m[1]);
  const unit = { h: "hour", d: "day", w: "week" }[m[2]];
  const words = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return op === "older-than" ? `${words} ago` : words;
}
var TYPED = /* @__PURE__ */ new Set(["repo", "owner", "author", "label"]);
function typed(f) {
  return TYPED.has(f.name);
}
var NOUNS = {
  repo: "repositories",
  owner: "owners",
  author: "authors",
  label: "labels"
};
function globRe(p) {
  const body = p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${body}$`);
}
function patternSuggestions(field, all, typedQ) {
  const out = [];
  const sum = (xs) => xs.reduce((n, x) => n + x.count, 0);
  if (typedQ.includes("*")) {
    const re = globRe(typedQ);
    const m = all.filter((x) => re.test(x.value));
    out.push({ value: typedQ, count: sum(m), hint: `${m.length} match` });
    return out;
  }
  if (field !== "repo" || !typedQ) return out;
  const q = typedQ.toLowerCase();
  const by = (part) => {
    const g = /* @__PURE__ */ new Map();
    for (const x of all) {
      const k = x.value.split("/")[part] ?? "";
      const xs = g.get(k) ?? [];
      xs.push(x);
      g.set(k, xs);
    }
    return g;
  };
  for (const [owner, xs] of by(0)) {
    if (xs.length > 1 && owner.toLowerCase().includes(q))
      out.push({
        value: `${owner}/*`,
        count: sum(xs),
        hint: `all ${xs.length} repos`
      });
  }
  for (const [name, xs] of by(1)) {
    if (xs.length > 1 && name.toLowerCase().includes(q))
      out.push({
        value: `*/${name}`,
        count: sum(xs),
        hint: `under ${xs.length} owners`
      });
  }
  return out.sort((a, b) => b.count - a.count);
}
var seen = /* @__PURE__ */ new Map();
function seenValues(ctx, field) {
  let p = seen.get(field);
  if (!p) {
    p = ctx.api.get(`/rules/values?field=${encodeURIComponent(field)}`).then((v) => v.values ?? []).catch(() => []);
    seen.set(field, p);
  }
  return p;
}
function shownOps(f) {
  if (f.type === BOOL) return ["is"];
  if (picks(f) || typed(f)) return ["is", "is-not"];
  return (f.ops ?? []).filter((o) => o !== "in" && o !== "not-in");
}
function placeholder(f, op) {
  if (f.type === DURATION) return "<n>h, <n>d or <n>w";
  if (f.type === COUNT) return "a count, e.g. 0";
  if (op === "matches") return "a regular expression";
  return /e\.g\. ([^\s,;]+)/.exec(f.help ?? "")?.[1] ?? "";
}
function newCondition(f) {
  const op = shownOps(f)[0] ?? f.ops?.[0] ?? "is";
  const first = picks(f) && f.type !== ENUM ? choices(f)[0] ?? "" : "";
  return { field: f.name, op, value: first };
}
function select(cls, label, options, labelOf, value, onPick) {
  const el2 = h4(
    "select",
    { class: cls, "aria-label": label },
    ...options.map((o) => h4("option", { value: o }, labelOf(o)))
  );
  if (!options.includes(value)) {
    el2.prepend(h4("option", { value }, labelOf(value)));
  }
  el2.value = value;
  el2.addEventListener("change", () => onPick(el2.value));
  return el2;
}
function conditionEditor(ctx, rule, onChange) {
  const editable = rule.editable ?? rule.status === "draft";
  const conds = (rule.match ?? []).map((c) => ({ ...c }));
  let fields = [];
  let ops = [];
  const fieldOf = (name) => fields.find((f) => f.name === name);
  const el2 = h4("div", {
    class: "kit-table cb-conds",
    "data-testid": "conditions"
  });
  const rowsEl = h4("div", { class: "cb-cond-rows" });
  const general = h4("div", { class: "cb-cond-err", hidden: true });
  el2.append(rowsEl, general);
  const changed = () => {
    if (editable && fields.length) fillMenu();
    onChange(conds.map((c) => ({ ...c })));
  };
  function pickControl(c, f) {
    const multi = f.type === ENUM;
    const wrap = h4("div", {
      class: "cb-cond-v cb-cond-picks",
      role: "group",
      "aria-label": `${fieldLabel(f)} value`,
      "data-value": c.value
    });
    const paint = () => {
      const { values } = pickedValues(c);
      wrap.dataset.value = c.value;
      for (const b of wrap.querySelectorAll(".cb-cond-pick")) {
        const on = values.includes(b.dataset.value ?? "");
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    for (const v of choices(f)) {
      wrap.append(
        h4(
          "button",
          {
            type: "button",
            class: "kit-chip cb-cond-pick",
            "data-value": v,
            onclick() {
              const { not, values } = pickedValues(c);
              if (multi) {
                const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
                Object.assign(c, pickedCondition(c.field, not, next));
              } else {
                c.value = v;
              }
              paint();
              changed();
            }
          },
          valueLabel(f, v)
        )
      );
    }
    paint();
    return wrap;
  }
  function valueControl(i, f) {
    const c = conds[i];
    if (!editable || !f) {
      const shown = c.op === "in" || c.op === "not-in" ? pickedValues(c).values.map((v) => valueLabel(f, v)).join(" or ") : f?.type === DURATION ? durationWords(c.op, c.value) : valueLabel(f, c.value);
      return h4("span", { class: "cb-cond-v", "data-value": c.value }, shown);
    }
    if (picks(f)) return pickControl(c, f);
    if (typed(f)) return typedControl(c, f);
    if (f.type === DURATION) return durationControl(c);
    const input = h4("input", {
      class: "cb-cond-v",
      type: "text",
      value: c.value,
      placeholder: placeholder(f, c.op),
      spellcheck: false,
      "aria-label": `${fieldLabel(f)} value`
    });
    input.addEventListener("input", () => {
      c.value = input.value;
      changed();
    });
    return input;
  }
  function typedControl(c, f) {
    const chips = h4("span", { class: "cb-cond-typed-chips" });
    const input = h4("input", {
      class: "cb-cond-typed-in",
      type: "text",
      placeholder: "search or type",
      spellcheck: false,
      autocomplete: "off",
      "aria-label": `${fieldLabel(f)} value`
    });
    const list2 = h4("div", {
      class: "cb-cond-sugg",
      hidden: true,
      role: "listbox"
    });
    const wrap = h4(
      "div",
      { class: "cb-cond-v cb-cond-typed", "data-value": c.value },
      chips,
      h4("span", { class: "cb-cond-typed-box" }, input, list2)
    );
    let at2 = 0;
    let shown = [];
    const values = () => pickedValues(c);
    const set = (next) => {
      Object.assign(c, pickedCondition(c.field, values().not, next));
      wrap.dataset.value = c.value;
      paint();
      changed();
    };
    const add2 = (v) => {
      const t = v.trim();
      if (!t || values().values.includes(t)) return;
      set([...values().values, t]);
      input.value = "";
      void suggest();
    };
    function paint() {
      chips.replaceChildren(
        ...values().values.map(
          (v) => h4(
            "span",
            {
              class: "kit-chip cb-cond-pick on cb-cond-typed-chip",
              "data-value": v
            },
            v,
            h4(
              "button",
              {
                type: "button",
                class: "cb-cond-typed-x",
                "aria-label": `remove ${v}`,
                onclick() {
                  set(values().values.filter((x) => x !== v));
                }
              },
              "×"
            )
          )
        )
      );
    }
    function mark() {
      list2.querySelectorAll(".cb-cond-sugg-row").forEach((r, i) => {
        r.classList.toggle("on", i === at2);
      });
    }
    const option = (value, count2, hint, pat) => h4(
      "div",
      {
        class: pat ? "cb-cond-sugg-row cb-cond-sugg-pat" : "cb-cond-sugg-row",
        role: "option",
        "data-value": value,
        onpointerdown(e) {
          e.preventDefault();
        },
        onclick() {
          add2(value);
        }
      },
      h4(
        "span",
        { class: "cb-cond-sugg-v" },
        value,
        hint ? h4("span", { class: "cb-cond-sugg-hint" }, ` · ${hint}`) : null
      ),
      h4("span", { class: "cb-cond-sugg-n" }, String(count2))
    );
    async function suggest() {
      const typedQ = input.value.trim();
      const q = typedQ.toLowerCase();
      const have = new Set(values().values);
      const all = await seenValues(ctx, f.name);
      const re = typedQ.includes("*") ? globRe(typedQ) : null;
      const hits = all.filter(
        (x) => !have.has(x.value) && (re ? re.test(x.value) : !q || x.value.toLowerCase().includes(q))
      );
      const pats = patternSuggestions(f.name, all, typedQ).filter(
        (p) => !have.has(p.value)
      );
      shown = [...pats.map((p) => p.value), ...hits.map((x) => x.value)];
      at2 = 0;
      const noun = NOUNS[f.name] ?? "values";
      list2.replaceChildren(
        h4(
          "div",
          { class: "cb-cond-sugg-head" },
          `${hits.length} ${noun}${q ? ` matching “${typedQ}”` : ""}`
        ),
        ...pats.map((p) => option(p.value, p.count, p.hint, true)),
        ...hits.map((x) => option(x.value, x.count, "", false))
      );
      list2.hidden = document.activeElement !== input || shown.length === 0;
      mark();
    }
    input.addEventListener("focus", () => void suggest());
    input.addEventListener("input", () => void suggest());
    input.addEventListener("blur", () => {
      list2.hidden = true;
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        at2 = (at2 + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const q = input.value.trim();
        add2(
          !list2.hidden && shown[at2] && shown[at2] !== q && !shown.includes(q) ? shown[at2] : q
        );
      } else if (e.key === "Escape" && !list2.hidden) {
        e.preventDefault();
        e.stopPropagation();
        list2.hidden = true;
      } else if (e.key === "Backspace" && input.value === "" && values().values.length) {
        set(values().values.slice(0, -1));
      }
    });
    paint();
    return wrap;
  }
  function durationControl(c) {
    if (c.op === "before" || c.op === "on-or-after") return dateControl(c);
    const m = /^(\d+)([hdw])$/.exec(c.value.trim());
    const num = h4("input", {
      class: "cb-cond-num",
      type: "number",
      min: "1",
      step: "1",
      value: m ? m[1] : "",
      placeholder: "2",
      "aria-label": "how many"
    });
    const unit = h4(
      "select",
      { class: "cb-cond-unit", "aria-label": "unit" },
      ...[
        ["h", "hours"],
        ["d", "days"],
        ["w", "weeks"]
      ].map(([v, l]) => h4("option", { value: v }, l))
    );
    unit.value = m ? m[2] : "d";
    const set = () => {
      const n = num.value.trim();
      c.value = /^\d+$/.test(n) && Number(n) > 0 ? `${Number(n)}${unit.value}` : "";
      wrap.dataset.value = c.value;
      changed();
    };
    num.addEventListener("input", set);
    unit.addEventListener("change", set);
    const wrap = h4(
      "span",
      { class: "cb-cond-v cb-cond-dur", "data-value": c.value },
      num,
      unit,
      c.op === "older-than" ? h4("span", { class: "cb-cond-ago" }, "ago") : null
    );
    return wrap;
  }
  function dateControl(c) {
    const day = h4("input", {
      class: "cb-cond-date",
      type: "date",
      value: /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? c.value : "",
      "aria-label": "date"
    });
    const wrap = h4(
      "span",
      { class: "cb-cond-v cb-cond-dur", "data-value": c.value },
      day
    );
    day.addEventListener("input", () => {
      c.value = day.value;
      wrap.dataset.value = c.value;
      changed();
    });
    return wrap;
  }
  function opControl(c, f) {
    const readOp = c.op === "in" ? "is" : c.op === "not-in" ? "is-not" : c.op;
    if (!editable || !f) {
      return h4(
        "span",
        { class: "cb-cond-o", "data-value": c.op },
        opLabel(ops, readOp)
      );
    }
    if (picks(f) || typed(f)) {
      return select(
        "cb-cond-o",
        `${fieldLabel(f)} operator`,
        shownOps(f),
        (v) => opLabel(ops, v),
        f.type === BOOL ? c.op : readOp,
        (v) => {
          if (f.type === BOOL) c.op = v;
          else {
            const { values } = pickedValues(c);
            Object.assign(c, pickedCondition(c.field, v === "is-not", values));
          }
          rowsEl.querySelector(
            `.cb-cond[data-index="${conds.indexOf(c)}"] .cb-cond-picks, .cb-cond[data-index="${conds.indexOf(c)}"] .cb-cond-typed`
          )?.setAttribute("data-value", c.value);
          changed();
        }
      );
    }
    return select(
      "cb-cond-o",
      `${fieldLabel(f)} operator`,
      shownOps(f),
      (v) => opLabel(ops, v),
      c.op,
      (v) => {
        const isDay = (o) => o === "before" || o === "on-or-after";
        if (isDay(v) !== isDay(c.op)) c.value = "";
        c.op = v;
        const input = rowsEl.querySelector(
          `.cb-cond[data-index="${conds.indexOf(c)}"] input.cb-cond-v`
        );
        if (input) input.placeholder = placeholder(f, v);
        const ago = rowsEl.querySelector(
          `.cb-cond[data-index="${conds.indexOf(c)}"] .cb-cond-dur`
        );
        if (ago) ago.replaceWith(durationControl(c));
        changed();
      }
    );
  }
  function row(i) {
    const c = conds[i];
    const f = fieldOf(c.field);
    const remove = editable ? h4(
      "button",
      {
        type: "button",
        class: "cb-cond-rm",
        "aria-label": `remove ${conditionText(c, fields, ops)}`,
        onclick() {
          conds.splice(i, 1);
          render();
          changed();
        }
      },
      "×"
    ) : null;
    return h4(
      "div",
      { class: "cb-cond", "data-index": i },
      h4(
        "div",
        { class: "kit-tr cb-cond-row" + (editable ? " cb-cond-edit" : "") },
        h4(
          "span",
          { class: "cb-cond-f", "data-name": c.field },
          f ? fieldLabel(f) : c.field
        ),
        opControl(c, f),
        valueControl(i, f),
        remove
      ),
      h4("div", { class: "cb-cond-err", hidden: true })
    );
  }
  function render() {
    rowsEl.replaceChildren(...conds.map((_, i) => row(i)));
    const e = errors.get(el2);
    if (e) setConditionError(el2, e.index, e.message);
  }
  const search = h4("input", {
    class: "cb-cond-search",
    type: "text",
    placeholder: "find a field",
    spellcheck: false,
    "aria-label": "find a field",
    autocomplete: "off"
  });
  const options = h4("div", {
    class: "cb-cond-menu-list",
    role: "listbox",
    "aria-label": "fields"
  });
  const menu = h4(
    "div",
    { class: "cb-cond-menu", hidden: true },
    search,
    options
  );
  const add = h4(
    "button",
    {
      type: "button",
      class: "cb-cond-add",
      "aria-expanded": "false",
      "aria-haspopup": "listbox",
      onclick() {
        setMenu(menu.hidden);
      }
    },
    "+ condition"
  );
  const addWrap = h4("div", { class: "cb-cond-add-wrap" }, add, menu);
  addWrap.addEventListener("focusout", (e) => {
    if (!menu.hidden && !addWrap.contains(e.relatedTarget))
      setMenu(false);
  });
  function onEsc(e) {
    if (e.key !== "Escape" || e.isComposing) return;
    if (!el2.isConnected) {
      document.removeEventListener("keydown", onEsc, true);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setMenu(false);
    add.focus();
  }
  function onDown(e) {
    if (!el2.isConnected || !addWrap.contains(e.target)) setMenu(false);
  }
  function setMenu(open) {
    if (editable) return;
    menu.hidden = !open;
    add.setAttribute("aria-expanded", String(open));
    if (open) {
      search.value = "";
      fillMenu();
      document.addEventListener("keydown", onEsc, true);
      document.addEventListener("pointerdown", onDown, true);
      search.focus();
    } else {
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("pointerdown", onDown, true);
    }
  }
  function addCondition(f) {
    conds.push(newCondition(f));
    render();
    changed();
    const last = rowsEl.lastElementChild;
    last?.querySelector(".cb-cond-v, .cb-cond-pick")?.focus();
  }
  const offered = () => [
    ...options.querySelectorAll(
      '.cb-cond-menu-row:not([aria-disabled="true"])'
    )
  ];
  function setActive(to) {
    for (const r of options.querySelectorAll(
      ".cb-cond-menu-row"
    )) {
      const on = r === to;
      r.classList.toggle("on", on);
      r.setAttribute("aria-selected", String(on));
    }
    to?.scrollIntoView({ block: "nearest" });
  }
  function fillMenu() {
    const kind = fieldOf("kind");
    const types = typesOf(conds, kind?.values ?? []);
    const used = new Set(conds.map((c) => c.field));
    const groups = /* @__PURE__ */ new Map();
    for (const f of fields) {
      if (!fieldFound(f, search.value)) continue;
      const applies = fieldApplies(f, types);
      const taken = used.has(f.name) || !applies;
      const where = fieldTypes(f, kind) || "any type";
      const chip = h4(
        "button",
        {
          type: "button",
          class: "cb-cond-menu-row",
          "data-field": f.name,
          "aria-disabled": String(taken),
          title: used.has(f.name) ? "already used, change it below" : !applies ? `doesn't apply to the chosen type` : f.help ?? "",
          onclick() {
            if (!taken) addCondition(f);
          }
        },
        fieldLabel(f)
      );
      if (!groups.has(where)) groups.set(where, []);
      groups.get(where).push(chip);
    }
    options.replaceChildren(
      ...[...groups].map(
        ([where, chips]) => h4(
          "div",
          { class: "cb-cond-group" },
          h4("span", { class: "cb-cond-group-l" }, where),
          h4("span", { class: "cb-cond-group-c" }, ...chips)
        )
      )
    );
  }
  search.addEventListener("input", () => fillMenu());
  search.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const list2 = offered();
    const at2 = list2.findIndex((r) => r.classList.contains("on"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list2.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(list2[(at2 + step + list2.length) % list2.length]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = fieldOf(list2[at2]?.dataset.field ?? "");
      if (f) addCondition(f);
    }
  });
  render();
  if (editable) {
    menu.hidden = false;
    add.hidden = true;
    el2.prepend(addWrap);
  }
  void Promise.all([ruleVocabulary(ctx), ruleOperators(ctx)]).then(([fs, os]) => {
    fields = fs;
    ops = os;
    render();
    if (editable) fillMenu();
    el2.dataset.ready = "true";
  }).catch((err) => {
    if (!editable) {
      el2.dataset.ready = "true";
      return;
    }
    general.textContent = err instanceof Error ? err.message : "the vocabulary did not load";
    general.hidden = false;
  });
  return el2;
}
function setConditionError(editor, index, message5) {
  if (message5 === null) errors.delete(editor);
  else errors.set(editor, { index, message: message5 });
  for (const e of editor.querySelectorAll(".cb-cond-err")) {
    e.hidden = true;
    e.textContent = "";
  }
  for (const r2 of editor.querySelectorAll(".cb-cond[data-invalid]")) {
    r2.removeAttribute("data-invalid");
  }
  if (message5 === null) return;
  const r = editor.querySelector(
    `.cb-cond[data-index="${index}"]`
  );
  const slot = r ? r.querySelector(".cb-cond-err") : editor.querySelector(":scope > .cb-cond-err");
  r?.setAttribute("data-invalid", "");
  if (slot) {
    slot.textContent = message5;
    slot.hidden = false;
  }
}

// filters-text.ts
function parseFilterIds(s) {
  const out = [];
  for (const part of (s ?? "").split(",")) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
function toggleFilter(rows, selected, id) {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  const row = rows.find((r) => r.filter.id === id);
  if (!row || row.invalid) return selected;
  return [...selected, id];
}
function filterLabel(rows, ids) {
  return ids.map((id) => rows.find((r) => r.filter.id === id)?.filter.name ?? id).join(" + ");
}

// filters.ts
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
function makeFilterBar(_ctx, hooks) {
  let rows = [];
  let selected = [];
  const chipsEl = h5("div", {
    class: "kit-chips cb-filter-chips",
    "data-group": "filters"
  });
  const addBtn = h5(
    "button",
    {
      type: "button",
      class: "kit-chip cb-filter-add",
      onclick() {
        hooks.onNew();
      }
    },
    "+ filter"
  );
  const errEl = h5("p", { class: "cb-filter-err", hidden: true });
  const el2 = h5(
    "div",
    { class: "cb-filters", "aria-label": "saved filters" },
    h5("span", { class: "cb-bar-label" }, "filters"),
    chipsEl,
    errEl
  );
  function chip(row) {
    const id = row.filter.id;
    const on = selected.includes(id);
    const b = h5(
      "button",
      {
        type: "button",
        class: "kit-chip cb-filter" + (on ? " on" : ""),
        "data-id": id,
        "aria-pressed": String(on),
        onclick() {
          if (row.invalid) {
            hooks.onOpen(row);
            return;
          }
          const next = toggleFilter(rows, selected, id);
          if (next !== selected) hooks.onSelect(next, id);
        }
      },
      row.filter.name || id
    );
    if (row.invalid) {
      b.setAttribute("data-invalid", "");
      b.title = row.invalid;
    }
    return b;
  }
  function paint(r, sel) {
    rows = r;
    selected = sel;
    chipsEl.replaceChildren(...rows.map(chip), addBtn);
  }
  function setError(msg) {
    errEl.hidden = msg === null;
    errEl.textContent = msg ?? "";
  }
  paint([], []);
  return { el: el2, paint, setError };
}
function renderFilter(ctx, row, hooks) {
  const f = row.filter;
  const note = h5("p", { class: "cb-rule-note", role: "status" });
  const bs = [{ label: "edit", run: () => hooks.onEdit() }];
  if (!row.invalid)
    bs.push({ label: "make a rule", run: () => hooks.onMakeRule() });
  bs.push({
    label: "delete",
    run: () => {
      note.textContent = "";
      void ctx.api.post("/filters/delete", { id: f.id }).then(() => hooks.onDeleted()).catch((err) => {
        note.textContent = message(err);
      });
    }
  });
  return h5(
    "div",
    { class: "kit-doc" },
    h5(
      "article",
      { class: "cb-rule cb-filter-doc", "data-filter": f.id },
      h5("p", { class: "kit-kick" }, "filter"),
      h5("h1", { class: "kit-h1" }, f.name || f.id),
      row.invalid ? card({
        edge: "signal",
        head: "not valid",
        body: h5(
          "div",
          null,
          h5("p", { class: "cb-invalid-msg" }, row.invalid),
          h5(
            "p",
            { class: "cb-invalid-help" },
            "This filter selects nothing until it is valid. Edit it to fix it."
          )
        )
      }) : null,
      h5("h3", { class: "kit-label" }, "items that match all of"),
      conditionEditor(
        ctx,
        { match: f.match, status: "active", editable: false },
        () => {
        }
      ),
      h5("div", { class: "cb-rule-actions" }, buttons2(bs), note)
    )
  );
}
function filterEditor(ctx, row, hooks) {
  let match = (row?.filter.match ?? []).map((c) => ({ ...c }));
  const editor = conditionEditor(
    ctx,
    { match, status: "draft" },
    (m) => {
      match = m;
      hooks.onDraft(match);
    }
  );
  if (row?.invalid) {
    setConditionError(editor, conditionErrorIndex(row.invalid), row.invalid);
  }
  const name = h5("input", {
    class: "cb-filter-name",
    type: "text",
    placeholder: "name",
    "aria-label": "filter name",
    onkeydown(e) {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void save();
      }
    }
  });
  if (row) name.value = row.filter.name;
  const nameErr = h5("p", { class: "cb-filter-name-err", hidden: true });
  function showNameError(msg) {
    nameErr.hidden = msg === null;
    nameErr.textContent = msg ?? "";
  }
  function showError(err) {
    if (err === null) {
      if (!row?.invalid || match.length) setConditionError(editor, -1, null);
      return;
    }
    const msg = message(err);
    setConditionError(editor, conditionErrorIndex(msg), msg);
  }
  async function save() {
    const n = name.value.trim();
    const id = row ? row.filter.id : slug(n);
    showNameError(null);
    try {
      await ctx.api.post(
        row ? "/filters/save" : "/filters/save?create=1",
        { id, name: n, match }
      );
      hooks.onSaved(id);
    } catch (err) {
      const msg = message(err);
      if (err instanceof ApiError && err.status === 409) {
        showNameError(msg);
        return;
      }
      const i = conditionErrorIndex(msg);
      if (i < 0 && /name|filter id/.test(msg)) {
        showNameError(msg);
        return;
      }
      setConditionError(editor, i, msg);
    }
  }
  const el2 = h5(
    "div",
    { class: "kit-doc" },
    h5(
      "article",
      { class: "cb-filter-edit", "data-testid": "filter-editor" },
      h5(
        "h1",
        { class: "kit-h1 cb-filter-title" },
        row ? `edit ${row.filter.name || row.filter.id}` : "new filter"
      ),
      h5(
        "div",
        { class: "cb-filter-acts" },
        name,
        h5(
          "button",
          {
            type: "button",
            class: "kit-btn fill cb-filter-save",
            onclick() {
              void save();
            }
          },
          "save"
        ),
        h5(
          "button",
          {
            type: "button",
            class: "kit-btn cb-filter-cancel",
            onclick() {
              hooks.onCancel();
            }
          },
          "cancel"
        )
      ),
      nameErr,
      editor
    )
  );
  return { el: el2, showError };
}

// list-pane-text.ts
function paneQuery(query) {
  const p = new URLSearchParams(query);
  return {
    filters: (p.get("filters") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    q: p.get("q") ?? ""
  };
}
function paneParams(q) {
  const out = {};
  if (q.filters.length) out["filters"] = q.filters.join(",");
  if (q.q) out["q"] = q.q;
  return out;
}
function withPane(query, q) {
  const parts = query.split("&").filter((x) => x && !/^(filters|q)(=|$)/.test(x));
  if (q.filters.length) parts.push(`filters=${q.filters.join(",")}`);
  if (q.q) parts.push(`q=${encodeURIComponent(q.q)}`);
  return parts.join("&");
}
function paneLines(r) {
  const i = r.key.indexOf(":");
  const key = i < 0 ? r.key : `${r.key.slice(0, i)} · ${r.key.slice(i + 1)}`;
  return { one: r.title || key, two: r.stands, hover: r.key };
}

// list-pane.ts
var SEARCH_MS = 200;
function setHashQuery(query) {
  const path = location.hash.split("?")[0] || "#/";
  history.replaceState(
    null,
    "",
    location.pathname + location.search + path + (query ? `?${query}` : "")
  );
}
function makePane(ctx, tab, selection2, hooks) {
  let q = { filters: [], q: "" };
  let timer = null;
  const moreBtn = h6("button", {
    type: "button",
    class: "cb-foot-more",
    hidden: true,
    onclick() {
      hooks.onMore();
    }
  });
  const obsText = h6("span", { "data-testid": "observations" });
  const obsEl = h6(
    "div",
    { class: "cb-apply-obs", hidden: true },
    h6("i", { class: "cb-apply-obs-dot", "aria-hidden": "true" }),
    obsText
  );
  const foot = h6("div", { class: "cb-pane-foot" }, obsEl, moreBtn);
  const handle = list({
    label: "",
    selection: selection2,
    openOnMove: false,
    search: {
      placeholder: "search by key or title",
      onInput(text) {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          q = { ...q, q: text };
          hooks.onQuery({ ...q });
        }, SEARCH_MS);
      }
    },
    row(it) {
      const r = hooks.row(it);
      const l = paneLines(r);
      return {
        id: r.id,
        key: l.one,
        title: l.two,
        selectable: r.selectable ?? true
      };
    },
    onOpen(it) {
      hooks.onOpen(it);
    },
    foot
  });
  const el2 = handle.el;
  el2.classList.add("cb-pane", `cb-pane-${tab}`);
  el2.dataset.tab = tab;
  const filterBar = makeFilterBar(ctx, {
    onSelect(ids, clicked) {
      q = { ...q, filters: ids };
      hooks.onQuery({ ...q }, clicked);
    },
    onOpen(row) {
      hooks.onFilterOpen(row);
    },
    onNew() {
      hooks.onFilterNew();
    }
  });
  const ownRow = h6("div", { class: "cb-own" });
  const tools = h6("div", { class: "cb-pane-tools" });
  const lh = el2.querySelector(".kit-lh");
  const search = el2.querySelector(".kit-search");
  if (lh) {
    lh.classList.add("cb-pane-top");
    lh.replaceChildren(
      filterBar.el,
      ...search ? [search] : [],
      ownRow,
      tools
    );
  }
  const storeKey = `casebook.sidebar.${tab}`;
  const hideBtn = h6(
    "button",
    {
      type: "button",
      class: "cb-list-hide",
      title: "hide the list",
      onclick() {
        setSidebar(false);
      }
    },
    "«"
  );
  const showBtn = h6(
    "button",
    { type: "button", class: "cb-list-show", title: "show the list" },
    "»"
  );
  const railLabel = h6("span", { class: "cb-list-rail-label" });
  const rail = h6(
    "div",
    {
      class: "cb-list-rail",
      onclick() {
        setSidebar(true);
      }
    },
    showBtn,
    railLabel
  );
  el2.append(hideBtn, rail);
  function setSidebar(open) {
    el2.classList.toggle("cb-list-closed", !open);
    try {
      localStorage.setItem(storeKey, open ? "open" : "closed");
    } catch {
    }
  }
  try {
    el2.classList.toggle(
      "cb-list-closed",
      localStorage.getItem(storeKey) === "closed"
    );
  } catch {
  }
  void getVocab(ctx).then((v) => {
    hideBtn.title = v.hide_list;
    showBtn.title = v.show_list;
  }).catch(() => {
  });
  let heads = [];
  function head(g, open) {
    const toggle = () => hooks.onToggle(g.id);
    const box = g.box ? h6("span", {
      class: "cb-group-box",
      role: "checkbox",
      "aria-checked": "false",
      "aria-label": g.label,
      onclick() {
        hooks.onTickGroup(g.id);
      }
    }) : h6("span", { class: "cb-group-nobox" });
    const tickedN = h6("span", { class: "cb-group-ticked-n" });
    const ticked = h6(
      "span",
      { class: "cb-group-ticked", hidden: true },
      tickedN,
      h6(
        "button",
        {
          type: "button",
          class: "cb-group-untick",
          onclick() {
            selection2.deselect(hooks.tickedIn(g.id));
          }
        },
        "untick"
      )
    );
    const acts = h6("span", { class: "cb-group-acts" });
    const named = [g.label, g.tag].filter(Boolean).join(" · ");
    const top = h6(
      "div",
      { class: "cb-group-top" },
      h6(
        "button",
        {
          type: "button",
          class: "cb-group-caret",
          "aria-expanded": String(open),
          "aria-label": g.label,
          onclick: toggle
        },
        open ? "▼" : "▶"
      ),
      box,
      h6(
        "span",
        { class: "cb-group-name", title: named, onclick: toggle },
        h6("span", { class: "cb-group-label" }, g.label),
        g.tag ? h6("span", { class: "cb-group-tag" }, g.tag) : null
      ),
      ticked,
      acts,
      h6("span", { class: "cb-group-n" }, String(g.n)),
      g.more ?? null
    );
    const data = { group: g.id, ...g.data ?? {} };
    if (tab !== "decide") data["part"] = g.id;
    const hd = h6(
      "div",
      {
        class: "cb-group" + (tab !== "decide" ? " cb-apply-part" : "") + (open ? "" : " collapsed"),
        role: "presentation",
        dataset: data
      },
      top
    );
    heads.push({
      paint() {
        const n = hooks.tickedIn(g.id).length;
        box.setAttribute(
          "aria-checked",
          n === 0 ? "false" : n >= g.n ? "true" : "mixed"
        );
        ticked.hidden = n === 0;
        tickedN.textContent = `${n} ticked · `;
        acts.replaceChildren(...hooks.headActs?.(g.id) ?? []);
      }
    });
    return hd;
  }
  function setRows(items, groups, opened) {
    const listedIds = new Set(groups.map((g) => g.id));
    const shown = items.filter((it) => {
      const g = hooks.groupOf(it);
      return !listedIds.has(g) || opened.has(g);
    });
    handle.setItems(shown);
    const body = el2.querySelector(".kit-rows");
    const rowEls = el2.querySelectorAll(".kit-rows > .kit-row");
    shown.forEach((it, i) => {
      const rowEl = rowEls[i];
      if (!rowEl) return;
      const r = hooks.row(it);
      const l = paneLines(r);
      rowEl.dataset.key = r.key;
      rowEl.dataset.group = hooks.groupOf(it);
      rowEl.title = l.hover;
      const one = rowEl.querySelector(".kit-kicker");
      if (one) one.title = l.one;
      const two = rowEl.querySelector(".kit-title");
      if (two) {
        two.title = l.two;
        two.className = `kit-title cb-tone-${r.tone ?? "muted"}`;
      }
    });
    heads = [];
    if (!body) return shown;
    const listed = new Set(groups.map((g) => g.id));
    let last = null;
    shown.forEach((it, i) => {
      if (listed.has(hooks.groupOf(it))) return;
      rowEls[i]?.classList.add("cb-loose");
      if (!shown.slice(0, i).some((x) => listed.has(hooks.groupOf(x))))
        last = rowEls[i] ?? last;
    });
    for (const g of groups) {
      const hd = head(g, opened.has(g.id));
      const first = shown.findIndex((it) => hooks.groupOf(it) === g.id);
      if (first >= 0) {
        rowEls[first]?.before(hd);
        let end = first;
        while (end + 1 < shown.length && hooks.groupOf(shown[end + 1]) === g.id)
          end++;
        last = rowEls[end] ?? hd;
      } else {
        if (last) last.after(hd);
        else body.prepend(hd);
        last = hd;
      }
    }
    paintHeads();
    return shown;
  }
  function paintHeads() {
    for (const hd of heads) hd.paint();
  }
  return {
    el: el2,
    handle,
    ownRow,
    tools,
    setFilters(rows, selected) {
      q = { ...q, filters: [...selected] };
      filterBar.paint(rows, selected);
    },
    setFilterError(msg) {
      filterBar.setError(msg);
    },
    setSearch(text) {
      q = { ...q, q: text };
      handle.setSearch(text);
    },
    query: () => ({ filters: [...q.filters], q: q.q }),
    setRows,
    paintHeads,
    setMore(left) {
      moreBtn.hidden = left <= 0;
      moreBtn.textContent = `show ${left} more`;
    },
    setObs(text, state) {
      obsText.textContent = text;
      obsEl.dataset.state = state;
      obsEl.hidden = !text;
    },
    setRail(text) {
      railLabel.textContent = text;
    }
  };
}

// mid.ts
import { h as h7 } from "/_kit/kit.js";
function midHead(o) {
  return [
    h7("p", { class: "cb-mid-kick", title: o.kick }, o.kick),
    h7("h1", { class: "cb-mid-title", title: o.title }, o.title),
    h7("p", { class: "cb-mid-ctx", title: o.ctx }, o.ctx),
    h7("div", { class: "cb-mid-acts" }, ...o.acts)
  ];
}

// apply.ts
var PAGE = 200;
var STEPS_PAGE = 200;
var RUNNING = "running";
var DONE = "done";
function message2(err) {
  return err instanceof Error ? err.message : String(err);
}
var dangerVerb = (verb) => DANGER_DISPS.has(verb) || verb === "remove";
function focusKey(el2) {
  const host = el2.closest(
    "[data-card],[data-step],[data-session],[data-testid]"
  );
  const hostKey = host ? ["card", "step", "session", "testid"].map((a) => host.getAttribute(`data-${a}`) ?? "").join("/") : "";
  const own = el2 instanceof HTMLTextAreaElement || el2 instanceof HTMLInputElement ? el2.className : el2.textContent ?? "";
  return `${hostKey}|${el2.tagName}|${own}`;
}
function focusSnapshot(root) {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) return null;
  const field = a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement ? a : null;
  return {
    key: focusKey(a),
    start: field ? field.selectionStart : null,
    end: field ? field.selectionEnd : null
  };
}
function focusRestore(root, snap) {
  if (!snap) return;
  const els = root.querySelectorAll(
    "button, textarea, input, a[href], [tabindex]"
  );
  for (const el2 of els) {
    if (focusKey(el2) !== snap.key) continue;
    el2.focus({ preventScroll: true });
    if ((el2 instanceof HTMLTextAreaElement || el2 instanceof HTMLInputElement) && snap.start !== null) {
      el2.setSelectionRange(snap.start, snap.end ?? snap.start);
    }
    return;
  }
}
function makeApply(ctx) {
  const readEl = h8("div", { class: "kit-read cb-apply-read" });
  let mode = "review";
  let jobs = [];
  let cards = [];
  let sessions = [];
  let items = [];
  let itemsTotal = 0;
  let itemsLoaded = false;
  let groups = [];
  let vocab2 = null;
  const flipped = /* @__PURE__ */ new Set();
  const startsOpen = (id) => id === RUNNING;
  const collapsed = {
    has: (id) => startsOpen(id) === flipped.has(id),
    delete(id) {
      if (!this.has(id)) return false;
      if (flipped.has(id)) flipped.delete(id);
      else flipped.add(id);
      return true;
    },
    add(id) {
      if (this.has(id)) return;
      if (flipped.has(id)) flipped.delete(id);
      else flipped.add(id);
    }
  };
  let active = false;
  let wantGroup = "";
  let reviewOpen = false;
  let followTimer = null;
  const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  let reviewKeys = [];
  let reviewView = null;
  let drawnView = null;
  let reviewNote = "";
  let refusal = "";
  let openId = null;
  let open = null;
  let stepsShown = STEPS_PAGE;
  let note = "";
  let busy = false;
  let painting = false;
  let builtAt = 0;
  let intervalMs = 0;
  let syncing = false;
  let syncError = "";
  let afterSync = false;
  const editors = /* @__PURE__ */ new Map();
  const itemsSeq = makeSeq();
  const listSeq = makeSeq();
  const jobSeq = makeSeq();
  const planSeq = makeSeq();
  const runner = () => ctx.dockTarget();
  const harnessOf = (id) => sessions.find((s) => s.id === id)?.harness || "";
  const runnerAgent = () => {
    const t = runner();
    if (!t) return null;
    return harnessOf(t.id) || ctx.agentName() || "agent";
  };
  const agentOf = (job) => harnessOf(job.session) || ctx.agentName() || "agent";
  let reviewQ = { filters: [], q: "" };
  let runQ = { filters: [], q: "" };
  let filterRows = [];
  const groupOfKey = /* @__PURE__ */ new Map();
  const reviewSel = createSelection();
  const runSel = createSelection();
  const held = () => startedKeys(jobs);
  const order = () => runOrder(jobs);
  const kindOfGroup = (g) => g.id.slice(g.id.indexOf("|") + 1);
  const groupName = (g) => kindVocab(kindOfGroup(g))?.nouns ?? "";
  const choiceVocabOf = (g) => kindVocab(kindOfGroup(g))?.choices?.find(
    (c) => c.disposition === g.disposition
  );
  const choiceOf = (g) => choiceVocabOf(g)?.label ?? "";
  const doneOf = (g) => choiceVocabOf(g)?.done ?? "";
  const titleOf = (j) => planTitle(j, (kind) => {
    const kv = kindVocab(kind);
    return kv ? [kv.noun, kv.nouns] : [kind, `${kind}s`];
  });
  const kindVocab = (kind) => vocab2?.kinds?.find((k) => k.kind === kind);
  function labelFor(g, n) {
    const kv = kindVocab(kindOfGroup(g));
    if (!kv || !g.many) return g.label;
    return applyLabel(g.many, kv.noun, kv.nouns, n);
  }
  const waiting = (g) => items.filter((it) => it.group === g.id && !held().has(it.key));
  function waitingCount(g) {
    const loaded = new Set(items.map((i) => i.key));
    let n = items.filter(
      (it) => it.group === g.id && held().has(it.key)
    ).length;
    if (itemsTotal > items.length) n += heldOutside(jobs, g.id, loaded);
    return Math.max(0, g.total - n);
  }
  const tickedIn = (id) => reviewSel.ids().filter((k) => groupOfKey.get(k) === id);
  const tickedKeys = () => groups.flatMap((g) => tickedIn(g.id).sort());
  let shownRun = [];
  const reviewPane = makePane(
    ctx,
    "review",
    reviewSel,
    {
      row(it) {
        const g = groups.find((x) => x.id === it.group);
        const st = reviewLine(it, g ? doneOf(g) : "");
        return {
          id: it.key,
          key: it.key,
          title: it.title || void 0,
          stands: st.text,
          tone: st.tone
        };
      },
      groupOf: (it) => it.group,
      onOpen() {
        if (!painting) reviewPane.handle.toggle();
      },
      onQuery(q) {
        reviewQ = q;
        setHashQuery(withPane("", reviewQ));
        void loadItems(0, true);
      },
      onToggle(id) {
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        paintList();
      },
      onTickGroup(id) {
        void tickGroup(id);
      },
      tickedIn,
      onMore() {
        void loadItems(items.length);
      },
      onFilterOpen(row) {
        ctx.route.go("decide", "", `filters=${row.filter.id}`);
      },
      onFilterNew() {
        ctx.route.go("decide", "", "new=filter");
      }
    }
  );
  const runPane = makePane(ctx, "run", runSel, {
    row(j) {
      const p = progress(j);
      const needs = needsLine(cardsFor(j.id), p.paused);
      return {
        id: `job:${j.id}`,
        key: `job:${j.id}`,
        title: titleOf(j),
        stands: [
          needs,
          p.started || isFinished(j) ? `${p.finished}/${p.total}` : "queued"
        ].filter(Boolean).join(" · "),
        tone: needs ? "signal" : "muted",
        selectable: false
      };
    },
    groupOf: (j) => isFinished(j) ? DONE : RUNNING,
    onOpen(j) {
      if (!painting) ctx.route.go("run", String(j.id));
    },
    onQuery(q) {
      runQ = q;
    },
    onToggle(id) {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      paintList();
    },
    onTickGroup() {
    },
    tickedIn: () => [],
    onMore() {
    },
    onFilterOpen(row) {
      ctx.route.go("decide", "", `filters=${row.filter.id}`);
    },
    onFilterNew() {
      ctx.route.go("decide", "", "new=filter");
    }
  });
  reviewPane.el.classList.add("cb-apply-list");
  runPane.el.classList.add("cb-apply-list");
  const listEl = h8(
    "div",
    { class: "kit-list cb-panes" },
    reviewPane.el,
    runPane.el
  );
  function showPane() {
    reviewPane.el.hidden = mode !== "review";
    runPane.el.hidden = mode !== "run";
  }
  showPane();
  reviewSel.onChange(() => {
    reviewPane.paintHeads();
    if (mode !== "review") return;
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      if (mode === "review") void openTicked();
    }, 250);
  });
  const cardsFor = (jobId) => openCardsByJob(cards.filter((c) => c.kind !== "paused")).get(jobId) ?? 0;
  function paintList() {
    ctx.bar.setCount("run", order().running.length);
    const gs = groups.map((g) => ({ g, n: waitingCount(g) })).filter((x) => x.n > 0).map(({ g, n }) => ({
      id: g.id,
      label: groupName(g) || g.label,
      tag: choiceOf(g),
      n,
      box: true
    }));
    painting = true;
    try {
      reviewPane.setRows(
        items.filter((it) => !held().has(it.key)),
        gs,
        new Set(gs.filter((g) => !collapsed.has(g.id)).map((g) => g.id))
      );
      reviewPane.setMore(Math.min(PAGE, itemsTotal - items.length));
      const o = order();
      const rgs = [];
      if (o.running.length)
        rgs.push({
          id: RUNNING,
          label: "running",
          n: o.running.length,
          box: false
        });
      if (o.done.length)
        rgs.push({ id: DONE, label: "done", n: o.done.length, box: false });
      shownRun = runPane.setRows(
        [...o.running, ...o.done],
        rgs,
        new Set(rgs.filter((g) => !collapsed.has(g.id)).map((g) => g.id))
      );
      const els = runPane.el.querySelectorAll(
        ".kit-rows > .kit-row"
      );
      shownRun.forEach((j, i) => {
        if (els[i]) decorateJobRow(els[i], j);
      });
      const openAt = mode === "run" ? shownRun.findIndex((j) => j.id === openId) : -1;
      if (openAt >= 0) runPane.handle.open(openAt);
    } finally {
      painting = false;
    }
    paintObs();
    drawOverview();
  }
  function decorateJobRow(rowEl, j) {
    rowEl.dataset.job = String(j.id);
    rowEl.classList.add("cb-job-row");
    const p = progress(j);
    const kicker = rowEl.querySelector(".kit-kicker");
    const lanes = jobLanes(j);
    if (kicker && lanes.length) {
      kicker.replaceChildren(
        ...lanes.flatMap((l, i) => [
          i ? " + " : "",
          h8(
            "span",
            { class: `cb-lanename cb-lanename-${l}`, "data-lane": l },
            laneLabel(l, agentOf(j))
          )
        ])
      );
    }
    const meta = rowEl.querySelector(".kit-meta");
    if (meta?.textContent === "queued") meta.classList.add("cb-queued");
    rowEl.querySelector(".kit-sub")?.classList.add("cb-needs-line");
    const bar2 = h8("div", {
      class: "cb-pb",
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": String(p.total),
      "aria-valuenow": String(p.finished)
    });
    for (const l of lanes) {
      const n = p.byLane[l] ?? 0;
      if (!n) continue;
      bar2.append(
        h8("span", {
          class: `cb-pb-${l}`,
          style: `width:${100 * n / Math.max(1, p.total)}%`
        })
      );
    }
    rowEl.querySelector(".kit-title")?.after(bar2);
  }
  function paintObs() {
    const o = builtAt ? observations(builtAt, intervalMs, Date.now()) : { text: "", stale: false };
    const text = syncing ? "syncing observations…" : builtAt ? o.text : "";
    const state = syncing ? "syncing" : o.stale ? "stale" : "fresh";
    reviewPane.setObs(text, state);
    runPane.setObs(text, state);
  }
  const obsTimer = setInterval(paintObs, 1e3);
  void obsTimer;
  const dirty = {
    all: false,
    items: false,
    sessions: false,
    summary: false,
    jobs: /* @__PURE__ */ new Set()
  };
  let flushing = false;
  let queued = false;
  function mark(f) {
    f(dirty);
    if (flushing) {
      queued = true;
      return;
    }
    flushing = true;
    setTimeout(() => void flush(), 40);
  }
  async function flush() {
    try {
      do {
        queued = false;
        const d = {
          all: dirty.all,
          items: dirty.items,
          sessions: dirty.sessions,
          summary: dirty.summary,
          jobs: [...dirty.jobs]
        };
        dirty.all = dirty.items = dirty.sessions = dirty.summary = false;
        dirty.jobs.clear();
        const some = d.all && openId !== null ? [openId] : d.all ? [] : d.jobs;
        await Promise.all([
          d.all ? loadJobs() : null,
          some.length ? loadSome(some) : null,
          d.items ? loadItems() : null,
          d.sessions ? loadSessions() : null,
          d.summary ? loadSummary() : null
        ]);
      } while (queued);
    } finally {
      flushing = false;
    }
  }
  function patchJob(v) {
    const i = jobs.findIndex((j) => j.id === v.job.id);
    if (i >= 0) jobs[i] = v.job;
    else jobs = [...jobs, v.job];
    cards = [
      ...cards.filter((c) => c.job_id !== v.job.id),
      ...(v.needs_you ?? []).filter((c) => c.state === "open")
    ];
  }
  async function loadJobs() {
    const mine = listSeq.next();
    try {
      const [j, c] = await Promise.all([
        ctx.api.get("/jobs"),
        ctx.api.get("/needs-you")
      ]);
      if (!listSeq.isLatest(mine)) return;
      jobs = j.jobs ?? [];
      cards = c.cards ?? [];
      if (open) patchJob(open);
      paintList();
      askNamedSessions();
    } catch {
    }
  }
  async function loadSome(ids) {
    const openMine = openId !== null && ids.includes(openId) ? jobSeq.next() : 0;
    const at2 = openId;
    const got = await Promise.all(
      ids.map(
        (id) => ctx.api.get("/job", { id: String(id) }).catch(() => null)
      )
    );
    let drawn = null;
    got.forEach((v, i) => {
      if (!v) return;
      if (ids[i] === at2) {
        if (!jobSeq.isLatest(openMine) || openId !== at2) return;
        drawn = v;
      }
      patchJob(v);
    });
    if (drawn) setOpen(drawn);
    else paintList();
    askNamedSessions();
  }
  async function loadItems(offset = 0, narrowed = false) {
    const mine = itemsSeq.next();
    try {
      const v = await ctx.api.get("/items", {
        view: "to-apply",
        ...paneParams(reviewQ),
        limit: String(PAGE),
        offset: String(offset)
      });
      if (!itemsSeq.isLatest(mine)) return;
      reviewPane.setFilterError(null);
      const got = v.items ?? [];
      items = offset ? [...items, ...got] : got;
      itemsTotal = v.total;
      itemsLoaded = true;
      groups = v.groups ?? [];
      for (const it of got) groupOfKey.set(it.key, it.group);
      if (offset === 0 && reviewSel.ids().length) {
        const shown = itemsTotal <= items.length ? items.map((it) => it.key) : await viewKeys();
        if (!itemsSeq.isLatest(mine)) return;
        const gone = untickHidden(reviewSel.ids(), new Set(shown));
        if (gone.length) reviewSel.deselect(gone);
      }
      paintList();
      applyWanted();
    } catch (err) {
      if (!itemsSeq.isLatest(mine)) return;
      if (err instanceof ApiError2 && err.status === 400 && narrowed) {
        reviewPane.setFilterError(err.message);
        items = [];
        itemsTotal = 0;
        groups = [];
        paintList();
      }
    }
  }
  const loadSessions = coalesced(fetchSessions);
  let sessionsNamed = /* @__PURE__ */ new Set();
  function namedSessions() {
    const ids = [
      runner()?.id ?? "",
      open?.job.session ?? "",
      ...jobs.map((j) => j.session)
    ];
    return [...new Set(ids.filter(Boolean))].sort();
  }
  function askNamedSessions() {
    const missing = namedSessions().some(
      (id) => !sessionsNamed.has(id) && !sessions.some((s) => s.id === id)
    );
    if (missing) mark((d) => d.sessions = true);
  }
  async function fetchSessions() {
    try {
      const named = namedSessions();
      sessionsNamed = new Set(named);
      const v = await ctx.api.get(
        "/sessions",
        named.length ? { session: named.join(",") } : void 0
      );
      sessions = v.sessions ?? [];
      paintList();
      if (reviewView) drawReview();
      if (active) ctx.setPrimary(primary());
    } catch {
    }
  }
  async function loadSummary() {
    try {
      const s = await ctx.api.get("/summary");
      builtAt = Date.parse(s.built_at) || 0;
      intervalMs = s.sync_interval_ms;
      syncing = s.syncing;
      paintObs();
      drawOverview();
    } catch {
    }
  }
  async function loadJob(id) {
    const mine = jobSeq.next();
    try {
      const v = await ctx.api.get("/job", { id: String(id) });
      if (!jobSeq.isLatest(mine) || openId !== id) return;
      setOpen(v);
      askNamedSessions();
    } catch (err) {
      if (!jobSeq.isLatest(mine) || openId !== id) return;
      open = null;
      readEl.replaceChildren(
        h8(
          "div",
          { class: "cb-read-empty" },
          h8("p", { class: "cb-read-empty-section kit-label" }, "run"),
          h8("p", { class: "cb-read-empty-prompt" }, message2(err))
        )
      );
      feed();
    }
  }
  function setOpen(v) {
    const first = open?.job.id !== v.job.id;
    open = v;
    if (isFinished(v.job) && v.job.state !== "cancelled")
      collapsed.delete(DONE);
    patchJob(v);
    for (const id of [...editors.keys()]) {
      if (!(v.needs_you ?? []).some((c) => c.id === id && c.state === "open"))
        editors.delete(id);
    }
    if (first) stepsShown = STEPS_PAGE;
    paintList();
    if (mode !== "run") return;
    drawOpen();
    if (first) readEl.scrollTop = 0;
    feed();
  }
  async function act(path, body, ok) {
    if (busy) return;
    busy = true;
    note = "";
    const mine = jobSeq.next();
    try {
      const r = await ctx.api.post(path, body);
      ok?.();
      const jv = r;
      if (jv && typeof jv === "object" && "job" in jv && jv.job) {
        if (jobSeq.isLatest(mine) && openId === jv.job.id) setOpen(jv);
        else patchJob(jv);
      } else if (openId !== null) {
        const id = openId;
        mark((d) => d.jobs.add(id));
      }
    } catch (err) {
      note = message2(err);
      drawOpen();
    } finally {
      busy = false;
    }
  }
  async function tickGroup(id, only = false) {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const ticked = tickedIn(id);
    const total = waitingCount(g);
    if (!only && total > 0 && ticked.length >= total) {
      reviewSel.deselect(ticked);
      return;
    }
    let keys = waiting(g).map((it) => it.key);
    if (keys.length < total) {
      try {
        keys = await groupKeys2(id);
      } catch {
        return;
      }
    }
    reviewSel.all(keys);
    if (collapsed.has(id)) {
      collapsed.delete(id);
      paintList();
    }
  }
  function applyWanted() {
    if (!wantGroup || !active || mode !== "review" || !itemsLoaded) return;
    const id = wantGroup;
    wantGroup = "";
    reviewSel.clear();
    void tickGroup(id, true);
  }
  async function openTicked(force = false) {
    const keys = tickedKeys();
    if (!keys.length) {
      closeReview();
      drawOverview();
      feed();
      return;
    }
    if (!force && reviewOpen && sameKeys(keys, reviewKeys)) return;
    const mine = planSeq.next();
    reviewOpen = true;
    reviewKeys = keys;
    reviewNote = "";
    refusal = "";
    note = "";
    if (!reviewView) drawReview();
    try {
      const v = await ctx.api.post("/apply/plan", {
        keys,
        preview: true
      });
      if (!planSeq.isLatest(mine)) return;
      reviewView = v;
      afterSync = false;
      syncError = "";
    } catch (err) {
      if (!planSeq.isLatest(mine)) return;
      reviewView = null;
      const msg = message2(err);
      if (err instanceof ApiError2 && err.status === 409 && msg.includes("sync first"))
        refusal = msg;
      else reviewNote = msg;
    }
    if (!planSeq.isLatest(mine)) return;
    drawReview();
    feed();
  }
  async function viewKeys() {
    const keys = [];
    for (let total = Infinity; keys.length < total; ) {
      const v = await ctx.api.get("/items", {
        view: "to-apply",
        ...paneParams(reviewQ),
        limit: "500",
        offset: String(keys.length)
      });
      const got = v.items ?? [];
      total = v.total;
      if (!got.length) break;
      for (const it of got) groupOfKey.set(it.key, it.group);
      keys.push(...got.map((i) => i.key));
    }
    return keys;
  }
  async function groupKeys2(id) {
    const h0 = held();
    const keys = [];
    for (let total = Infinity; keys.length < total; ) {
      const v = await ctx.api.get("/items", {
        view: "to-apply",
        ...paneParams(reviewQ),
        group: id,
        limit: "500",
        offset: String(keys.length)
      });
      const got = v.items ?? [];
      total = v.total;
      if (!got.length) break;
      for (const it of got) groupOfKey.set(it.key, it.group);
      keys.push(...got.map((i) => i.key));
    }
    return keys.filter((k) => !h0.has(k));
  }
  function closeReview() {
    planSeq.next();
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
    reviewOpen = false;
    reviewView = null;
    reviewKeys = [];
    reviewNote = "";
  }
  async function syncFirst() {
    syncError = "";
    afterSync = true;
    try {
      const v = await ctx.api.post("/sync", {});
      syncing = v.running;
    } catch (err) {
      afterSync = false;
      syncError = message2(err);
    }
    paintObs();
    drawReview();
    if (active) ctx.setPrimary(primary());
  }
  function onSync(e) {
    if (e.state === "running") {
      syncing = true;
      syncError = "";
    } else {
      syncing = false;
      syncError = e.state === "failed" ? e.error ?? "failed" : "";
      mark((d) => d.summary = true);
      if (e.state === "done" && afterSync) {
        afterSync = false;
        refusal = "";
        if (reviewOpen) void openTicked(true);
      } else if (e.state === "done" && refusal) {
        refusal = "";
      }
    }
    paintObs();
    drawReview();
    if (active) ctx.setPrimary(primary());
  }
  function runCheck() {
    const v = reviewView;
    if (!v || v !== drawnView || v.job.state !== "planned") return null;
    const steps = v.job.steps ?? [];
    const rt = runsThrough(steps, runnerAgent());
    return { v, can: !!steps.length && rt.can && !busy, text: rt.text };
  }
  function runGroup() {
    const rc = runCheck();
    if (!rc?.can) return;
    const j = rc.v.job;
    const steps = j.steps ?? [];
    const go2 = () => {
      const now = runCheck();
      if (!now?.can || now.v !== rc.v) return;
      void saveAndRun(rc.v, needsSession(steps) ? runner()?.id ?? "" : "");
    };
    const permanent = steps.filter((s) => s.permanent);
    if (!permanent.length) return go2();
    const title = titleOf(j);
    const keys = [...new Set(permanent.map((s) => s.key))];
    const sh = sheet2({
      title: `${title}?`,
      body: h8(
        "div",
        { class: "cb-confirm", "data-testid": "confirm-permanent" },
        h8(
          "p",
          { class: "cb-confirm-warn" },
          "This cannot be undone. These run on GitHub as soon as you confirm:"
        ),
        h8(
          "ul",
          { class: "cb-confirm-list" },
          ...keys.map((k) => h8("li", {}, keyWithoutKind(k)))
        )
      ),
      actions: [
        { label: "cancel", run: () => sh.close() },
        {
          label: title,
          fill: true,
          run() {
            sh.close();
            go2();
          }
        }
      ]
    });
  }
  async function saveAndRun(shown, session) {
    if (busy) return;
    busy = true;
    note = "";
    drawReview();
    try {
      const saved = await ctx.api.post("/apply/plan", {
        keys: reviewKeys
      });
      const want = (shown.job.steps ?? []).map((x) => `${x.key} ${x.command}`);
      const got = (saved.job.steps ?? []).map((x) => `${x.key} ${x.command}`);
      if (want.join("\n") !== got.join("\n")) {
        reviewView = { ...saved, job: { ...saved.job } };
        note = "What would run changed since you looked; nothing ran. Look again.";
        busy = false;
        drawReview();
        return;
      }
      const v = await ctx.api.post("/apply/approve", {
        plan_id: saved.job.id,
        session
      });
      patchJob(v);
      reviewSel.deselect(reviewKeys);
      closeReview();
      jobSeq.next();
      openId = v.job.id;
      open = v;
      stepsShown = STEPS_PAGE;
      ctx.route.go("run", String(v.job.id));
    } catch (err) {
      note = message2(err);
      drawReview();
    } finally {
      busy = false;
      if (active) ctx.setPrimary(primary());
    }
  }
  function refusalCard() {
    const body = h8(
      "div",
      null,
      h8("p", { "data-testid": "plan-refused" }, refusal)
    );
    if (syncing) {
      body.append(
        h8(
          "p",
          { class: "cb-apply-note", role: "status", "data-testid": "syncing" },
          "syncing… the group opens again when the sync is done"
        )
      );
    } else if (syncError) {
      body.append(
        h8(
          "p",
          {
            class: "cb-apply-note",
            role: "status",
            "data-testid": "sync-failed"
          },
          `not synced: ${syncError}`
        )
      );
    }
    const el2 = card2({
      edge: "signal",
      head: "not ready",
      body,
      actions: syncing ? void 0 : [{ label: "sync first", fill: true, run: () => void syncFirst() }]
    });
    el2.dataset.testid = "refusal";
    return el2;
  }
  function paint(doc) {
    const keep = focusSnapshot(readEl);
    readEl.replaceChildren(h8("div", { class: "kit-doc" }, doc));
    focusRestore(readEl, keep);
  }
  function drawOverview() {
    if (!active) return;
    if (mode === "review") {
      if (reviewOpen) return;
      const waitingN = groups.reduce((n, g) => n + waitingCount(g), 0);
      paint(
        h8(
          "article",
          { class: "cb-apply-doc", "data-testid": "review-overview" },
          h8(
            "h1",
            { class: "kit-h1" },
            waitingN ? `${pluralize(waitingN, "decision")} waiting` : "Nothing decided is waiting"
          ),
          h8(
            "p",
            null,
            "Tick items, or a whole group, to review them here: the exact command for each item, where it runs and whether it can be undone. Nothing runs until you press its button there; then it runs in run. This machine applies what is on it; GitHub steps run once, from whichever machine runs them."
          )
        )
      );
      return;
    }
    if (openId !== null) return;
    const o = order();
    const needs = o.running.reduce((n, j) => n + cardsFor(j.id), 0);
    paint(
      h8(
        "article",
        { class: "cb-apply-doc", "data-testid": "run-overview" },
        h8(
          "h1",
          { class: "kit-h1" },
          o.running.length ? `${pluralize(o.running.length, "job")} running` : "Nothing is running"
        ),
        facts([
          ["running", String(o.running.length)],
          ["needs you", String(needs)],
          ["done", String(o.done.length)]
        ]),
        h8(
          "p",
          null,
          "A group's button in review starts a job here. A job's row opens it: each step as it runs, and anything that needs you."
        )
      )
    );
  }
  function drawReview() {
    drawnView = null;
    if (!active || mode !== "review" || !reviewOpen) return;
    const ids = new Set(reviewKeys.map((k) => groupOfKey.get(k) ?? ""));
    const gs = groups.filter((g) => ids.has(g.id));
    const v = reviewView;
    const j = v?.job;
    const runs = !!v && !!j?.steps?.length && !refusal && !reviewNote;
    if (runs) drawnView = v;
    const [first] = v ? runsNow(v.plan).split("\n") : [""];
    const doc = h8(
      "article",
      {
        class: "cb-apply-doc cb-plan",
        "data-testid": "review-group",
        "data-group": gs.map((g) => g.id).join(",")
      },
      ...midHead({
        kick: reviewKick(
          reviewKeys.length,
          gs.map((g) => groupName(g) || g.label)
        ),
        title: j && j.steps?.length ? titleOf(j) : gs.length === 1 ? labelFor(gs[0], reviewKeys.length) : pluralize(reviewKeys.length, "item"),
        ctx: refusal || reviewNote ? "" : first ?? "",
        acts: runs && v ? [runActs(v)] : []
      })
    );
    if (refusal) {
      doc.append(refusalCard());
      return paint(doc);
    }
    if (reviewNote) {
      doc.append(
        h8(
          "p",
          {
            class: "cb-apply-note",
            role: "status",
            "data-testid": "plan-nothing"
          },
          reviewNote
        )
      );
      return paint(doc);
    }
    if (!v || !j) return paint(doc);
    const steps = j.steps ?? [];
    const held2 = v.plan.held_back ?? [];
    const waits = v.plan.waiting ?? [];
    if (!steps.length && !held2.length && !waits.length) {
      doc.append(
        h8(
          "p",
          { "data-testid": "plan-empty" },
          "Nothing in this group runs from this machine: no step is on it, and nothing outward."
        )
      );
      return paint(doc);
    }
    doc.append(planLines(v));
    const agent = runnerAgent() ?? "an agent";
    const parts = (v.groups ?? []).map((x) => ({
      action: x.action,
      lane: x.lane,
      undo: x.undo,
      steps: x.steps ?? []
    }));
    const deletesBranches = steps.some((s) => s.action.startsWith("branch-"));
    const shown = !steps.length ? [] : parts.length ? parts : groupSteps(steps);
    for (const p of shown) {
      const github = p.action === "branch-delete-remote";
      const first2 = p.action === "worktree-remove" && deletesBranches;
      const title = github ? "Delete on GitHub" : first2 ? "Remove worktrees first" : actionTitle(p.action);
      const where = p.lane === "agent" ? `Runs on GitHub, through ${agent}.` : github ? "Runs from this Mac through GitHub, for branches on either Mac; refuses one that moved since it was observed." : first2 ? "Runs here, before their branches: each holds a branch below and is clean." : `Runs here, on ${j.machine}.`;
      doc.append(
        h8(
          "h3",
          { class: "kit-label cb-group-label" },
          h8(
            "span",
            { class: `cb-lanename cb-lanename-${p.lane}` },
            github ? "casebook · github" : laneLabel(p.lane, agent)
          ),
          ` · ${title} · ${p.steps.length}`,
          ...tagEls(stepTags(p.steps), p.steps.length)
        ),
        h8(
          "p",
          { class: "cb-plan-where", "data-testid": "plan-where" },
          where,
          p.undo ? h8(
            "span",
            { class: "cb-plan-undo", "data-testid": "plan-undo" },
            ` ${p.undo}`
          ) : null
        ),
        h8(
          "div",
          {
            class: "kit-table cb-plan-group",
            "data-action": p.action,
            "data-lane": p.lane
          },
          ...p.steps.map(
            (s) => h8(
              "div",
              { class: "kit-tr cb-plan-step", "data-key": s.key },
              h8("span", { class: "cb-step-k" }, keyWithoutKind(s.key)),
              h8(
                "code",
                { class: "cb-cmd", "data-cmd": s.command },
                s.command,
                github && s.expected_tip ? h8(
                  "span",
                  { class: "cb-cmd-if" },
                  ` (if still at ${s.expected_tip.slice(0, 7)})`
                ) : null
              ),
              s.posts && s.comment ? h8("span", { class: "cb-publine" }, publicLine(s)) : null
            )
          )
        )
      );
    }
    drawWaits(doc, waits, steps);
    drawHeld(doc, held2, steps);
    paint(doc);
  }
  function drawWaits(doc, waits, steps) {
    const byMachine = /* @__PURE__ */ new Map();
    for (const w of waits)
      byMachine.set(w.machine, [...byMachine.get(w.machine) ?? [], w]);
    for (const [m, ws] of byMachine) {
      doc.append(
        h8(
          "h3",
          { class: "kit-label cb-group-label cb-wait-h" },
          `Waits for ${m} · ${ws.length}`
        ),
        ...waitBlocks(ws, steps).flatMap((b) => [
          h8("p", { class: "cb-plan-where" }, b.text),
          h8(
            "div",
            {
              class: "kit-table cb-plan-group cb-waits",
              "data-testid": "plan-waits"
            },
            ...b.waits.map(
              (w) => h8(
                "div",
                { class: "kit-tr cb-plan-step" },
                h8("span", { class: "cb-step-k" }, keyWithoutKind(w.key)),
                h8(
                  "span",
                  { class: "cb-cmd" },
                  `on ${m}${w.path ? ` · ${w.path}` : ""}`
                )
              )
            )
          )
        ])
      );
    }
  }
  function drawHeld(doc, held2, steps) {
    if (!held2.length) return;
    doc.append(
      h8(
        "h3",
        { class: "kit-label cb-group-label cb-held-h" },
        `Held · ${held2.length}`
      ),
      h8("p", { class: "cb-plan-where" }, heldText),
      h8(
        "div",
        {
          class: "kit-table cb-plan-group cb-held",
          "data-testid": "plan-held"
        },
        ...held2.map((x) => {
          const holds = x.holds ?? [];
          const links = [];
          for (const hd of holds) {
            if (hd.by)
              links.push(
                h8(
                  "a",
                  { class: "cb-link", href: `#/decide/${pathEscape(hd.by)}` },
                  keyWithoutKind(hd.by)
                )
              );
            else if (hd.kind === "long-lived")
              links.push(
                h8(
                  "a",
                  { class: "cb-link", href: `#/decide/${pathEscape(x.key)}` },
                  "decide again"
                )
              );
          }
          return h8(
            "div",
            { class: "kit-tr cb-plan-step cb-held-row", "data-held": x.key },
            h8("span", { class: "cb-step-k" }, keyWithoutKind(x.key)),
            h8(
              "span",
              { class: "cb-held-why" },
              holds.map((hd) => hd.text).join(" · "),
              ...links.flatMap((a) => [" · ", a]),
              otherHalf(x.key, steps)
            )
          );
        })
      )
    );
  }
  function tagEls(tags, of) {
    return tags.map(
      (t) => h8("span", { class: `cb-tag cb-tag-${t.kind}` }, tagText(t, of))
    );
  }
  function runActs(v) {
    const rc = runCheck();
    return h8(
      "div",
      { class: "cb-run-acts", "data-testid": "run-group" },
      buttons3([
        {
          label: titleOf(v.job),
          fill: true,
          disabled: !rc?.can,
          run: () => runGroup()
        }
      ]),
      rc?.text ? h8(
        "span",
        {
          class: rc.can || busy ? "cb-approve-lab" : "cb-approve-none",
          "data-testid": rc.can || busy ? "runs-through" : "no-agent",
          title: rc.text
        },
        rc.text
      ) : null
    );
  }
  function planLines(v) {
    const steps = v.job.steps ?? [];
    const el2 = h8("div", { class: "cb-approve" });
    const [, rest] = runsNow(v.plan).split("\n");
    if (rest) el2.append(h8("p", { class: "cb-approve-what" }, rest));
    const tags = stepTags(steps);
    if (tags.length)
      el2.append(h8("p", { class: "cb-tags-line" }, ...tagEls(tags, 0)));
    if (note)
      el2.append(h8("p", { class: "cb-apply-note", role: "status" }, note));
    return el2;
  }
  function drawOpen() {
    if (!open || !active || mode !== "run") return;
    const j = open.job;
    if (j.state === "planned" || j.state === "cancelled") {
      paint(
        h8(
          "article",
          { class: "cb-apply-doc cb-job", "data-job": String(j.id) },
          h8("p", { class: "kit-kick" }, `job #${j.id}`),
          h8("h1", { class: "kit-h1" }, titleOf(j)),
          h8(
            "p",
            { class: "cb-approve-none", "data-testid": "never-ran" },
            j.state === "planned" ? "This has not run: its decisions wait in review." : "This was replaced before it ran: nothing in it ran."
          )
        )
      );
      return;
    }
    paint(renderJob(ctx, open, jobHooks));
  }
  function pauseOrResume() {
    if (!open || !isRunning(open.job)) return;
    void act(open.job.paused ? "/jobs/resume" : "/jobs/pause", {
      id: open.job.id
    });
  }
  const jobHooks = {
    agent: (j) => agentOf(j),
    stepsShown: () => stepsShown,
    showMore() {
      stepsShown += STEPS_PAGE;
      drawOpen();
    },
    note: () => note,
    answer(card6, action, text, ok) {
      void act(
        "/jobs/answer",
        { needs_you: card6.id, action, text },
        ok
      );
    },
    undo(step) {
      void act("/jobs/undo", { step: step.id });
    },
    editing: (id) => editors.get(id),
    edit(id, text) {
      if (text === null) editors.delete(id);
      else editors.set(id, text);
    }
  };
  function primary() {
    if (mode === "review") {
      if (refusal)
        return syncing ? null : { label: "Sync first", run: () => void syncFirst() };
      return null;
    }
    if (open && openId !== null && isRunning(open.job)) {
      return open.job.paused ? { label: "Resume", run: pauseOrResume } : { label: "Pause job", run: pauseOrResume };
    }
    return null;
  }
  function feed() {
    if (!active) return;
    if (mode === "run" && open && openId !== null)
      ctx.setAttached({ job: String(openId) }, jobTitle(open.job));
    else ctx.setAttached({});
    ctx.setPrimary(primary());
  }
  const runKey = {
    keys: "a",
    label: "run the open group",
    group: "page",
    run() {
      runGroup();
    }
  };
  const pauseKey = {
    keys: "p",
    label: "pause or resume the open job",
    group: "page",
    run() {
      pauseOrResume();
    }
  };
  const reviewBindings = [runKey];
  const runBindings = [pauseKey];
  function closeJob() {
    jobSeq.next();
    openId = null;
    open = null;
    note = "";
  }
  ctx.onDockTarget(() => {
    askNamedSessions();
    if (reviewView) drawReview();
    if (active) ctx.setPrimary(primary());
  });
  async function loadFilters() {
    try {
      const v = await ctx.api.get("/filters");
      filterRows = v.filters ?? [];
      reviewPane.setFilters(filterRows, reviewQ.filters);
      runPane.setFilters(filterRows, runQ.filters);
    } catch {
    }
  }
  void loadFilters();
  void loadJobs();
  void loadItems();
  void loadSessions();
  void loadSummary();
  const loadVocab = () => {
    getVocab(ctx).then((v) => {
      vocab2 = v;
      paintList();
      drawReview();
    }).catch(() => setTimeout(loadVocab, 2e3));
  };
  loadVocab();
  const jobOf = (type, data) => {
    const d = data ?? {};
    if (type === "job") return d.id ?? null;
    return d.job_id ?? null;
  };
  return {
    id: "apply",
    list: listEl,
    read: readEl,
    listKeys: () => mode === "review" ? { nav: reviewPane.handle, selects: true } : { nav: runPane.handle, selects: false },
    keys: () => mode === "review" ? reviewBindings : runBindings,
    show(sub, query) {
      active = true;
      const was = mode;
      mode = ctx.route.current().section === "run" ? "run" : "review";
      if (was !== mode) note = "";
      showPane();
      if (mode === "review") {
        closeJob();
        const pq = paneQuery(query ?? "");
        if (pq.q !== reviewQ.q || pq.filters.join(",") !== reviewQ.filters.join(",")) {
          reviewQ = pq;
          reviewPane.setFilters(filterRows, pq.filters);
          reviewPane.setSearch(pq.q);
          void loadItems(0, true);
        }
        const group = new URLSearchParams(query ?? "").get("group") ?? "";
        if (group) {
          wantGroup = group;
          setHashQuery(withPane("", reviewQ));
          applyWanted();
        }
        paintList();
        if (reviewOpen) drawReview();
        else if (reviewSel.ids().length) void openTicked();
        feed();
        return;
      }
      wantGroup = "";
      const id = sub ? Number(decodeURIComponent(sub).replace(/^#/, "")) : NaN;
      if (!sub || !Number.isFinite(id)) {
        closeJob();
        paintList();
        feed();
      } else if (id !== openId) {
        openId = id;
        open = null;
        note = "";
        paintList();
        feed();
        void loadJob(id);
      } else {
        paintList();
        if (open) setOpen(open);
        else void loadJob(id);
        feed();
      }
    },
    hide() {
      active = false;
    },
    onLive(type, data) {
      if (type === "job" || type === "step" || type === "needs_you") {
        const about = jobOf(type, data);
        mark((d) => {
          if (about === null) d.all = true;
          else d.jobs.add(about);
        });
      } else if (type === "index" || type === "decided") {
        mark((d) => {
          d.items = true;
          if (type === "index") d.summary = true;
        });
      } else if (type === "sessions") {
        mark((d) => d.sessions = true);
      } else if (type === "gap") {
        mark((d) => {
          d.all = d.items = d.sessions = d.summary = true;
        });
      } else if (type === "filters") {
        void loadFilters().then(() => {
          if (reviewQ.filters.length) mark((d) => d.items = true);
        });
      } else if (type === "sync") {
        onSync(data ?? {});
      }
    },
    primary
  };
}
function stepKeyLines(key) {
  const at2 = key.indexOf("@");
  if (at2 < 0) return [h8("span", { class: "cb-step-k" }, key)];
  return [
    h8("span", { class: "cb-step-repo" }, key.slice(0, at2)),
    h8("span", { class: "cb-step-k" }, key.slice(at2 + 1))
  ];
}
function renderJob(_ctx, v, hooks) {
  const j = v.job;
  const steps = j.steps ?? [];
  const p = progress(j);
  const agent = hooks.agent(j);
  const open = (v.needs_you ?? []).filter((c) => c.state === "open");
  const stepOf = (id) => steps.find((s) => s.id === id);
  const lanes = jobLanes(j).map((l) => laneLabel(l, agent));
  const state = j.paused && isRunning(j) ? "paused" : j.state;
  const doc = h8(
    "article",
    { class: "cb-apply-doc cb-job", "data-job": String(j.id) },
    h8(
      "p",
      { class: "kit-kick" },
      [lanes.join(" + "), `job #${j.id}`, state].filter(Boolean).join(" · ")
    ),
    h8("h1", { class: "kit-h1" }, jobTitle(j))
  );
  const pairs = [
    ["done", `${p.verified} of ${p.total}`],
    ["needs you", String(open.filter((c) => c.kind !== "paused").length)],
    ["paused", String(p.paused)]
  ];
  if (p.skipped) pairs.push(["skipped", String(p.skipped)]);
  if (p.failed) pairs.push(["failed", String(p.failed)]);
  const restores = steps.filter((s) => s.restore).length;
  if (restores) pairs.push(["restore records", String(restores)]);
  doc.append(facts(pairs));
  const cardsEl = h8("div", { class: "cb-needs", "data-testid": "needs-you" });
  for (const c of open)
    cardsEl.append(needsCard(c, stepOf(c.step_id), j, agent, hooks));
  doc.append(cardsEl);
  const note = hooks.note();
  if (note)
    doc.append(h8("p", { class: "cb-apply-note", role: "status" }, note));
  const next = nextSteps(steps);
  const shown = steps.slice(0, hooks.stepsShown());
  doc.append(
    h8("h3", { class: "kit-label" }, "steps"),
    h8(
      "div",
      { class: "kit-table cb-steps", "data-testid": "steps" },
      ...shown.map((s) => {
        const m = stepMark(s, next.has(s.id));
        return h8(
          "div",
          {
            class: "kit-tr cb-step",
            "data-step": String(s.id),
            "data-state": s.state,
            "data-key": s.key
          },
          h8("span", { class: `cb-step-g cb-tone-${m.tone}` }, m.glyph),
          ...stepKeyLines(keyWithoutKind(s.key)),
          h8(
            "span",
            { class: "cb-step-w" },
            h8("span", { class: "cb-step-t" }, m.text),
            s.undoable ? h8(
              "button",
              {
                type: "button",
                class: "kit-btn cb-undo",
                onclick() {
                  hooks.undo(s);
                }
              },
              "undo"
            ) : null
          ),
          m.why ? h8("span", { class: "cb-step-why" }, m.why) : null
        );
      }),
      steps.length > shown.length ? h8(
        "div",
        { class: "kit-tr cb-steps-more" },
        h8("span"),
        h8(
          "span",
          { class: "cb-step-k" },
          `… ${pluralize(steps.length - shown.length, "more step")}`
        ),
        h8(
          "button",
          {
            type: "button",
            class: "cb-link",
            onclick() {
              hooks.showMore();
            }
          },
          "show more"
        )
      ) : null
    )
  );
  return doc;
}
function needsCard(c, step, j, agent, hooks) {
  const key = step ? keyWithoutKind(step.key) : "";
  const verb = step ? actionVerb(step.action) : "run";
  const answer = (action, text = "") => hooks.answer(c, action, text);
  let el2;
  switch (c.kind) {
    case "text": {
      const quote = h8("blockquote", { class: "cb-needs-text" }, c.text);
      const body = h8(
        "div",
        null,
        h8(
          "p",
          { class: "cb-needs-what" },
          h8("code", null, key),
          ` · ${verb} with comment`
        ),
        quote
      );
      const four = [
        {
          label: "post and close",
          fill: true,
          run: () => answer("post-and-close", c.text)
        },
        {
          label: "edit text",
          run() {
            hooks.edit(c.id, c.text);
            startEdit(c.text, true);
          }
        },
        {
          label: "close without comment",
          run: () => answer("close-without-comment")
        },
        { label: "skip", run: () => answer("skip") }
      ];
      el2 = card2({
        edge: "signal",
        head: c.question ? `needs you · ${c.question}` : "needs you",
        body,
        actions: four
      });
      const startEdit = (text, focus) => {
        const field = h8("textarea", {
          class: "cb-needs-edit",
          "aria-label": "comment",
          rows: 4
        });
        field.value = text;
        field.addEventListener("input", () => hooks.edit(c.id, field.value));
        quote.replaceWith(field);
        el2.querySelector(".kit-btns")?.replaceWith(
          buttons3([
            {
              label: "save text",
              fill: true,
              run: () => hooks.answer(
                c,
                "edit-text",
                field.value,
                () => hooks.edit(c.id, null)
              )
            },
            {
              label: "cancel",
              run() {
                hooks.edit(c.id, null);
                field.replaceWith(quote);
                el2.querySelector(".kit-btns")?.replaceWith(buttons3(four));
              }
            }
          ])
        );
        if (focus) field.focus();
      };
      const draft = hooks.editing(c.id);
      if (draft !== void 0) startEdit(draft, false);
      break;
    }
    case "batch":
      el2 = card2({
        edge: "signal",
        head: "needs you · confirm the batch",
        body: h8("p", null, c.question),
        actions: [
          { label: "confirm", fill: true, run: () => answer("confirm") },
          { label: "skip batch", run: () => answer("skip-batch") }
        ]
      });
      break;
    case "failed": {
      const bs = [];
      if (j.session)
        bs.push({
          label: "hand to agent",
          run: () => answer("hand-to-agent")
        });
      bs.push({ label: "skip", run: () => answer("skip") });
      el2 = card2({
        edge: "signal",
        head: `needs you · ${key || "a step"} failed`,
        body: h8(
          "div",
          null,
          h8("p", null, c.question),
          step ? h8("code", { class: "cb-cmd" }, step.command) : null
        ),
        actions: bs
      });
      break;
    }
    case "paused":
      el2 = card2({
        edge: "agent",
        head: `${agent} paused`,
        body: h8(
          "p",
          null,
          key ? h8("code", null, key) : null,
          key ? ": " : "",
          c.question
        ),
        actions: [
          {
            label: `${verb} anyway`,
            danger: dangerVerb(verb),
            run: () => answer("resume")
          },
          { label: "skip", run: () => answer("skip") }
        ]
      });
      break;
    default:
      el2 = card2({
        edge: "signal",
        head: `needs you · ${c.kind}`,
        body: c.question
      });
  }
  el2.classList.add("cb-needs-card");
  el2.dataset.card = String(c.id);
  el2.dataset.kind = c.kind;
  return el2;
}

// decide-list.ts
import {
  createSelection as createSelection2,
  h as h13,
  ApiError as ApiError4
} from "/_kit/kit.js";

// item.ts
import { h as h9, facts as facts2, fold } from "/_kit/kit.js";

// holds-text.ts
function copyRow(c) {
  const label = c.machine || "GitHub";
  if (c.absent) return [label, "not there"];
  const parts = [];
  if (c.path) parts.push(c.path);
  if (c.tip) parts.push(`at ${c.tip.slice(0, 7)}`);
  if (c.worktree) parts.push(`in worktree ${c.worktree}`);
  if (c.head) parts.push("checked out in the clone");
  if (!c.machine && c.landed) parts.push(`landed ${c.landed}`);
  return [label, parts.join(" · ")];
}
function choiceTags(kind, disposition) {
  if (kind === "repo" && disposition === "delete" || kind === "pr" && disposition === "merge")
    return ["permanent"];
  if ((kind === "pr" || kind === "issue") && disposition === "close" || kind === "repo" && disposition === "archive")
    return ["github-undo"];
  return [];
}

// item.ts
var BODY_CAP = 600;
function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}
function fmtShortDate(s) {
  if (!s)
    return "def";
  const d = new Date(s);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}
function renderEvidence(evs) {
  const section = h9("section", { class: "cb-evidence" });
  section.append(h9("h3", { class: "kit-label" }, "evidence"));
  if (evs.length === 0) {
    section.append(h9("p", { class: "cb-empty" }, "no evidence"));
    return section;
  }
  for (const ev of evs) {
    const authorEl = ev.author ? h9("span", { class: "cb-evidence-author" }, ev.author + " ") : null;
    const time = h9(
      "span",
      { class: "cb-muted" },
      ` · ${fmtShortDate(ev.created_at)}`
    );
    const item = h9(
      "div",
      { class: "cb-evidence-item" },
      h9(
        "p",
        { class: "cb-evidence-meta" },
        ...authorEl ? [authorEl] : [],
        ev.text,
        time
      )
    );
    section.append(item);
  }
  return section;
}
function renderHistory(events, decisions, ownKey) {
  const section = h9("section", { class: "cb-history" });
  section.append(h9("h3", { class: "kit-label" }, "history"));
  if (events.length === 0 && decisions.length === 0) {
    section.append(h9("p", { class: "cb-empty" }, "no history"));
    return section;
  }
  for (const entry of decisions) {
    const display = stripOwnKey(entry.Subject, ownKey);
    section.append(
      h9(
        "div",
        { class: "cb-history-item cb-history-decision" },
        h9("span", { class: "cb-history-time" }, fmtShortDate(entry.Time)),
        h9("span", { class: "cb-history-msg" }, display)
      )
    );
  }
  for (const ev of events) {
    const label = ev.actions && ev.actions.length > 0 ? ev.actions.map((a) => a.hook ?? "").filter(Boolean).join(", ") : ev.hook ?? ev.src;
    section.append(
      h9(
        "div",
        { class: "cb-history-item" },
        h9("span", { class: "cb-history-time" }, fmtShortDate(ev.ts)),
        h9("span", { class: "cb-history-msg" }, label)
      )
    );
  }
  return section;
}
function renderDecideRow(ctx, detail, hooks) {
  const it = detail.item;
  const section = h9("section", { class: "cb-decide", role: "group" });
  const pending = it.proposal && it.proposal.state === "pending" ? it.proposal : null;
  const tag = (kind, text) => h9("span", { class: `cb-tag cb-tag-${kind}` }, text);
  const cards = renderChoices(ctx, it.kind, {
    recommended: pending?.disposition,
    chosen: it.decision?.disposition,
    note: it.decision?.note,
    onPick(d, until, note) {
      hooks.decide?.(d, until, note);
    },
    onCards(grid) {
      const tagged = [];
      for (const card6 of grid.querySelectorAll(
        ".cb-choice[data-d]"
      )) {
        const kinds = choiceTags(it.kind, card6.dataset.d ?? "");
        if (!kinds.length) continue;
        tagged.push(
          h9(
            "span",
            { class: "cb-choice-tagged" },
            card6.querySelector(".cb-choice-label")?.textContent ?? "",
            ...kinds.map((k) => tag(k, tagText({ kind: k, n: 1 }, 1)))
          )
        );
      }
      if (tagged.length) tagsLine.replaceChildren(...tagged);
      tagsLine.hidden = !tagged.length;
      hooks.cardsReady?.();
    }
  });
  const tagsLine = h9("p", { class: "cb-choice-tags", hidden: true });
  cards.querySelector(".cb-choices")?.classList.add("cb-decide-row");
  cards.querySelector(".cb-choices")?.after(tagsLine);
  cards.querySelector(".cb-close-comment .kit-btn.fill")?.after(
    tag(
      "posts",
      `posts a public comment${it.public ? " · on a public repo" : ""}`
    )
  );
  section.append(cards);
  void getVocab(ctx).then((vocab2) => {
    const kv = (vocab2.kinds ?? []).find((k) => k.kind === it.kind);
    section.setAttribute("aria-label", kv?.question ?? "");
  });
  return section;
}
function renderRec(ctx, detail, hooks) {
  const it = detail.item;
  const p = it.proposal && it.proposal.state === "pending" ? it.proposal : null;
  if (!p) return null;
  const who = h9("p", { class: "cb-rec-who" });
  const label = h9("p", { class: "cb-rec-label" }, p.disposition);
  const el2 = h9(
    "section",
    { class: "cb-rec" },
    who,
    label,
    p.note ? h9("p", { class: "cb-rec-note" }, p.note) : null,
    p.until ? h9("p", { class: "cb-rec-until" }, `until ${p.until}`) : null
  );
  void getVocab(ctx).then((vocab2) => {
    const kv = (vocab2.kinds ?? []).find((k) => k.kind === it.kind);
    const rec = asNotNow(p.disposition);
    label.textContent = kv?.choices?.find((c) => c.disposition === rec)?.label ?? p.disposition;
    who.textContent = recommendsWho(
      vocab2,
      p.source,
      hooks.sourceName?.(p.source) ?? ""
    );
  });
  return el2;
}
function renderHolds(detail) {
  const holds = detail.item.holds ?? [];
  if (!holds.length) return null;
  return h9(
    "section",
    { class: "cb-hold" },
    h9("p", { class: "cb-hold-who" }, "in the way"),
    ...holds.flatMap((hd) => [
      h9(
        "p",
        { class: "cb-hold-line" },
        hd.text,
        hd.by ? h9(
          "a",
          { class: "cb-link", href: `#/decide/${pathEscape(hd.by)}` },
          keyWithoutKind(hd.by)
        ) : null
      ),
      hd.fix ? h9("p", { class: "cb-hold-sub" }, hd.fix) : null
    ])
  );
}
function renderWhere(detail) {
  const copies = detail.item.copies ?? [];
  if (!copies.length) return null;
  return h9(
    "section",
    { class: "cb-where" },
    h9("h3", { class: "kit-label" }, "where it is"),
    ...copies.map((c) => {
      const [label, text] = copyRow(c);
      return h9(
        "div",
        { class: c.absent ? "cb-wrow cb-wno" : "cb-wrow" },
        h9("span", { class: "cb-wm" }, label),
        h9("span", null, text)
      );
    })
  );
}
function cameBack(vocab2, it) {
  const status = vocab2.came_back?.[it.status ?? ""];
  if (status) return it.due_reason || status;
  return it.new_activity ? it.due_reason ?? "" : "";
}
function renderItem(ctx, detail, hooks = {}) {
  const it = detail.item;
  const el2 = h9("article", { class: "cb-item", dataset: { key: it.key } });
  const displayKey = keyWithoutKind(it.key);
  const keyEl = it.url ? h9("a", { href: it.url, target: "_blank", rel: "noopener" }, displayKey) : displayKey;
  const kicker = h9("p", { class: "cb-kicker kit-kick" });
  const parts = [it.kind, keyEl, it.relation].filter(
    (part) => !!part
  );
  parts.forEach((part, i) => {
    if (i > 0) kicker.append(" · ");
    kicker.append(part);
  });
  el2.append(kicker);
  const title = it.title ?? keyWithoutKind(it.key);
  el2.append(h9("h1", { class: "cb-title kit-h1", title }, title));
  const factPairs = [];
  if (it.status)
    factPairs.push([
      "status",
      detail.done_how ? `${it.status}: ${detail.done_how}` : it.status
    ]);
  if (it.repo) factPairs.push(["repo", it.repo]);
  if (it.author)
    factPairs.push(["author", it.author + (it.author_is_bot ? " (bot)" : "")]);
  if (it.created_at) factPairs.push(["opened", fmtDate(it.created_at)]);
  if (it.updated_at) factPairs.push(["updated", fmtDate(it.updated_at)]);
  if (it.labels && it.labels.length > 0)
    factPairs.push(["labels", it.labels.join(", ")]);
  if (it.landed) factPairs.push(["landed", it.landed_how ?? it.landed]);
  const factsEl = facts2(factPairs);
  factsEl.title = factsEl.textContent ?? "";
  el2.append(factsEl);
  void getVocab(ctx).then((vocab2) => {
    const why = cameBack(vocab2, it);
    if (!why) return;
    const line = vocab2.came_back_fact.replaceAll("{reason}", why);
    factsEl.prepend(h9("span", { class: "cb-came-back", title: line }, line));
    factsEl.title = factsEl.textContent ?? "";
  });
  el2.append(renderDecideRow(ctx, detail, hooks));
  const looking = lookingLine(it.looking);
  const reading = h9(
    "div",
    { class: "cb-reading" },
    h9("p", { class: "cb-looking", hidden: !looking }, looking),
    renderHolds(detail),
    renderWhere(detail),
    renderRec(ctx, detail, hooks)
  );
  if (it.body) {
    const excerpt = it.body.slice(0, BODY_CAP);
    const rest = it.body.slice(BODY_CAP);
    reading.append(
      h9(
        "section",
        { class: "cb-body" },
        h9("p", null, excerpt),
        rest ? fold("read more", h9("p", null, rest)) : null
      )
    );
  }
  reading.append(
    h9(
      "div",
      { class: "cb-trail" },
      renderEvidence(detail.evidence ?? []),
      renderHistory(detail.history ?? [], detail.decisions ?? [], it.key)
    )
  );
  el2.append(reading);
  return h9("div", { class: "kit-doc cb-item-doc" }, hooks.nav ?? null, el2);
}

// proposals.ts
import { sheet as sheet3, h as h10 } from "/_kit/kit.js";
function openDiscardSheet(ctx, vocab2, n, view, body, onDone) {
  let submitting = false;
  let sh = null;
  const errEl = h10("p", { class: "cb-sheet-err" });
  errEl.hidden = true;
  async function doDiscard() {
    if (submitting) return;
    submitting = true;
    errEl.hidden = true;
    try {
      const r = await ctx.api.post("/proposals/withdraw", body);
      sh?.close();
      onDone(r.withdrawn);
    } catch (err) {
      errEl.textContent = err instanceof Error ? err.message : "discard failed, try again";
      errEl.hidden = false;
      submitting = false;
    }
  }
  sh = sheet3({
    title: vocab2.discard_title,
    body: h10(
      "div",
      { class: "cb-sheet-body cb-discard-confirm" },
      h10("p", { class: "cb-discard-says" }, discardConfirm(vocab2, n, view)),
      errEl
    ),
    actions: [
      {
        label: vocab2.discard_button,
        fill: true,
        run() {
          void doDiscard();
        }
      },
      {
        label: vocab2.discard_cancel,
        run() {
          sh?.close();
        }
      }
    ],
    onClose() {
      sh = null;
    }
  });
}

// rule-editor.ts
import { h as h11, ApiError as ApiError3 } from "/_kit/kit.js";

// menu-nav.ts
function menuNav(menu, selector, opener, close) {
  const items = () => [...menu.querySelectorAll(selector)];
  const rove = (to) => {
    for (const it of items()) it.tabIndex = it === to ? 0 : -1;
  };
  menu.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t.matches(selector)) rove(t);
  });
  menu.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const list2 = items();
    if (!list2.length) return;
    const at2 = list2.indexOf(document.activeElement);
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = at2 < 0 ? 0 : (at2 + 1) % list2.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = at2 < 0 ? list2.length - 1 : (at2 - 1 + list2.length) % list2.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list2.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    rove(list2[next]);
    list2[next].focus();
  });
  menu.addEventListener("focusout", (e) => {
    if (menu.hidden) return;
    const to = e.relatedTarget;
    if (to && (menu.contains(to) || to === opener)) return;
    close();
  });
}

// rule-editor.ts
var KINDS = ["repo", "pr", "issue", "branch", "worktree"];
var OFFERED = (d) => d !== "wait" && d !== "watch";
function message3(err) {
  return err instanceof Error ? err.message : String(err);
}
function dispositionLabel(vocab2, types, d) {
  let best = "";
  for (const k of types ?? KINDS) {
    const kv = vocab2?.kinds?.find((x) => x.kind === k);
    const c = kv?.choices?.find((x) => x.disposition === d);
    if (c && (!best || c.label.length < best.length)) best = c.label;
  }
  return best || d;
}
function ruleMenu(row, hooks) {
  const id = row.rule.id;
  const off = row.rule.status !== "active";
  const more = h11("button", {
    type: "button",
    class: "cb-filter-more cb-rule-more",
    "aria-label": `${row.rule.name || id}: edit, turn ${off ? "on" : "off"}`,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    onclick(e) {
      e.stopPropagation();
      setMenu(menu.hidden);
    }
  });
  more.textContent = "⋯";
  const item = (label, run) => h11(
    "button",
    {
      type: "button",
      class: "cb-filter-menu-item",
      role: "menuitem",
      "data-act": label,
      onclick(e) {
        e.stopPropagation();
        setMenu(false);
        run();
      }
    },
    label
  );
  const menu = h11(
    "div",
    { class: "cb-filter-menu", role: "menu", hidden: true },
    item("edit", () => hooks.onEdit()),
    item(off ? "turn on" : "turn off", () => hooks.onToggle())
  );
  const onEsc = (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(false);
    more.focus();
  };
  const onAway = (e) => {
    if (!wrap.contains(e.target)) setMenu(false);
  };
  function setMenu(open) {
    menu.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    if (open) {
      document.addEventListener("keydown", onEsc, true);
      document.addEventListener("mousedown", onAway, true);
      menu.querySelector(".cb-filter-menu-item")?.focus();
    } else {
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("mousedown", onAway, true);
    }
  }
  menuNav(menu, ".cb-filter-menu-item", more, () => setMenu(false));
  const wrap = h11(
    "span",
    { class: "cb-filter-item cb-rule-menu", "data-id": id },
    more,
    menu
  );
  return wrap;
}
async function toggleRule(ctx, row) {
  const off = row.rule.status !== "active";
  await ctx.api.post(off ? "/rules/activate" : "/rules/deactivate", {
    id: row.rule.id
  });
}
function makeRuleRow(_ctx, hooks) {
  const chipsEl = h11("div", {
    class: "kit-chips cb-filter-chips",
    "data-group": "rules"
  });
  const addBtn = h11(
    "button",
    {
      type: "button",
      class: "kit-chip cb-filter-add",
      "data-testid": "new-rule",
      onclick() {
        hooks.onNew();
      }
    },
    "+ rule"
  );
  const el2 = h11(
    "div",
    { class: "cb-filters cb-rule-row", "aria-label": "rules" },
    h11("span", { class: "cb-bar-label" }, "rules"),
    chipsEl
  );
  function chip(row, selected) {
    const id = row.rule.id;
    const on = selected === id;
    const off = row.rule.status !== "active";
    const b = h11(
      "button",
      {
        type: "button",
        class: "kit-chip cb-rule-chip" + (on ? " on" : "") + (off ? " cb-rule-off" : ""),
        "data-id": id,
        "aria-pressed": String(on),
        title: off ? "off" : "",
        onclick() {
          hooks.onSelect(on ? null : id);
        }
      },
      row.rule.name || id
    );
    if (row.invalid) {
      b.setAttribute("data-invalid", "");
      b.title = row.invalid;
    }
    return b;
  }
  function paint(rows, selected) {
    chipsEl.replaceChildren(...rows.map((r) => chip(r, selected)), addBtn);
  }
  paint([], null);
  return { el: el2, paint };
}
function ruleEditor(ctx, row, seed, hooks) {
  let match = (row?.rule.match ?? seed?.match ?? []).map((c) => ({
    ...c
  }));
  let disposition = row?.rule.propose.disposition ?? "";
  let vocab2 = null;
  let offered = [];
  let kinds = null;
  let seq = 0;
  const dispEl = h11("span", {
    class: "cb-cond-picks cb-rule-disps",
    role: "group",
    "aria-label": "what it proposes"
  });
  const note = h11("input", {
    class: "cb-filter-name cb-rule-propose-note",
    type: "text",
    placeholder: "note, e.g. landed {how}; nothing unpushed",
    "aria-label": "note"
  });
  note.value = row?.rule.propose.note ?? "";
  const proposeErr = h11("p", { class: "cb-filter-name-err", hidden: true });
  function paintDisps() {
    const types = kinds ?? typesOf(match, KINDS);
    dispEl.replaceChildren(
      ...offered.map(
        (d) => h11(
          "button",
          {
            type: "button",
            class: "kit-chip cb-cond-pick" + (d === disposition ? " on" : "") + (DANGER_DISPS.has(d) ? " cb-rule-danger" : ""),
            "data-value": d,
            "aria-pressed": String(d === disposition),
            onclick() {
              disposition = d;
              proposeErr.hidden = true;
              paintDisps();
            }
          },
          dispositionLabel(vocab2, types, d)
        )
      )
    );
    if (!offered.length) {
      dispEl.append(
        h11(
          "span",
          { class: "cb-rule-hint" },
          "add a condition to see what it can propose"
        )
      );
    }
  }
  async function refreshOffered() {
    const mine = ++seq;
    const done = match.filter((c) => c.value.trim() !== "");
    if (!done.length) {
      offered = [];
      paintDisps();
      return;
    }
    try {
      const p = await ctx.api.post("/rules/preview?limit=0", {
        match: done
      });
      if (mine !== seq) return;
      offered = (p.dispositions ?? []).filter(
        (d) => OFFERED(d) || d === row?.rule.propose.disposition
      );
      kinds = p.kinds ?? null;
      if (disposition && !offered.includes(disposition)) disposition = "";
      paintDisps();
    } catch {
    }
  }
  const editor = conditionEditor(
    ctx,
    { match, status: "draft" },
    (m) => {
      match = m;
      hooks.onDraft(match);
      void refreshOffered();
    }
  );
  if (row?.invalid) {
    setConditionError(editor, conditionErrorIndex(row.invalid), row.invalid);
  }
  const name = h11("input", {
    class: "cb-filter-name",
    type: "text",
    placeholder: "name",
    "aria-label": "rule name",
    onkeydown(e) {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void save();
      }
    }
  });
  name.value = row?.rule.name ?? seed?.name ?? "";
  const nameErr = h11("p", { class: "cb-filter-name-err", hidden: true });
  const showNameError = (msg) => {
    nameErr.hidden = msg === null;
    nameErr.textContent = msg ?? "";
  };
  function showError(err) {
    if (err === null) {
      if (!row?.invalid || match.length) setConditionError(editor, -1, null);
      return;
    }
    const msg = message3(err);
    setConditionError(editor, conditionErrorIndex(msg), msg);
  }
  async function save() {
    const n = name.value.trim();
    const id = row ? row.rule.id : slug(n);
    showNameError(null);
    proposeErr.hidden = true;
    if (!disposition) {
      proposeErr.textContent = "choose what the rule proposes";
      proposeErr.hidden = false;
      return;
    }
    const until = row && disposition === row.rule.propose.disposition ? row.rule.propose.until : void 0;
    try {
      await ctx.api.post(
        row ? `/rules/save${version ? `?version=${encodeURIComponent(version)}` : ""}` : "/rules/save?create=1",
        {
          id,
          name: n,
          match,
          propose: { disposition, note: note.value.trim(), until }
        }
      );
      hooks.onSaved(id);
    } catch (err) {
      const msg = message3(err);
      if (err instanceof ApiError3 && err.status === 409) {
        showNameError(msg);
        return;
      }
      const i = conditionErrorIndex(msg);
      if (i < 0 && /name|rule id/.test(msg)) {
        showNameError(msg);
        return;
      }
      if (i < 0 && /propose|disposition/.test(msg)) {
        proposeErr.textContent = msg;
        proposeErr.hidden = false;
        return;
      }
      setConditionError(editor, i, msg);
    }
  }
  const el2 = h11(
    "div",
    { class: "kit-doc" },
    h11(
      "article",
      { class: "cb-filter-edit", "data-testid": "rule-editor" },
      h11(
        "h1",
        { class: "kit-h1 cb-filter-title" },
        row ? `edit ${row.rule.name || row.rule.id}` : "new rule"
      ),
      h11(
        "div",
        { class: "cb-filter-acts" },
        name,
        h11(
          "button",
          {
            type: "button",
            class: "kit-btn fill cb-filter-save",
            onclick() {
              void save();
            }
          },
          "save"
        ),
        h11(
          "button",
          {
            type: "button",
            class: "kit-btn cb-filter-cancel",
            onclick() {
              hooks.onCancel();
            }
          },
          "cancel"
        )
      ),
      nameErr,
      h11(
        "div",
        { class: "cb-rule-propose" },
        h11("span", { class: "cb-rule-propose-l" }, "propose"),
        dispEl,
        note
      ),
      proposeErr,
      h11(
        "p",
        { class: "cb-rule-hint" },
        "Saving turns it on: matching items get this recommendation now and after every sync. Nothing is decided until you accept it."
      ),
      editor
    )
  );
  void getVocab(ctx).then((v) => {
    vocab2 = v;
    paintDisps();
  });
  void refreshOffered();
  let version = "";
  if (row)
    void ctx.api.get("/rule", { id: row.rule.id }).then((d) => {
      version = d.version;
    }).catch(() => {
    });
  return { el: el2, showError };
}

// rules.ts
import { h as h12, facts as facts3, buttons as buttons4, card as card3, sheet as sheet4 } from "/_kit/kit.js";
var PREVIEW_DEBOUNCE_MS = 300;
var PAGE2 = 200;
function message4(err) {
  return err instanceof Error ? err.message : String(err);
}
function renderRule(ctx, detail, hooks) {
  const rule = detail.rule;
  const id = rule.id;
  const off = rule.status !== "active";
  let exclude = rule.exclude ?? [];
  let preview = detail.matches;
  let shown = preview.page ?? [];
  let grouped = false;
  let seq = 0;
  const doc = h12("article", {
    class: "cb-rule",
    "data-rule": id,
    "data-status": rule.status
  });
  doc.toggleAttribute("data-invalid", !!detail.invalid);
  const el2 = h12("div", { class: "kit-doc" }, doc);
  let factsEl = h12("div");
  const heading = h12("h3", { class: "kit-label cb-matches-label" });
  const groupChips = h12("span", { class: "cb-matches-view" });
  const matchesEl = h12("div", {
    class: "kit-table cb-matches",
    "data-testid": "matches"
  });
  const note = h12("p", { class: "cb-rule-note", role: "status" });
  function drawFacts() {
    const who = authorOf(rule.created_by);
    const byEl = h12("b", who.agent ? { class: "cb-by-agent" } : null, who.name);
    const rows = [
      [
        "status",
        `${off ? "off" : "on"}${detail.invalid ? " · not valid" : ""}`
      ],
      ["matches", String(preview.total)],
      ["excluded", String(exclude.length)],
      ["by", byEl]
    ];
    const rec = trackRecord(detail.record);
    if (rec) rows.push(["record", rec]);
    const next = facts3(rows);
    factsEl.replaceWith(next);
    factsEl = next;
  }
  const invalidEl = detail.invalid ? card3({
    edge: "signal",
    head: "not valid",
    body: h12(
      "div",
      null,
      h12("p", { class: "cb-invalid-msg" }, detail.invalid),
      h12(
        "p",
        { class: "cb-invalid-help" },
        "casebook recommends nothing from this rule until it is valid. Edit it to fix it."
      )
    )
  }) : h12("div");
  const p = rule.propose;
  const tr = (label, value) => h12(
    "div",
    { class: "kit-tr" },
    h12("span", { class: "cb-cond-f" }, label),
    h12("span"),
    value
  );
  const dispEl = h12(
    "span",
    {
      class: "cb-cond-v cb-disp-ro" + (DANGER_DISPS.has(p.disposition) ? " cb-danger" : ""),
      "data-value": p.disposition
    },
    p.disposition
  );
  void getVocab(ctx).then((vocab2) => {
    dispEl.textContent = dispositionLabel(
      vocab2,
      preview.kinds ?? null,
      p.disposition
    );
  }).catch(() => {
  });
  const proposeEl = h12(
    "div",
    { class: "kit-table cb-propose", "data-testid": "propose" },
    tr("decision", dispEl),
    p.until ? tr("until", h12("span", { class: "cb-cond-v" }, p.until)) : null,
    p.note ? tr("note", h12("span", { class: "cb-cond-v" }, p.note)) : null
  );
  function box(on, label, run) {
    return h12("span", {
      class: "kit-box",
      role: "checkbox",
      tabindex: 0,
      "aria-checked": String(on),
      "aria-label": label,
      onclick(e) {
        e.stopPropagation();
        run();
      },
      onkeydown(e) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          run();
        }
      }
    });
  }
  function matchRow(m) {
    const why = m.reason === "matched" ? m.title || m.status : m.reason.toLowerCase();
    return h12(
      "div",
      { class: "cb-mr on", "data-key": m.key, title: m.title || m.key },
      box(true, `exclude ${m.key}`, () => untick(m.key)),
      h12("span", { class: "cb-mr-k" }, keyWithoutKind(m.key)),
      h12("span", { class: "cb-mr-w" }, why)
    );
  }
  function excludedRow(x) {
    return h12(
      "div",
      { class: "cb-mr x", "data-key": x.key },
      box(false, `include ${x.key}`, () => void include(x.key)),
      h12("span", { class: "cb-mr-k" }, keyWithoutKind(x.key)),
      h12(
        "span",
        { class: "cb-mr-w" },
        x.reason ? `excluded · ${x.reason}` : "excluded"
      )
    );
  }
  function waitRow(text) {
    return h12(
      "div",
      { class: "cb-mr cb-mr-wait" },
      h12("span"),
      h12("span", { class: "cb-mr-k" }, text),
      h12("span")
    );
  }
  function drawMatches() {
    heading.textContent = matchesHeading(preview.total, preview.by_reason);
    const out = [];
    if (grouped) {
      const rest = [...shown];
      for (const g of preview.groups ?? []) {
        const mine = rest.filter((m) => (m.repo || m.key) === g.repo);
        for (const m of mine) rest.splice(rest.indexOf(m), 1);
        const why = reasonSummary(g.reasons);
        out.push(
          h12(
            "div",
            { class: "cb-mgroup", "data-repo": g.repo },
            h12("span", { class: "cb-mgroup-repo" }, g.repo),
            h12(
              "span",
              { class: "cb-mr-w" },
              String(g.count) + (why ? ` · ${why}` : "")
            )
          ),
          ...mine.map(matchRow)
        );
      }
      out.push(...rest.map(matchRow));
    } else {
      out.push(...shown.map(matchRow));
    }
    out.push(...exclude.map(excludedRow));
    const more = preview.total - shown.length;
    if (more > 0) {
      out.push(
        h12(
          "div",
          { class: "cb-mr cb-mr-more" },
          h12("span"),
          h12("span", { class: "cb-mr-k" }, `… ${more} more`),
          h12(
            "button",
            {
              type: "button",
              class: "cb-link",
              onclick() {
                void loadMore();
              }
            },
            `show ${Math.min(PAGE2, more)} more`
          )
        )
      );
    }
    if (out.length === 0) out.push(waitRow("nothing matches now"));
    matchesEl.replaceChildren(...out);
  }
  function drawGroupChips() {
    const chip = (label, on) => h12(
      "button",
      {
        type: "button",
        class: "kit-chip" + (on ? " on" : ""),
        "aria-pressed": String(on),
        onclick() {
          grouped = label === "by repo";
          drawGroupChips();
          drawMatches();
        }
      },
      label
    );
    groupChips.replaceChildren(
      chip("list", !grouped),
      chip("by repo", grouped)
    );
  }
  async function loadMore() {
    const from = shown.length;
    const mine = seq;
    try {
      const p2 = await ctx.api.post(
        `/rules/preview?offset=${from}&limit=${PAGE2}`,
        { ...rule, exclude }
      );
      if (mine !== seq || shown.length !== from) return;
      shown = [...shown, ...p2.page ?? []];
      preview = { ...p2, page: shown };
      drawMatches();
    } catch (err) {
      note.textContent = `more matches failed: ${message4(err)}`;
    }
  }
  function applyExclusions(d) {
    seq++;
    exclude = d.rule.exclude ?? [];
    preview = d.matches;
    shown = preview.page ?? [];
    drawMatches();
    drawFacts();
    hooks.onChanged?.();
  }
  function untick(key) {
    const reason = h12("input", {
      class: "kit-note",
      type: "text",
      placeholder: "reason (optional)",
      "aria-label": "reason"
    });
    const err = h12("p", { class: "cb-sheet-err", hidden: true });
    let sending = false;
    const go2 = async () => {
      if (sending) return;
      sending = true;
      try {
        const d = await ctx.api.post("/rules/exclude", {
          id,
          key,
          reason: reason.value.trim()
        });
        sh.close();
        applyExclusions(d);
      } catch (e) {
        err.textContent = message4(e);
        err.hidden = false;
        sending = false;
      }
    };
    reason.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void go2();
      }
    });
    const sh = sheet4({
      title: `exclude ${keyWithoutKind(key)}`,
      body: h12(
        "div",
        { class: "cb-sheet-body" },
        h12(
          "p",
          { class: "cb-sheet-preview" },
          "This rule skips it from now on. It stays listed here, unticked."
        ),
        h12(
          "div",
          { class: "cb-sheet-row" },
          h12("label", { class: "cb-sheet-label" }, "reason"),
          reason
        ),
        err
      ),
      actions: [
        { label: "exclude", fill: true, run: () => void go2() },
        { label: "cancel", run: () => sh.close() }
      ]
    });
    sh.el.dataset.testid = "exclude-sheet";
    reason.focus();
  }
  async function include(key) {
    try {
      const d = await ctx.api.post("/rules/include", {
        id,
        key
      });
      applyExclusions(d);
    } catch (err) {
      note.textContent = `not included: ${message4(err)}`;
    }
  }
  const bs = [
    { label: "edit", run: () => hooks.onEdit() },
    {
      label: off ? "turn on" : "turn off",
      run: () => {
        note.textContent = "";
        void hooks.onToggle(off).catch((err) => {
          note.textContent = message4(err);
        });
      }
    }
  ];
  const actionsEl = h12("div", { class: "cb-rule-actions" }, buttons4(bs), note);
  doc.replaceChildren(
    h12("p", { class: "kit-kick" }, `rule · ${off ? "off" : "on"}`),
    h12("h1", { class: "kit-h1" }, rule.name || id),
    factsEl,
    h12(
      "p",
      null,
      off ? "Off: it recommends nothing until you turn it on." : "On: undecided items that match get this recommendation, now and after every sync. Nothing is decided until you accept it."
    ),
    invalidEl,
    h12("h3", { class: "kit-label" }, "when an undecided item matches all of"),
    conditionEditor(
      ctx,
      { match: rule.match, status: rule.status, editable: false },
      () => {
      }
    ),
    h12("h3", { class: "kit-label" }, "recommend"),
    proposeEl,
    h12("div", { class: "cb-matches-head" }, heading, groupChips),
    matchesEl,
    actionsEl
  );
  drawFacts();
  drawGroupChips();
  drawMatches();
  return el2;
}

// decide-list.ts
var STRIP_MS = 6e3;
var SUGGEST_RULES = "Please suggest rules for the items in the attached list: look at what they have in common and draft rules (casebook_rule_save) that would recommend a decision for many of them at once. Recommend nothing item by item.";
var PAGE_SIZE = 200;
var selection = createSelection2();
function emptyFilters() {
  return { filters: [], rule: null, q: "" };
}
var LEFT_OPEN = "left-open";
var GROUPING = "casebook.grouping";
function storedFlat() {
  try {
    return localStorage.getItem(GROUPING) === "flat";
  } catch {
    return false;
  }
}
function storeFlat(flat) {
  try {
    localStorage.setItem(GROUPING, flat ? "flat" : "grouped");
  } catch {
  }
}
function isLeftOpen(it) {
  return it.status === "left-open";
}
function makeDecide(ctx) {
  const readEl = h13("div", { class: "kit-read" });
  let offset = 0;
  let totalItems = 0;
  let loadedItems = [];
  const filters = emptyFilters();
  let flat = storedFlat();
  let reloading = false;
  let loadingMore = false;
  let loads = 0;
  let totalItemsForView = 0;
  let groups = [];
  const opened = /* @__PURE__ */ new Set();
  const groupOfKey = /* @__PURE__ */ new Map();
  const proposalOfKey = /* @__PURE__ */ new Map();
  const busyGroups = /* @__PURE__ */ new Set();
  let leftOpen = [];
  let leftOpenTotal = 0;
  let shown = [];
  let currentOpenKey = null;
  let shownDetail = null;
  let lastOrder = [];
  let deciding = null;
  let lastUndo = [];
  let vocab2 = null;
  let syncingOpen = false;
  const discardAllBtn = h13("button", {
    class: "kit-btn cb-discard-all",
    type: "button",
    hidden: true,
    onclick() {
      discardView();
    }
  });
  function renderReadEmpty() {
    const prompt = h13(
      "p",
      { class: "cb-read-empty-prompt" },
      "Select an item to see it here."
    );
    if (!vocab2)
      return h13(
        "div",
        { class: "cb-read-empty", "data-testid": "decide-summary" },
        prompt
      );
    const [head, ...rest] = decideSummary(
      groups,
      totalItemsForView,
      ruleRows,
      vocab2
    );
    discardAllBtn.hidden = viewRecs === 0 || !vocab2 || draft !== null;
    if (vocab2)
      discardAllBtn.textContent = vocab2.discard_all.replaceAll(
        "{n}",
        String(viewRecs)
      );
    return h13(
      "div",
      { class: "cb-read-empty", "data-testid": "decide-summary" },
      h13("p", { class: "cb-read-empty-count" }, head ?? ""),
      h13(
        "ul",
        { class: "cb-summary-lines" },
        ...rest.map((l) => h13("li", null, l))
      ),
      discardAllBtn,
      prompt
    );
  }
  function updateReadEmptyCount() {
    const old = readEl.querySelector(
      ':scope > [data-testid="decide-summary"]'
    );
    if (old) old.replaceWith(renderReadEmpty());
  }
  let active = false;
  function feedAttached() {
    if (!active) return;
    const ids = selection.ids();
    if (ids.length > 0) ctx.setAttached({ keys: ids });
    else if (currentOpenKey) ctx.setAttached({ open: currentOpenKey });
    else if (draft !== null && editing === "rule" && editingId)
      ctx.setAttached({ rule: editingId, list: listAttached() });
    else if (draft === null && filters.rule)
      ctx.setAttached({ rule: filters.rule });
    else ctx.setAttached({ list: listAttached() });
  }
  function listAttached(group = "") {
    const l = {};
    if (draft !== null) l.match = JSON.stringify(draft);
    else if (filters.filters.length) l.filters = [...filters.filters];
    if (draft === null && filters.rule) l.rule = filters.rule;
    if (filters.q) l.q = filters.q;
    if (group) l.group = group;
    return l;
  }
  function showReadEmpty() {
    currentOpenKey = null;
    shownDetail = null;
    const rr = filters.rule && draft === null ? ruleRows.find((r) => r.rule.id === filters.rule) : void 0;
    const fr = draft === null && !filters.rule ? filterShown() : void 0;
    readEl.replaceChildren(renderReadEmpty());
    if (rr) void showRuleDoc(rr);
    else if (fr) showFilterDoc(fr);
    feedAttached();
  }
  let shownFilter = null;
  function filterShown() {
    const sel = filters.filters;
    const clicked = filterRows.find((r) => r.filter.id === shownFilter);
    if (clicked && (clicked.invalid || sel.includes(clicked.filter.id)))
      return clicked;
    const last = sel[sel.length - 1];
    return filterRows.find((r) => r.filter.id === last);
  }
  function showFilterDoc(fr) {
    const id = fr.filter.id;
    readEl.replaceChildren(
      renderFilter(ctx, fr, {
        onEdit() {
          openFilterEditor(fr);
        },
        onMakeRule() {
          openRuleEditor(null, {
            name: fr.filter.name,
            match: fr.filter.match ?? []
          });
        },
        onDeleted() {
          if (shownFilter === id) shownFilter = null;
          filterRows = filterRows.filter((r) => r.filter.id !== id);
          if (filters.filters.includes(id))
            selectFilters(filters.filters.filter((x) => x !== id));
          else showReadEmpty();
          void loadFilters();
        }
      })
    );
  }
  let ruleDocSeq = 0;
  async function showRuleDoc(rr) {
    const mine = ++ruleDocSeq;
    let d;
    try {
      d = await ctx.api.get("/rule", { id: rr.rule.id });
    } catch {
      return;
    }
    if (mine !== ruleDocSeq || filters.rule !== rr.rule.id || draft !== null)
      return;
    if (currentOpenKey) return;
    readEl.replaceChildren(
      renderRule(ctx, d, {
        onEdit() {
          openRuleEditor(rr, null);
        },
        async onToggle() {
          await toggleRule(ctx, rr);
          await loadRules();
          showReadEmpty();
          void reload();
        },
        onChanged() {
          void loadRules().then(() => void reload());
        }
      })
    );
  }
  readEl.replaceChildren(renderReadEmpty());
  const pane = makePane(ctx, "decide", selection, {
    row(it) {
      const st = standsLine(vocab2, it, flat);
      return {
        id: it.key,
        key: it.key,
        title: it.title || void 0,
        stands: st.text,
        tone: it.new_activity && st.tone === "muted" ? "signal" : st.tone,
        // A draft filter's preview is only to look at.
        selectable: draft === null
      };
    },
    groupOf: (it) => isLeftOpen(it) ? LEFT_OPEN : flat ? "" : it.group,
    onOpen(it) {
      if (syncingOpen || draft !== null) return;
      ctx.route.go("item", it.key);
      void openDetail(it.key);
    },
    onQuery(q, clicked) {
      if (clicked !== void 0) {
        if (draft !== null) closeFilterEditor(false);
        shownFilter = q.filters.includes(clicked) ? clicked : null;
        selectFilters(q.filters);
        return;
      }
      filters.q = q.q;
      if (ctx.route.current().section === "decide" && draft === null)
        setHashQuery(listQuery());
      void reload();
    },
    onToggle(id) {
      if (opened.has(id)) opened.delete(id);
      else opened.add(id);
      if (id === LEFT_OPEN) {
        setRows();
        markOpenRow();
      } else void reload();
    },
    onTickGroup(id) {
      const g = groups.find((x) => x.id === id);
      if (g && draft === null) void tickGroup(g);
    },
    tickedIn: (id) => selection.ids().filter((k) => groupOfKey.get(k) === id),
    onMore() {
      void loadMore();
    },
    onFilterOpen(row) {
      if (draft !== null) closeFilterEditor(true);
      shownFilter = row.filter.id;
      if (filters.rule) selectRule(null);
      else {
        if (currentOpenKey) goList();
        showReadEmpty();
      }
    },
    onFilterNew() {
      openFilterEditor(null);
    },
    headActs: (id) => groupActs(id)
  });
  const handle = pane.handle;
  const groupSwitch = h13(
    "button",
    {
      type: "button",
      class: "kit-chip cb-group-switch",
      role: "switch",
      onclick() {
        flat = !flat;
        storeFlat(flat);
        paintSwitch();
        if (draft === null) goList();
        void reload();
      }
    },
    "group by recommendation"
  );
  function paintSwitch() {
    groupSwitch.setAttribute("aria-checked", String(!flat));
    groupSwitch.classList.toggle("on", !flat);
  }
  paintSwitch();
  let filterRows = [];
  let ruleRows = [];
  const ruleRow = makeRuleRow(ctx, {
    onSelect(id) {
      if (draft !== null) closeFilterEditor(false);
      selectRule(id);
    },
    onNew() {
      openRuleEditor(null, null);
    }
  });
  async function loadRules() {
    try {
      const v = await ctx.api.get("/rules");
      ruleRows = v.rules ?? [];
      paintRules();
      if (filters.rule && currentOpenKey === null && draft === null && !readEl.querySelector(".cb-rule"))
        showReadEmpty();
    } catch {
    }
  }
  function paintRules() {
    ruleRow.paint(ruleRows, draft !== null ? null : filters.rule);
    paintAll();
  }
  function selectRule(id) {
    filters.rule = id;
    if (id) filters.filters = [];
    pane.setFilterError(null);
    paintFilters();
    paintRules();
    showReadEmpty();
    goList();
    void reload();
  }
  let draft = null;
  let editor = null;
  let editingId = null;
  let draftHash = "";
  let draftTimer = null;
  let before = null;
  const previewLine = h13("span", { class: "cb-preview-line", hidden: true });
  const rowsScroller = () => handle.el.querySelector(".kit-rows");
  function paintPreviewLine(text) {
    previewLine.hidden = text === null;
    previewLine.textContent = text ?? "";
  }
  function openRuleEditor(row, seed) {
    openEditor(
      row ? row.rule.id : "",
      row?.rule.match ?? seed?.match ?? [],
      (hooks) => ruleEditor(ctx, row, seed, hooks),
      (id) => {
        void loadRules().then(() => selectRule(id));
      },
      "rule"
    );
  }
  function openFilterEditor(row) {
    openEditor(
      row ? row.filter.id : "",
      row?.filter.match ?? [],
      (hooks) => filterEditor(ctx, row, hooks),
      (id) => {
        filters.filters = [id];
        filters.rule = null;
        void loadFilters();
        goList();
        void reload();
      },
      "filter"
    );
  }
  let editing = "filter";
  function openEditor(id, start2, make, saved, kind) {
    editing = kind;
    if (draftTimer !== null) clearTimeout(draftTimer);
    if (!before) {
      before = {
        filters: [...filters.filters],
        rule: filters.rule,
        scroll: rowsScroller()?.scrollTop ?? 0,
        offset,
        totalItems,
        loadedItems,
        leftOpen,
        leftOpenTotal,
        groups,
        viewRecs,
        lastOrder,
        paintedQuery
      };
    }
    if (currentOpenKey) goList();
    showReadEmpty();
    editingId = id;
    draft = start2.map((c) => ({ ...c })).filter((c) => c.value.trim() !== "");
    draftHash = location.hash;
    editor = make({
      onDraft(match) {
        draft = match.filter((c) => c.value.trim() !== "");
        if (draftTimer !== null) clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
          draftTimer = null;
          void reload();
        }, PREVIEW_DEBOUNCE_MS);
      },
      onSaved(id2) {
        closeFilterEditor(false);
        saved(id2);
      },
      onCancel() {
        closeFilterEditor(true);
      }
    });
    readEl.replaceChildren(editor.el);
    document.addEventListener("keydown", onEditorEsc);
    handle.el.classList.add("cb-previewing");
    pane.setFilters(filterRows, []);
    pane.setFilterError(null);
    paintRules();
    paintAll();
    void reload();
    editor.el.querySelector(".cb-filter-name")?.focus();
  }
  function onEditorEsc(e) {
    if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
    if (draft === null) return;
    e.preventDefault();
    closeFilterEditor(true);
  }
  function closeFilterEditor(restore) {
    if (draft === null) return;
    if (draftTimer !== null) clearTimeout(draftTimer);
    draftTimer = null;
    draft = null;
    editor = null;
    editingId = null;
    document.removeEventListener("keydown", onEditorEsc);
    handle.el.classList.remove("cb-previewing");
    paintPreviewLine(null);
    showReadEmpty();
    const b = before;
    before = null;
    if (!restore || !b) {
      paintAll();
      return;
    }
    filters.filters = b.filters;
    filters.rule = b.rule;
    paintFilters();
    paintRules();
    offset = b.offset;
    totalItems = b.totalItems;
    totalItemsForView = b.totalItems;
    loadedItems = b.loadedItems;
    leftOpen = b.leftOpen;
    leftOpenTotal = b.leftOpenTotal;
    groups = b.groups;
    viewRecs = b.viewRecs;
    lastOrder = b.lastOrder;
    paintedQuery = b.paintedQuery;
    setRows();
    updateFoot();
    updateReadEmptyCount();
    const sc = rowsScroller();
    if (sc) sc.scrollTop = b.scroll;
    if (location.hash !== draftHash) goList();
    void reload();
  }
  function filtered() {
    return filters.filters.length > 0 || filters.rule !== null;
  }
  function paintFilters() {
    pane.setFilters(filterRows, draft !== null ? [] : filters.filters);
  }
  async function loadFilters() {
    try {
      const v = await ctx.api.get("/filters");
      filterRows = v.filters ?? [];
      paintFilters();
      paintRail();
      if (draft === null && !currentOpenKey && !filters.rule) showReadEmpty();
    } catch {
    }
  }
  function goList() {
    ctx.route.go("decide", "", listQuery());
  }
  function listQuery() {
    return decideQuery({
      flat,
      filters: filters.filters,
      rule: filters.rule ?? "",
      q: filters.q
    });
  }
  function selectFilters(ids) {
    filters.filters = ids;
    if (ids.length) filters.rule = null;
    paintRules();
    showReadEmpty();
    pane.setFilterError(null);
    paintFilters();
    goList();
    void reload();
  }
  pane.ownRow.append(ruleRow.el);
  pane.tools.append(groupSwitch, previewLine);
  void loadFilters();
  void loadRules();
  function paintRail() {
    pane.setRail(`${viewLabel()} · ${totalItemsForView}`);
  }
  function buildQuery(pageOffset) {
    const p = draft !== null ? { match: JSON.stringify(draft) } : filters.rule ? { view: "all", rule: filters.rule } : { view: "all" };
    Object.assign(
      p,
      paneParams({
        filters: draft === null && !filters.rule ? filters.filters : [],
        q: filters.q
      })
    );
    p["offset"] = String(pageOffset);
    p["limit"] = String(PAGE_SIZE);
    if (flat) p["group"] = "false";
    else
      p["open"] = JSON.stringify([...opened].filter((id) => id !== LEFT_OPEN));
    return p;
  }
  const reload = coalesced(reloadNow);
  function queryKey() {
    return JSON.stringify(buildQuery(0));
  }
  let paintedQuery = "";
  async function reloadNow() {
    reloading = true;
    loads++;
    feedAttached();
    const asked2 = queryKey();
    const want = asked2 === paintedQuery ? Math.max(offset, PAGE_SIZE) : PAGE_SIZE;
    try {
      offset = 0;
      loadedItems = [];
      const data = await ctx.api.get("/items", buildQuery(0));
      const items = data.items ?? [];
      const seen2 = new Set(items.map((it) => it.key));
      let at2 = items.length;
      while (at2 < want && at2 < data.total && queryKey() === asked2) {
        const q = buildQuery(at2);
        q["limit"] = String(Math.min(PAGE_SIZE, want - at2));
        const page = (await ctx.api.get("/items", q)).items ?? [];
        if (page.length === 0) break;
        at2 += page.length;
        for (const it of page) {
          if (seen2.has(it.key)) continue;
          seen2.add(it.key);
          items.push(it);
        }
      }
      if (queryKey() !== asked2) {
        void reload();
        return;
      }
      totalItems = data.total;
      totalItemsForView = viewTotal(data);
      loadedItems = items;
      leftOpen = data.left_open ?? [];
      leftOpenTotal = data.left_open_total ?? 0;
      groups = data.groups ?? [];
      viewRecs = data.agent_recommended ?? 0;
      know(loadedItems);
      lastOrder = loadedItems.map((it) => it.key);
      offset = loadedItems.length;
      paintedQuery = asked2;
      pane.setFilterError(null);
      if (draft !== null) {
        editor?.showError(null);
        paintPreviewLine(
          draft.length ? `previewing a draft ${editing} · ${pluralize(viewTotal(data), "item")}` : "add a condition to preview"
        );
      }
      setRows();
      markOpenRow();
      updateFoot();
      updateReadEmptyCount();
    } catch (err) {
      const refused = err instanceof ApiError4 && err.status === 400;
      if (draft !== null && refused) {
        editor?.showError(err);
        paintPreviewLine(`previewing a draft ${editing} · not valid yet`);
      } else if (filtered() && refused) {
        pane.setFilterError(err.message);
      }
      if ((draft !== null || filtered()) && refused) {
        totalItems = 0;
        totalItemsForView = 0;
        loadedItems = [];
        leftOpen = [];
        leftOpenTotal = 0;
        groups = [];
        viewRecs = 0;
        lastOrder = [];
        offset = 0;
        paintedQuery = asked2;
        setRows();
        updateFoot();
        updateReadEmptyCount();
      }
    } finally {
      reloading = false;
    }
  }
  function viewTotal(data) {
    if (flat || !data.groups?.length) return data.total;
    return data.groups.reduce((n, g) => n + g.total, 0);
  }
  async function loadMore() {
    if (reloading || loadingMore || offset >= totalItems) return;
    loadingMore = true;
    const mine = loads;
    try {
      const data = await ctx.api.get("/items", buildQuery(offset));
      if (mine !== loads) return;
      const next = data.items ?? [];
      loadedItems = [...loadedItems, ...next];
      leftOpen = data.left_open ?? [];
      leftOpenTotal = data.left_open_total ?? 0;
      groups = data.groups ?? [];
      viewRecs = data.agent_recommended ?? 0;
      know(next);
      lastOrder = loadedItems.map((it) => it.key);
      offset = loadedItems.length;
      totalItems = data.total;
      totalItemsForView = viewTotal(data);
      setRows();
      markOpenRow();
      updateFoot();
    } catch {
    } finally {
      loadingMore = false;
    }
  }
  function setRows() {
    const withLeft = offset >= totalItems && leftOpenTotal > 0;
    const gs = flat ? [] : groups.map(paneGroup);
    if (withLeft)
      gs.push({
        id: LEFT_OPEN,
        label: vocab2?.left_open ?? "",
        n: leftOpenTotal,
        box: false
      });
    shown = pane.setRows(
      withLeft ? [...loadedItems, ...leftOpen] : loadedItems,
      gs,
      opened
    );
    const rowEls = handle.el.querySelectorAll(
      ".kit-rows > .kit-row"
    );
    shown.forEach((it, i) => {
      if (isLeftOpen(it)) rowEls[i]?.classList.add("cb-left-open");
    });
    paintRail();
    refreshNav();
  }
  function navOrder() {
    const rows = loadedItems.map((it) => ({
      key: it.key,
      group: flat ? "" : it.group
    }));
    if (offset >= totalItems && leftOpenTotal > 0)
      rows.push(...leftOpen.map((it) => ({ key: it.key, group: LEFT_OPEN })));
    return rows;
  }
  function navGroups() {
    const listed = flat ? [
      {
        id: "",
        source: "",
        disposition: "",
        label: viewLabel(),
        outward: false,
        many: "",
        total: totalItems
      }
    ] : groups;
    return [
      ...listed,
      {
        id: LEFT_OPEN,
        source: "",
        disposition: "",
        label: vocab2?.left_open ?? "",
        outward: false,
        many: "",
        total: leftOpenTotal
      }
    ];
  }
  function renderNav(key) {
    if (!vocab2) return null;
    const words = vocab2.nav;
    const n = navTargets(navOrder(), navGroups(), key);
    if (!n.pos) return null;
    const more = offset < totalItems;
    const labelOf = (k) => {
      const g = navOrder().find((r) => r.key === k)?.group ?? "";
      return navGroups().find((x) => x.id === g)?.label ?? "";
    };
    const button = (which, glyph, tip, target2, name, later) => h13(
      "button",
      {
        type: "button",
        class: "cb-nav-b",
        dataset: {
          nav: which === "prevGroup" ? "prev-group" : which === "nextGroup" ? "next-group" : which
        },
        disabled: !target2 && !later,
        title: tip.replaceAll(
          "{target}",
          target2 ? name(target2) : later ? words.later : words.none
        ),
        onclick() {
          void navGo(which);
        }
      },
      glyph
    );
    const pos = words.position.replaceAll("{pos}", String(n.pos)).replaceAll("{total}", String(n.total)).replaceAll("{group}", n.label);
    return h13(
      "nav",
      { class: "cb-nav" },
      button(
        "prevGroup",
        "«",
        words.prev_group,
        n.prevGroup,
        labelOf,
        false
      ),
      button("prev", "‹", words.prev_item, n.prev, shortKey, false),
      h13("span", { class: "cb-nav-pos" }, pos),
      button("next", "›", words.next_item, n.next, shortKey, more),
      button(
        "nextGroup",
        "»",
        words.next_group,
        n.nextGroup,
        labelOf,
        more
      )
    );
  }
  function refreshNav() {
    const doc = readEl.querySelector(".cb-item-doc");
    if (!doc || !currentOpenKey || shownDetail?.item.key !== currentOpenKey)
      return;
    const nav = renderNav(currentOpenKey);
    const old = doc.querySelector(":scope > .cb-nav");
    if (old && nav) old.replaceWith(nav);
    else if (nav) doc.prepend(nav);
    else old?.remove();
  }
  async function navGo(which) {
    const key = currentOpenKey;
    if (!key) return;
    const ahead = which === "next" || which === "nextGroup";
    if (which === "nextGroup" || which === "prevGroup" || atGroupEdge(key, ahead))
      await openNeighbour(key, ahead);
    if (currentOpenKey !== key) return;
    let target2 = navTargets(navOrder(), navGroups(), key)[which];
    while (!target2 && ahead && offset < totalItems) {
      const before2 = offset;
      if (reloading) await reload();
      else await loadMore();
      if (currentOpenKey !== key) return;
      target2 = navTargets(navOrder(), navGroups(), key)[which];
      if (!target2 && offset === before2 && !reloading) break;
    }
    if (!target2 || currentOpenKey !== key) return;
    const group = navOrder().find((r) => r.key === target2)?.group ?? "";
    if (!opened.has(group)) {
      opened.add(group);
      setRows();
    }
    openKey(target2);
  }
  function atGroupEdge(key, ahead) {
    const order = navOrder();
    const i = order.findIndex((r) => r.key === key);
    if (i < 0) return false;
    const g = order[i].group;
    if (!ahead) return i === 0 || order[i - 1].group !== g;
    if (i + 1 < order.length && order[i + 1].group === g) return false;
    const total = navGroups().find((x) => x.id === g)?.total ?? 0;
    return order.filter((r) => r.group === g).length >= total;
  }
  async function openNeighbour(key, ahead) {
    if (flat) return false;
    const cur = navOrder().find((r) => r.key === key)?.group;
    if (cur === void 0) return false;
    const gs = navGroups();
    const at2 = gs.findIndex((g) => g.id === cur);
    if (at2 < 0) return false;
    for (let i = at2 + (ahead ? 1 : -1); i >= 0 && i < gs.length; i += ahead ? 1 : -1) {
      const g = gs[i];
      if (g.total <= 0 || g.id === LEFT_OPEN && offset < totalItems) continue;
      if (opened.has(g.id)) return false;
      opened.add(g.id);
      if (g.id === LEFT_OPEN) setRows();
      else await reload();
      return true;
    }
    return false;
  }
  function know(items) {
    for (const it of items) {
      if (!it.group) continue;
      groupOfKey.set(it.key, it.group);
      if (it.proposal?.state === "pending")
        proposalOfKey.set(it.key, it.proposal.id);
      else proposalOfKey.delete(it.key);
    }
  }
  function tickedIn(g) {
    return selection.ids().filter((k) => groupOfKey.get(k) === g.id);
  }
  function paneGroup(g) {
    const ruleId = g.source.startsWith("rule:") ? g.source.slice(5) : "";
    const rr = ruleId ? ruleRows.find((r) => r.rule.id === ruleId) : void 0;
    const more = rr ? ruleMenu(rr, {
      onEdit: () => openRuleEditor(rr, null),
      onToggle: () => void toggleRule(ctx, rr).then(() => loadRules()).then(() => reload()).catch(
        (err) => showReadError(err instanceof Error ? err.message : String(err))
      )
    }) : null;
    return {
      id: g.id,
      label: ruleId ? rr?.rule.name || ruleId : g.label,
      tag: ruleId ? `rule · ${g.label}` : void 0,
      n: g.total,
      box: true,
      more,
      data: { d: g.disposition, ...ruleId ? { rule: ruleId } : {} }
    };
  }
  function groupSays(g) {
    for (const k of vocab2?.kinds ?? []) {
      const c = (k.choices ?? []).find(
        (x) => x.disposition === g.disposition && x.label === g.label
      );
      if (c) return c.says;
    }
    return "";
  }
  function withSays(el2, says) {
    if (says) el2.title = says;
    return el2;
  }
  function groupButton(id, cls, label, run, off = false) {
    return h13(
      "button",
      {
        type: "button",
        class: "kit-btn " + cls,
        disabled: off || busyGroups.has(id) || draft !== null,
        onclick() {
          if (busyGroups.has(id)) return;
          busyGroups.add(id);
          paintAll();
          void Promise.resolve(run()).finally(() => {
            busyGroups.delete(id);
            paintAll();
          });
        }
      },
      label
    );
  }
  function groupActs(id) {
    const g = groups.find((x) => x.id === id);
    if (!g || !vocab2) return [];
    const button = (cls, label, run, off = false) => groupButton(g.id, cls, label, run, off);
    const ticked = tickedIn(g);
    const n = ticked.length;
    const t = ctx.dockTarget();
    if (g.id === CAME_BACK || g.id === "none") {
      if (t && n > 0) {
        const rows = loadedItems.filter((it) => it.group === g.id);
        const looked = ticked.every(
          (k) => rows.some((it) => it.key === k && it.looking) || !rows.some((it) => it.key === k) && lookedInto.has(`${t.id}
${k}`)
        );
        return [
          button(
            "fill cb-group-ask",
            vocab2.recommend_these,
            () => lookInto(tickedIn(g)),
            looked
          )
        ];
      }
      if (t && g.id === "none" && !filtered()) {
        if (asked === askedKey(t.id))
          return [h13("span", { class: "cb-group-note" }, vocab2.asked)];
        return [button("fill cb-group-ask", vocab2.suggest_rules, askRules)];
      }
      return [];
    }
    const w = groupButtons(g, n, vocab2);
    return [
      withSays(
        button("fill cb-group-act", w.act, () => actGroup(g)),
        groupSays(g)
      ),
      ...g.source.startsWith("rule:") ? [] : [button("cb-group-discard", w.discard, () => discardGroup(g))]
    ];
  }
  function paintAll() {
    pane.paintHeads();
  }
  function groupFilters(g) {
    return { ...viewFilters(), group: g.id };
  }
  async function fetchGroup(g) {
    const out = [];
    for (let total = Infinity; out.length < total; ) {
      const data = await ctx.api.get("/items", {
        ...groupFilters(g),
        offset: String(out.length),
        limit: String(PAGE_SIZE)
      });
      const got = data.items ?? [];
      out.push(...got);
      total = data.total;
      if (!got.length) break;
    }
    know(out);
    return out;
  }
  async function tickGroup(g) {
    const ticked = tickedIn(g);
    if (ticked.length >= g.total) {
      selection.deselect(ticked);
      return;
    }
    try {
      const items = await fetchGroup(g);
      selection.all(items.map((it) => it.key));
      if (!opened.has(g.id)) {
        opened.add(g.id);
        void reload();
      }
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    }
  }
  async function target(g) {
    let keys = tickedIn(g);
    if (!keys.length) keys = (await fetchGroup(g)).map((it) => it.key);
    const ids = [];
    for (const k of keys) {
      const id = proposalOfKey.get(k);
      if (id !== void 0) ids.push(id);
    }
    return { keys, ids };
  }
  async function actGroup(g) {
    if (deciding) return;
    const open = currentOpenKey;
    deciding = open ?? "\0group";
    try {
      const ticked = tickedIn(g).length;
      const { keys, ids } = await target(g);
      if (!ids.length) return;
      const order = await orderFor(open);
      const r = await ctx.api.post("/proposals/accept", {
        ids
      });
      if (!r.accepted) {
        showReadError((r.errors ?? []).join("; ") || "nothing was accepted");
        return;
      }
      selection.deselect(keys);
      lastUndo = Object.entries(r.decisions ?? {}).map(([key, expect]) => ({
        key,
        prev: r.previous?.[key] ?? null,
        expect
      }));
      if (g.outward && vocab2)
        waited(
          doneWords(vocab2, g.disposition, {
            label: g.label,
            total: g.total,
            ticked
          }),
          applyGroupLink(g.disposition, keys[0] ?? "")
        );
      else hideStrip();
      if (!open || keys.includes(open)) {
        await moveOn(open ?? "", order);
      } else {
        void reload();
      }
      const errs = r.errors ?? [];
      if (errs.length) showReadError(errs.join("; "));
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }
  async function lookInto(keys) {
    if (!ctx.dockTarget() || !vocab2) return;
    try {
      if (!keys.length) return;
      const message5 = vocab2.look_into.message_many.replaceAll(
        "{keys}",
        keys.join(", ")
      );
      const t = ctx.dockTarget();
      const why = await ctx.askSession(message5, { keys }, "look-into");
      if (why) {
        showReadError(why);
        return;
      }
      if (t) for (const k of keys) lookedInto.add(`${t.id}
${k}`);
      await reload();
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    }
  }
  function discardGroup(g) {
    if (!vocab2) return;
    const ticked = tickedIn(g);
    if (ticked.length && ticked.length < g.total) {
      const ids = ticked.map((k) => proposalOfKey.get(k)).filter((id) => id !== void 0);
      openDiscardSheet(
        ctx,
        vocab2,
        ids.length,
        discardWhere(),
        { ids },
        discarded
      );
      return;
    }
    openDiscardSheet(
      ctx,
      vocab2,
      g.total,
      discardWhere(),
      groupFilters(g),
      discarded
    );
  }
  function updateFoot() {
    pane.setMore(Math.min(PAGE_SIZE, totalItems - offset));
  }
  function markOpenRow() {
    if (!currentOpenKey) return;
    const i = shown.findIndex((it) => it.key === currentOpenKey);
    if (i < 0) return;
    const rowEl = handle.el.querySelectorAll(".kit-rows > .kit-row")[i];
    if (rowEl?.classList.contains("open")) return;
    syncingOpen = true;
    try {
      handle.open(i);
    } finally {
      syncingOpen = false;
    }
  }
  let asked = "";
  const askedKey = (session) => `${session}
${JSON.stringify(listAttached("none"))}`;
  const lookedInto = /* @__PURE__ */ new Set();
  ctx.onDockTarget(() => paintAll());
  async function askRules() {
    const t = ctx.dockTarget();
    if (!t) return;
    const why = await ctx.askSession(SUGGEST_RULES, {
      list: listAttached("none")
    });
    if (why) showReadError(why);
    else {
      asked = askedKey(t.id);
      paintAll();
    }
  }
  let viewRecs = 0;
  function viewFilters() {
    const p = buildQuery(0);
    delete p["offset"];
    delete p["limit"];
    delete p["open"];
    return p;
  }
  function discarded() {
    asked = "";
    void reload();
  }
  function discardView() {
    if (viewRecs === 0 || !vocab2) return;
    openDiscardSheet(
      ctx,
      vocab2,
      viewRecs,
      discardWhere(),
      viewFilters(),
      discarded
    );
  }
  async function openDetail(key) {
    currentOpenKey = key;
    markOpenRow();
    feedAttached();
    try {
      const detail = await ctx.api.get("/item", { key });
      if (currentOpenKey !== key) return;
      paintDetail(key, detail);
    } catch {
    }
  }
  function ruleNameOf(source) {
    if (!source.startsWith("rule:")) return "";
    const id = source.slice(5);
    return ruleRows.find((r) => r.rule.id === id)?.rule.name || id;
  }
  function paintDetail(key, detail) {
    shownDetail = detail;
    const el2 = renderItem(ctx, detail, {
      decide: (d, until, note) => void decideOpen(key, d, until, note),
      cardsReady: () => renderAsk(),
      nav: renderNav(key),
      sourceName: ruleNameOf
    });
    readEl.replaceChildren(el2);
    renderAsk();
  }
  let askingKey = "";
  function renderAsk() {
    const grid = readEl.querySelector(".cb-decide .cb-choices");
    const old = grid?.querySelector(".cb-look-card");
    const key = currentOpenKey;
    const t = ctx.dockTarget();
    const words = vocab2?.look_into;
    if (!grid || !grid.dataset.cards || !key || !t || !words || shownDetail?.item.key !== key) {
      old?.remove();
      return;
    }
    const w = lookIntoCard(words, t.name, key);
    const looking = lookingLine(shownDetail.item.looking);
    const n = Number(grid.dataset.cards) + 1;
    const card6 = h13(
      "button",
      {
        type: "button",
        class: "kit-btn cb-choice cb-look-card" + (looking ? " looking" : ""),
        title: looking || w.says,
        dataset: { n: String(n) },
        disabled: !!looking || askingKey === key,
        async onclick() {
          if (card6.disabled) return;
          const wrap = grid.closest(".cb-choices-wrap");
          if (wrap) showChoiceError(wrap, "");
          askingKey = key;
          card6.disabled = true;
          const why = await ctx.askSession(
            w.message,
            { keys: [key] },
            "look-into"
          );
          askingKey = "";
          if (why) {
            card6.disabled = false;
            if (wrap) showChoiceError(wrap, why);
          } else void refreshLooking(key);
        }
      },
      h13("span", { class: "cb-choice-mark" }),
      h13("span", { class: "cb-choice-label" }, w.label)
    );
    if (old) old.replaceWith(card6);
    else grid.append(card6);
  }
  ctx.onDockTarget(() => renderAsk());
  let lookingSeq = 0;
  async function refreshLooking(key) {
    const mine = ++lookingSeq;
    let detail;
    try {
      detail = await ctx.api.get("/item", { key });
    } catch {
      return;
    }
    if (mine !== lookingSeq || currentOpenKey !== key) return;
    if (shownDetail?.item.key !== key) return;
    shownDetail = {
      ...shownDetail,
      item: { ...shownDetail.item, looking: detail.item.looking }
    };
    const says = lookingLine(detail.item.looking);
    const el2 = readEl.querySelector(".cb-looking");
    if (el2) {
      el2.textContent = says;
      el2.hidden = !says;
    }
    renderAsk();
  }
  function lookingShown() {
    return !!shownDetail?.item.looking || shown.some((it) => !!it.looking);
  }
  function lookingMayHaveChanged() {
    if (currentOpenKey) void refreshLooking(currentOpenKey);
    void reload();
  }
  function midInput() {
    const comment = readEl.querySelector(".cb-close-comment");
    const typed2 = comment?.querySelector("input")?.value ?? "";
    if (comment && !comment.hidden && typed2 !== "") return true;
    const notNow = readEl.querySelector(".cb-notnow");
    return !!notNow && !notNow.hidden;
  }
  let freshSeq = 0;
  async function proposalsChanged(key, why = "proposals") {
    const mine = ++freshSeq;
    let detail;
    try {
      detail = await ctx.api.get("/item", { key });
    } catch {
      return;
    }
    if (mine !== freshSeq || currentOpenKey !== key || deciding === key) return;
    if (!midInput()) {
      paintDetail(key, detail);
      return;
    }
    const p = detail.item.proposal;
    const says = why === "evidence" ? "new evidence" : p && p.state === "pending" && vocab2 ? recommendLine(
      vocab2,
      key,
      p.source,
      p.disposition,
      ruleNameOf(p.source)
    ) : "the recommendation changed";
    const show2 = h13(
      "button",
      {
        type: "button",
        class: "cb-link cb-rec-show",
        onclick: () => void openDetail(key)
      },
      "show"
    );
    const line = h13(
      "p",
      { class: "cb-rec-fresh" },
      h13("span", { class: "cb-rec-fresh-says" }, says),
      " · ",
      show2
    );
    const old = readEl.querySelector(".cb-rec-fresh");
    if (old) old.replaceWith(line);
    else readEl.querySelector(".cb-reading")?.prepend(line);
  }
  function viewLabel() {
    if (filters.rule) {
      const rr = ruleRows.find((r) => r.rule.id === filters.rule);
      return `rule ${rr?.rule.name || filters.rule}`;
    }
    if (filtered()) return filterLabel(filterRows, filters.filters);
    return "to decide";
  }
  function discardWhere() {
    return filtered() ? viewLabel() : "the list";
  }
  function showReadError(message5) {
    if (readEl.querySelector(".cb-choice-err")) {
      showChoiceError(readEl, message5);
      return;
    }
    readEl.firstElementChild?.append(
      h13("p", { class: "cb-choice-err" }, message5)
    );
  }
  function showDone() {
    currentOpenKey = null;
    shownDetail = null;
    readEl.replaceChildren(
      h13(
        "div",
        { class: "cb-read-empty" },
        h13(
          "p",
          { class: "cb-read-done" },
          filtered() ? `Nothing left in ${viewLabel()}.` : "Nothing left to decide."
        )
      )
    );
    feedAttached();
  }
  function openKey(key) {
    const before2 = location.hash;
    ctx.route.go("item", key);
    if (location.hash === before2) {
      void openDetail(key);
      void reload();
    }
  }
  function remember(key, made, previous) {
    const expect = made?.[key];
    lastUndo = expect ? [{ key, prev: previous?.[key] ?? null, expect }] : [];
  }
  const strip = h13("div", {
    class: "cb-strip",
    role: "status",
    hidden: true
  });
  let stripTimer = null;
  function hideStrip() {
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = null;
    strip.hidden = true;
  }
  function showStrip(text, groupLink, undo2) {
    if (!vocab2) return;
    strip.replaceChildren(
      ...waitingStrip(vocab2.waiting, text).map(
        (part) => typeof part === "string" ? part : "link" in part ? h13("a", { href: groupLink, class: "cb-strip-apply" }, part.link) : h13(
          "button",
          {
            type: "button",
            class: "cb-link cb-strip-undo",
            onclick() {
              hideStrip();
              undo2();
            }
          },
          part.button
        )
      )
    );
    if (!strip.isConnected) document.body.append(strip);
    const r = readEl.getBoundingClientRect();
    strip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    strip.hidden = false;
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = setTimeout(hideStrip, STRIP_MS);
  }
  function waited(done, link) {
    if (done) showStrip(done, link, () => void undo());
  }
  function outwardChoice(key, d) {
    const kind = key.slice(0, key.indexOf(":"));
    return !!vocab2?.kinds?.find((k) => k.kind === kind)?.choices?.find((c) => c.disposition === d)?.outward;
  }
  async function orderFor(key) {
    if (!key || lastOrder.includes(key)) return [...lastOrder];
    const keys = [];
    try {
      for (let total = Infinity; keys.length < total; ) {
        const data = await ctx.api.get(
          "/items",
          buildQuery(keys.length)
        );
        const got = (data.items ?? []).map((it) => it.key);
        keys.push(...got);
        total = Math.min(total, data.total);
        if (!got.length || got.includes(key)) break;
      }
    } catch {
      return [...lastOrder];
    }
    return keys.includes(key) ? keys : [...lastOrder];
  }
  async function moveOn(key, order) {
    const fresh = [];
    let next = MORE;
    try {
      for (let total = Infinity; next === MORE; ) {
        const data = await ctx.api.get(
          "/items",
          buildQuery(fresh.length)
        );
        const got = (data.items ?? []).map((it) => it.key);
        fresh.push(...got);
        total = Math.min(total, data.total);
        const complete = got.length === 0 || fresh.length >= total;
        next = nextInView(order, key, fresh, complete);
      }
    } catch {
      if (key) void openDetail(key);
      return;
    }
    if ((currentOpenKey ?? "") !== key) return;
    if (next) openKey(next);
    else {
      showDone();
      void reload();
    }
  }
  async function decideOpen(key, disposition, until, note) {
    if (deciding) return;
    deciding = key;
    const order = await orderFor(key);
    let p = shownProposal();
    try {
      const now = await ctx.api.get("/item", { key });
      const fresh = now.item.proposal;
      p = fresh && fresh.state === "pending" ? fresh : null;
    } catch {
    }
    const route = decideRoute(
      p && p.key === key ? p : null,
      disposition,
      until
    );
    try {
      let made = null;
      let previous = null;
      if (route.path === "accept") {
        const body = { ids: [route.id] };
        if (note) body["note"] = note;
        const r = await ctx.api.post("/proposals/accept", body);
        if (!r.accepted) {
          showReadError((r.errors ?? []).join("; ") || "nothing was decided");
          return;
        }
        made = r.decisions;
        previous = r.previous;
      } else {
        const payload = route.path === "change" ? { id: route.id, disposition } : { keys: [key], disposition };
        if (until) payload["until"] = until;
        if (note) payload["note"] = note;
        const r = await ctx.api.post(
          route.path === "change" ? "/proposals/change" : "/decide",
          payload
        );
        if (!(r.decided_keys ?? []).length) {
          showReadError((r.errors ?? []).join("; ") || "nothing was decided");
          return;
        }
        made = r.decisions;
        previous = r.previous;
      }
      selection.deselect([key]);
      remember(key, made, previous);
      if (outwardChoice(key, disposition) && vocab2)
        waited(
          doneWords(vocab2, disposition, { key }),
          applyGroupLink(disposition, key)
        );
      else hideStrip();
      await moveOn(key, order);
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }
  async function undo() {
    const u = lastUndo;
    if (!u.length || deciding) return;
    deciding = u[0].key;
    lastUndo = [];
    hideStrip();
    try {
      const r = await ctx.api.post("/decisions/undo", {
        items: u.map((x) => ({
          key: x.key,
          expect: x.expect,
          restore: x.prev ? {
            disposition: x.prev.disposition,
            until: x.prev.until ?? "",
            note: x.prev.note ?? ""
          } : null
        }))
      });
      if (u.length === 1) openKey(u[0].key);
      else void reload();
      const errs = r.errors ?? [];
      if (errs.length) showReadError(errs.join("; "));
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }
  void reload();
  selection.onChange(() => {
    paintAll();
    feedAttached();
  });
  function shownProposal() {
    const d = shownDetail;
    if (!d || d.item.key !== currentOpenKey) return null;
    const p = d.item.proposal;
    return p && p.state === "pending" ? p : null;
  }
  const undoKey = {
    keys: "u",
    label: "undo the last decision",
    group: "page",
    run() {
      if (!lastUndo.length) return false;
      void undo();
    }
  };
  const choiceKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    keys: String(n),
    label: `pick choice ${n}`,
    group: "page",
    run() {
      if (!currentOpenKey) return false;
      const card6 = readEl.querySelectorAll(
        ".cb-choices .cb-choice"
      )[n - 1];
      if (!card6) return false;
      card6.click();
    }
  }));
  const jumpKeys = groupKeys((d) => {
    if (!currentOpenKey) return;
    void navGo(d < 0 ? "prevGroup" : "nextGroup");
  });
  const listKeys = [undoKey, ...choiceKeys, ...jumpKeys];
  void getVocab(ctx).then((v) => {
    vocab2 = v;
    setRows();
    updateFoot();
    renderAsk();
  }).catch(() => {
  });
  function show(sub, query) {
    if (draft !== null) {
      if (location.hash === draftHash) return;
      closeFilterEditor(false);
    }
    const wasActive = active;
    active = true;
    feedAttached();
    if (!sub) {
      const urlQ = paneQuery(query).q;
      if (urlQ !== filters.q) {
        filters.q = urlQ;
        pane.setSearch(urlQ);
      }
    }
    const params = new URLSearchParams(query);
    const ids = sub ? [] : parseFilterIds(params.get("filters"));
    const ruleId = sub ? "" : params.get("rule") ?? "";
    if (sub) {
      if (!wasActive || sub !== currentOpenKey) void openDetail(sub);
      void reload();
    } else if (ruleId) {
      flat = flatFor(true, query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      filters.rule = ruleId;
      filters.filters = [];
      paintFilters();
      paintRules();
      showReadEmpty();
      void reload();
    } else if (ids.length) {
      filters.rule = null;
      paintRules();
      flat = flatFor(true, query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      filters.filters = ids;
      paintFilters();
      showReadEmpty();
      void reload();
    } else {
      flat = flatFor(query !== "", query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      if (filtered()) {
        filters.filters = [];
        filters.rule = null;
        pane.setFilterError(null);
        paintFilters();
        paintRules();
      }
      showReadEmpty();
      void reload();
      if (params.get("new") === "filter") {
        setHashQuery(listQuery());
        openFilterEditor(null);
      }
    }
  }
  return {
    id: "decide",
    list: handle.el,
    read: readEl,
    show,
    hide() {
      active = false;
    },
    // The list's keys (j k o ↵ x ⇧x, / its search) come from the kit, bound
    // to this list while it shows.
    listKeys: () => ({ nav: handle, selects: true }),
    keys: () => listKeys,
    onLive(type, data) {
      if (type === "gap") {
        void loadRules();
        void reload();
        if (currentOpenKey && currentOpenKey !== deciding) {
          void openDetail(currentOpenKey);
        }
      } else if (type === "index") {
        void reload();
      } else if (type === "decided") {
        const decidedPayload = data;
        const decidedKeys = decidedPayload?.keys ?? [];
        if (decidedKeys.length > 0) {
          selection.deselect(decidedKeys);
        }
        if (currentOpenKey && currentOpenKey !== deciding && decidedKeys.includes(currentOpenKey)) {
          void openDetail(currentOpenKey);
        }
        void reload();
      } else if (type === "proposals") {
        const propPayload = data;
        const propKeys = propPayload?.keys ?? [];
        const propState = propPayload?.state ?? "";
        if (propState !== "pending" && propKeys.length > 0) {
          selection.deselect(propKeys);
        }
        if (currentOpenKey && currentOpenKey !== deciding && propKeys.includes(currentOpenKey)) {
          void proposalsChanged(currentOpenKey);
        }
        void reload();
      } else if (type === "rules") {
        void loadRules().then(() => {
          if (filters.rule && !currentOpenKey && draft === null && active)
            showReadEmpty();
        });
      } else if (type === "filters") {
        void loadFilters().then(() => {
          if (filtered()) void reload();
        });
      } else if (type === "evidence") {
        const key = data?.key ?? "";
        if (currentOpenKey && currentOpenKey !== deciding && key === currentOpenKey)
          void proposalsChanged(currentOpenKey, "evidence");
      } else if (type === "message") {
        const keys = data?.attached?.keys ?? [];
        if (keys.some(
          (k) => k === currentOpenKey || shown.some((it) => it.key === k)
        ))
          lookingMayHaveChanged();
      } else if (type === "messages" || type === "settled" || type === "delivery" || type === "interrupted") {
        if (lookingShown()) lookingMayHaveChanged();
      }
    },
    primary() {
      return null;
    }
  };
}

// in-order.ts
function latestInOrder(send) {
  let busy = false;
  let next = null;
  const run = async (v) => {
    busy = true;
    try {
      await send(v);
    } catch (err) {
      console.error("[in-order]", err);
    }
    busy = false;
    if (next) {
      const n = next;
      next = null;
      void run(n.v);
    }
  };
  return (v) => {
    if (busy) next = { v };
    else void run(v);
  };
}

// dock.ts
import { h as h16, card as card5 } from "/_kit/kit.js";

// time-utils.ts
function ageMs(ts) {
  return Date.now() - new Date(ts).getTime();
}
function fmtAge(ts) {
  const ms = ageMs(ts);
  const s = Math.floor(ms / 1e3);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h17 = Math.floor(m / 60);
  if (h17 < 24) return `${h17}h`;
  const d = Math.floor(h17 / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

// thread.ts
function at(m) {
  const ts = m.author === "court" ? m.queued_at ?? m.created_at : m.created_at;
  return Date.parse(ts);
}
function threadOrder(ms) {
  return [...ms].sort(
    (a, b) => at(a) - at(b) || (a.batch_id ?? 0) - (b.batch_id ?? 0) || (a.batch_pos ?? 0) - (b.batch_pos ?? 0) || a.id - b.id
  );
}

// dock-state.ts
function dockOpen(hasMessages, focused, manual) {
  if (focused) return true;
  if (manual !== null) return manual;
  return hasMessages;
}

// composer.ts
import { h as h14, ApiError as ApiError5 } from "/_kit/kit.js";

// attached.ts
var KIND_PLURAL = { branch: "branches" };
function isEmpty(a) {
  return !a.keys?.length && !a.open && !a.rule && !a.job && !a.list;
}
function attachedLabel(a, jobTitle2 = "") {
  const parts = [];
  const keys = a.keys ?? [];
  if (keys.length === 1) {
    parts.push(keyWithoutKind(keys[0]));
  } else if (keys.length > 1) {
    const kinds = new Set(keys.map(kindFromKey));
    const kind = kinds.size === 1 ? [...kinds][0] : "";
    const noun = kind ? pluralize(keys.length, kind, KIND_PLURAL[kind]) : pluralize(keys.length, "item");
    parts.push(`${noun} selected`);
  }
  if (a.open && !(keys.length === 1 && keys[0] === a.open)) {
    parts.push(keyWithoutKind(a.open));
  }
  if (a.rule) parts.push(`rule ${a.rule}`);
  if (a.job)
    parts.push(
      jobTitle2 ? `job #${a.job} · ${jobTitle2.toLowerCase()}` : `job #${a.job}`
    );
  if (a.list) parts.push(listLabel(a.list));
  return parts.join(" · ");
}
function listLabel(l) {
  const parts = ["list"];
  if (l.match) parts.push("draft");
  const n = l.filters?.length ?? 0;
  if (n) parts.push(pluralize(n, "filter"));
  if (l.rule) parts.push(`rule ${l.rule}`);
  if (l.q) parts.push(`search ${l.q}`);
  if (l.group) parts.push(`group ${l.group}`);
  return parts.join(" · ");
}
function listText(l) {
  const words = ["list"];
  if (l.match) words.push(`match=${JSON.stringify(l.match)}`);
  if (l.filters?.length) words.push(`filters=${l.filters.join(",")}`);
  if (l.rule) words.push(`rule=${l.rule}`);
  if (l.q) words.push(`search=${JSON.stringify(l.q)}`);
  if (l.group) words.push(`group=${l.group}`);
  return words.join(" ");
}
var LIST_RE = /(?:^|\s)list((?:\s+(?:match|filters|rule|search|group)=(?:"(?:[^"\\]|\\.)*"|\S+))*)(?=\s|$)/;
function parseList(words) {
  const l = {};
  const re = /(match|filters|rule|search|group)=("(?:[^"\\]|\\.)*"|\S+)/g;
  for (const m of words.matchAll(re)) {
    const [, name, raw] = m;
    let v = raw;
    if (raw.startsWith('"')) {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw.slice(1, -1);
      }
    }
    if (name === "filters") {
      const ids = v.split(",").filter(Boolean);
      if (ids.length) l.filters = ids;
    } else if (name === "match") l.match = v;
    else if (name === "rule") l.rule = v;
    else if (name === "search") l.q = v;
    else l.group = v;
  }
  return l;
}
function attachedText(a) {
  const words = [...a.keys ?? []];
  if (a.open && !(a.keys?.length === 1 && a.keys[0] === a.open)) {
    words.push(`open ${a.open}`);
  }
  if (a.rule) words.push(`rule ${a.rule}`);
  if (a.job) words.push(`job ${a.job}`);
  if (a.list) words.push(listText(a.list));
  return words.join(" ");
}
function parseAttached(text) {
  const out = {};
  const list2 = LIST_RE.exec(text);
  if (list2) {
    out.list = parseList(list2[1]);
    text = text.slice(0, list2.index) + " " + text.slice(list2.index + list2[0].length);
  }
  const words = text.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  const keys = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if ((w === "rule" || w === "job" || w === "open") && next) {
      if (w === "rule") out.rule = next;
      else if (w === "job") out.job = next.replace(/^#/, "");
      else if (isKey(next)) out.open = next;
      i++;
      continue;
    }
    if (isKey(w) && !keys.includes(w)) keys.push(w);
  }
  if (keys.length) out.keys = keys;
  return out;
}
function isKey(w) {
  return /^[a-z]+:\S+$/.test(w);
}
function sameAttached(a, b) {
  return attachedText(a) === attachedText(b);
}

// composer.ts
function movedNote(err) {
  return err instanceof ApiError5 && err.status === 409 ? "that thread moved to another session; not sent" : "";
}
function threadName(body) {
  const words = body.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words.length > 40 ? words.slice(0, 39) + "…" : words;
}
function makeComposer(ctx, dock) {
  let context = {};
  let contextTitle = "";
  let override = null;
  let sending = false;
  const effective = () => override ?? context;
  const value = h14("span", {
    class: "cb-comp-attached-value",
    contenteditable: "true",
    role: "textbox",
    "aria-label": "attached",
    spellcheck: false,
    "data-testid": "composer-attached"
  });
  const line = h14(
    "div",
    { class: "cb-comp-attached" },
    h14("span", { class: "cb-comp-attached-prefix" }, "attached: "),
    value
  );
  let editing = false;
  function renderAttached() {
    if (editing) return;
    const a = effective();
    const title = a.job && a.job === context.job ? contextTitle : "";
    value.textContent = isEmpty(a) ? "nothing" : attachedLabel(a, title);
    value.toggleAttribute("data-empty", isEmpty(a));
    value.toggleAttribute("data-edited", override !== null);
  }
  value.addEventListener("focus", () => {
    if (editing) return;
    editing = true;
    value.textContent = attachedText(effective());
    value.removeAttribute("data-empty");
    const range = document.createRange();
    range.selectNodeContents(value);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  function commit() {
    if (!editing) return;
    editing = false;
    const parsed = parseAttached(value.textContent ?? "");
    override = sameAttached(parsed, context) ? null : parsed;
    renderAttached();
  }
  function revert() {
    editing = false;
    renderAttached();
  }
  value.addEventListener("blur", commit);
  value.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      value.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      revert();
      value.blur();
    }
  });
  const input = h14("textarea", {
    class: "cb-comp-input",
    rows: 1,
    placeholder: "Message the agent…",
    "aria-label": "message",
    "data-testid": "composer-input"
  });
  function fit() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  input.addEventListener("input", fit);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    void send(false);
  });
  const note = h14("span", { class: "cb-comp-note", role: "status" });
  const footer = h14(
    "div",
    { class: "cb-comp-foot" },
    h14("span", {}, "↵ send · ⌘↵ add to batch"),
    note
  );
  const el2 = h14(
    "div",
    { class: "cb-comp", "data-testid": "composer" },
    line,
    input,
    footer
  );
  async function threadFor(body) {
    const current = dock.currentThread();
    if (current) return current;
    const session = dock.currentSession();
    if (!session) return 0;
    const t = await ctx.api.post("/threads", {
      session,
      name: threadName(body)
    });
    dock.threadCreated(t);
    return t.id;
  }
  function restoreSent(sent) {
    const typed2 = input.value.replace(/^\s+/, "");
    input.value = typed2 ? `${sent.replace(/\s+$/, "")} ${typed2}` : sent;
    fit();
  }
  async function send(batch) {
    const sent = input.value;
    const body = sent.trim();
    if (!body || sending) return;
    const why = dock.blocked();
    if (why) {
      note.textContent = why;
      return;
    }
    sending = true;
    note.textContent = "";
    input.value = "";
    fit();
    let posted = false;
    try {
      const thread = await threadFor(body);
      if (!thread) {
        note.textContent = "no agent session";
        return;
      }
      await ctx.api.post("/messages", {
        thread,
        body,
        attached: effective(),
        batch,
        session: dock.currentSession()
      });
      posted = true;
      override = null;
      renderAttached();
    } catch (err) {
      const moved = movedNote(err);
      note.textContent = moved || "not sent";
      if (moved) dock.threadMoved();
      console.error("[composer] send:", err);
    } finally {
      if (!posted) restoreSent(sent);
      sending = false;
    }
  }
  renderAttached();
  return {
    el: el2,
    input,
    setAttached(a, jobTitle2 = "") {
      context = a;
      contextTitle = jobTitle2;
      renderAttached();
    },
    setAgent(name) {
      input.placeholder = `Message ${name || "the agent"}…`;
    },
    focus() {
      input.focus();
    },
    addToBatch() {
      void send(true);
    },
    say(text) {
      note.textContent = text;
    },
    async sendText(body, attached = {}, purpose = "") {
      const why = dock.blocked();
      if (why) {
        note.textContent = why;
        return why;
      }
      try {
        const thread = await threadFor(body);
        if (!thread) {
          note.textContent = "no agent session";
          return note.textContent;
        }
        await ctx.api.post("/messages", {
          thread,
          body,
          attached,
          batch: false,
          session: dock.currentSession(),
          ...purpose ? { purpose } : {}
        });
        return "";
      } catch (err) {
        const moved = movedNote(err);
        note.textContent = moved || "not sent";
        if (moved) dock.threadMoved();
        console.error("[composer] sendText:", err);
        return note.textContent;
      }
    }
  };
}

// progress.ts
import { h as h15, card as card4, fold as fold2, noteField as noteField3 } from "/_kit/kit.js";
function makeBatchTray(ctx, dock) {
  let thread = 0;
  let batch = 0;
  let drafts = [];
  let loadSeq = 0;
  const label = h15("span", { class: "kit-card-head cb-batch-label" });
  const sendBtn = h15("button", {
    class: "kit-btn fill cb-batch-send",
    "data-testid": "batch-send",
    onclick() {
      void sendBatch();
    }
  });
  const list2 = h15("div", { class: "cb-batch-drafts" });
  const el2 = card4({
    body: h15(
      "div",
      {},
      h15("div", { class: "cb-batch-head" }, label, sendBtn),
      list2
    )
  });
  el2.classList.add("cb-batch");
  el2.setAttribute("data-testid", "batch-tray");
  el2.hidden = true;
  let editing = null;
  function render() {
    if (editing?.isConnected) return;
    editing = null;
    el2.hidden = drafts.length === 0;
    if (!drafts.length) {
      list2.replaceChildren();
      return;
    }
    label.textContent = `batch · ${pluralize(drafts.length, "draft")}`;
    sendBtn.textContent = `send ${drafts.length}`;
    list2.replaceChildren(...drafts.map((d, i) => draftRow(d, i)));
  }
  function actionBtn(text, action, aria, run, disabled = false) {
    return h15(
      "button",
      {
        class: "cb-batch-act",
        "data-action": action,
        "aria-label": aria,
        disabled,
        onclick: run
      },
      text
    );
  }
  function draftRow(d, i) {
    const text = h15("span", { class: "cb-batch-text" }, d.body);
    const row = h15(
      "div",
      { class: "cb-batch-draft", "data-draft-id": String(d.id) },
      text,
      h15(
        "span",
        { class: "cb-batch-acts" },
        actionBtn(
          "edit",
          "edit",
          `edit draft ${i + 1}`,
          () => editDraft(d, text)
        ),
        actionBtn(
          "↑",
          "up",
          `move draft ${i + 1} up`,
          () => void move(i, -1),
          i === 0
        ),
        actionBtn(
          "↓",
          "down",
          `move draft ${i + 1} down`,
          () => void move(i, 1),
          i === drafts.length - 1
        ),
        actionBtn(
          "×",
          "remove",
          `remove draft ${i + 1}`,
          () => void remove(d.id)
        )
      )
    );
    return row;
  }
  function editDraft(d, text) {
    const done = () => {
      if (editing === field) editing = null;
      render();
    };
    const field = noteField3({
      value: d.body,
      onCommit(v) {
        const body = v.trim();
        if (body && body !== d.body) {
          d.body = body;
          const now = drafts.find((x) => x.id === d.id);
          if (now) now.body = body;
          void ctx.api.post("/drafts/edit", { id: d.id, body }).catch((err) => {
            console.error("[batch] edit:", err);
            void reload();
          });
        }
        done();
      }
    });
    field.classList.add("cb-batch-edit");
    field.setAttribute("aria-label", "edit draft");
    field.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done();
    });
    field.addEventListener("blur", () => {
      if (field.isConnected) done();
    });
    editing = field;
    text.replaceWith(field);
    field.focus();
    field.select();
  }
  async function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= drafts.length) return;
    const next = [...drafts];
    [next[i], next[j]] = [next[j], next[i]];
    drafts = next;
    render();
    try {
      await ctx.api.post("/batches/reorder", {
        batch,
        ids: drafts.map((d) => d.id)
      });
    } catch (err) {
      console.error("[batch] reorder:", err);
      await reload();
    }
  }
  async function remove(id) {
    drafts = drafts.filter((d) => d.id !== id);
    render();
    try {
      await ctx.api.post("/drafts/remove", { id });
    } catch (err) {
      console.error("[batch] remove:", err);
      await reload();
    }
  }
  async function sendBatch() {
    if (!batch || !drafts.length) return;
    const why = dock.blocked();
    if (why) {
      dock.say(why);
      return;
    }
    const sent = batch;
    drafts = [];
    render();
    try {
      await ctx.api.post("/batches/send", {
        batch: sent,
        session: dock.currentSession()
      });
    } catch (err) {
      console.error("[batch] send:", err);
      const moved = movedNote(err);
      if (moved) {
        dock.say(moved);
        dock.threadMoved();
      }
      await reload();
    }
  }
  async function load(t) {
    thread = t;
    const seq = ++loadSeq;
    if (!t) {
      batch = 0;
      drafts = [];
      render();
      return;
    }
    try {
      const mv = await ctx.api.get("/messages", {
        thread: String(t)
      });
      if (seq !== loadSeq) return;
      batch = mv.batch;
      drafts = mv.drafts ?? [];
      render();
    } catch (err) {
      console.error("[batch] load:", err);
    }
  }
  function reload() {
    return load(thread);
  }
  return { el: el2, load, reload };
}
var NO_PROGRESS_MS = 4 * 60 * 1e3;
function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
function countText(n, total) {
  return n && total ? ` · ${n} of ${total}` : "";
}
function makeProgressLine() {
  let prog = null;
  let at2 = 0;
  const text = h15("span", { class: "cb-prog-text" });
  const age = h15("span", { class: "cb-prog-age" });
  const fill = h15("span", { class: "cb-prog-fill" });
  const bar2 = h15("div", { class: "cb-prog-bar", role: "progressbar" }, fill);
  const el2 = h15(
    "div",
    { class: "cb-prog", "data-testid": "progress-line" },
    h15(
      "div",
      { class: "cb-prog-row" },
      h15("span", { class: "cb-prog-dot" }),
      text,
      age
    ),
    bar2
  );
  el2.hidden = true;
  function render() {
    el2.hidden = !prog;
    if (!prog) return;
    const since = Date.now() - at2;
    text.textContent = prog.text + countText(prog.n, prog.total);
    const quiet = since >= NO_PROGRESS_MS;
    el2.toggleAttribute("data-quiet", quiet);
    age.textContent = quiet ? `no progress for ${Math.floor(since / 6e4)}m` : fmtAgo(since);
    const n = prog.n ?? 0;
    const total = prog.total ?? 0;
    bar2.hidden = !(n && total);
    if (n && total) {
      fill.style.width = `${Math.min(100, n / total * 100)}%`;
      bar2.setAttribute("aria-valuenow", String(n));
      bar2.setAttribute("aria-valuemax", String(total));
    }
  }
  return {
    el: el2,
    set(p, when) {
      prog = p;
      at2 = when;
      render();
    },
    clear() {
      prog = null;
      render();
    },
    tick: render
  };
}
function makeWaitingStrip() {
  const count2 = h15("span", {});
  const el2 = h15(
    "div",
    { class: "cb-wait", "data-testid": "waiting-strip" },
    h15("span", { class: "cb-wait-word" }, "waiting"),
    count2
  );
  el2.hidden = true;
  return {
    el: el2,
    setQueued(n) {
      el2.hidden = n <= 0;
      count2.textContent = ` · ${n} queued for the end of this turn`;
    }
  };
}
function clock(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}
function workedFold(msg) {
  const lines = msg.worked?.lines ?? [];
  const history2 = h15(
    "ol",
    { class: "cb-worked-lines" },
    ...lines.map(
      (l) => h15(
        "li",
        { class: "cb-worked-line" },
        h15("span", { class: "cb-worked-at" }, clock(l.at)),
        h15("span", {}, l.text + countText(l.n, l.total))
      )
    )
  );
  const el2 = fold2(msg.body, history2);
  el2.classList.add("cb-worked");
  el2.setAttribute("data-testid", "worked");
  return el2;
}

// dock.ts
var PANE = "casebook.dock";
function storedPane() {
  try {
    const v = sessionStorage.getItem(PANE);
    return v === "open" ? true : v === "closed" ? false : null;
  } catch {
    return null;
  }
}
function storePane(v, key = PANE) {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, v ? "open" : "closed");
  } catch {
  }
}
var SHOWN = "casebook.dock.shown";
function storedShown() {
  try {
    const v = sessionStorage.getItem(SHOWN);
    return v === "open" ? true : v === "closed" ? false : null;
  } catch {
    return null;
  }
}
function stateColor(state) {
  switch (state) {
    case "queued":
      return "var(--kit-wait)";
    case "working":
      return "var(--kit-agent)";
    case "answered":
      return "var(--kit-ok)";
    case "failed":
      return "var(--kit-danger)";
    default:
      return "var(--kit-muted)";
  }
}
function stateLabel(msg) {
  const base = msg.state;
  if (base === "answered") {
    const n = msg.attached?.keys?.length ?? 0;
    if (n > 0) return `${base} · ${pluralize(n, "item")}`;
  }
  return base;
}
function sessionItem(s, extra = "") {
  const el2 = h16(
    "button",
    { class: "cb-dock-pick-item", "data-session": s.id },
    h16("span", { class: "cb-dock-dot" }),
    h16("span", { class: "cb-dock-pick-title" }, sessionTitle(s))
  );
  const meta = [sessionMeta(s), extra].filter(Boolean).join(" · ");
  if (meta) el2.append(h16("span", { class: "cb-dock-pick-meta" }, meta));
  return el2;
}
function renderAgentBody(msg) {
  const wrap = h16("div", { class: "cb-dock-body" });
  const bodyP = h16("p", { class: "cb-dock-bodytext" });
  bodyP.textContent = msg.body;
  wrap.append(bodyP);
  const { attached } = msg;
  if (attached) {
    const links = [];
    if (attached.keys && attached.keys.length > 0) {
      const shown = attached.keys.slice(0, 5);
      for (const k of shown) {
        const a = h16("a", {
          class: "cb-dock-link",
          href: "#",
          onclick(e) {
            e.preventDefault();
            go("item", encodeURIComponent(k));
          }
        });
        a.textContent = keyWithoutKind(k);
        links.push(a);
      }
      if (attached.keys.length > 5) {
        links.push(
          h16(
            "span",
            { class: "cb-dock-link-more" },
            `+${attached.keys.length - 5} more`
          )
        );
      }
    }
    if (attached.open) {
      const k = attached.open;
      const a = h16("a", {
        class: "cb-dock-link",
        href: "#",
        onclick(e) {
          e.preventDefault();
          go("item", encodeURIComponent(k));
        }
      });
      a.textContent = keyWithoutKind(k);
      links.push(a);
    }
    if (attached.rule) {
      const id = attached.rule;
      const a = h16("a", {
        class: "cb-dock-link",
        href: "#",
        onclick(e) {
          e.preventDefault();
          location.hash = ruleHash(id);
        }
      });
      a.textContent = id;
      links.push(a);
    }
    if (attached.job) {
      const id = attached.job;
      const a = h16("a", {
        class: "cb-dock-link",
        href: "#",
        onclick(e) {
          e.preventDefault();
          go("run", encodeURIComponent(id));
        }
      });
      a.textContent = `job ${id}`;
      links.push(a);
    }
    if (links.length > 0) {
      const linkRow = h16("div", { class: "cb-dock-links" }, ...links);
      wrap.append(linkRow);
    }
  }
  return wrap;
}
function renderMsgCard(msg, delivery, sessions, ctx, agentName) {
  if (msg.state === "worked") return workedFold(msg);
  const isAgent = msg.author !== "court";
  const authorLabel = isAgent ? agentName.toUpperCase() : "YOU";
  const age = fmtAge(msg.created_at);
  const headEl = h16(
    "div",
    { class: "cb-dock-ch" },
    h16(
      "span",
      {
        class: isAgent ? "cb-dock-ch-name cb-dock-ch-agent" : "cb-dock-ch-name"
      },
      authorLabel
    ),
    h16("span", { class: "cb-dock-ch-age" }, age)
  );
  let bodyContent;
  if (isAgent) {
    bodyContent = renderAgentBody(msg);
  } else {
    const bodyEl = h16("div", { class: "cb-dock-body" });
    const bodyP = h16("p", { class: "cb-dock-bodytext" });
    bodyP.textContent = msg.body;
    bodyEl.append(bodyP);
    bodyContent = bodyEl;
  }
  let stateEl = null;
  if (!isAgent && msg.state) {
    const validStates = [
      "queued",
      "delivered",
      "received",
      "working",
      "answered",
      "declined",
      "failed",
      "unanswered",
      "interrupted"
    ];
    if (validStates.includes(msg.state)) {
      stateEl = h16("div", {
        class: "cb-dock-state",
        "data-state": msg.state,
        style: `color:${stateColor(msg.state)}`
      });
      stateEl.textContent = stateLabel(msg);
    }
  }
  const fullBody = h16(
    "div",
    { class: "cb-dock-card-body" },
    headEl,
    bodyContent
  );
  if (stateEl) fullBody.append(stateEl);
  const isStuckDelivery = !isAgent && delivery?.stuck === true && msg.delivery_id === delivery.id;
  if (isStuckDelivery && delivery) {
    if (stateEl) {
      const ageText2 = fmtAge(delivery.touched_at);
      const ageStr = ageText2 === "now" ? "just now" : `${ageText2} ago`;
      stateEl.textContent = "";
      stateEl.setAttribute("data-state", "stuck");
      const stuckBold = h16("strong", { style: "font-weight:600" });
      stuckBold.textContent = "stuck";
      stateEl.append(`delivered ${ageStr} · `, stuckBold);
    }
    const d = delivery;
    const releaseBtn = h16("button", {
      class: "kit-btn",
      "data-action": "release",
      onclick() {
        void releaseDelivery(ctx, d.id);
      }
    });
    releaseBtn.textContent = "release";
    const otherSessions = pickable(sessions).filter(
      (s) => s.id !== d.session_id
    );
    const moveBtn = h16("button", {
      class: "kit-btn",
      "data-action": "move",
      onclick() {
        void openMoveSheet(ctx, d, otherSessions);
      }
    });
    moveBtn.textContent = "move to another session";
    fullBody.append(h16("div", { class: "cb-dock-stuck" }, releaseBtn, moveBtn));
  }
  const el2 = card5({
    edge: isAgent ? "agent" : "signal",
    body: fullBody
  });
  el2.classList.add("cb-dock-card");
  if (isAgent) el2.classList.add("cb-dock-card--agent");
  else el2.classList.add("cb-dock-card--you");
  return el2;
}
async function releaseDelivery(ctx, id) {
  try {
    await ctx.api.post("/deliveries/release", { id });
  } catch (err) {
    console.error("[dock] release delivery:", err);
  }
}
async function moveDelivery(ctx, id, sessionId) {
  try {
    await ctx.api.post("/deliveries/move", { id, session: sessionId });
  } catch (err) {
    console.error("[dock] move delivery:", err);
  }
}
function openMoveSheet(ctx, delivery, targets) {
  const items = targets.map((s) => {
    const el2 = sessionItem(s);
    el2.onclick = () => {
      void moveDelivery(ctx, delivery.id, s.id);
      sheet5.close();
    };
    return el2;
  });
  if (items.length === 0) {
    const noOther = h16(
      "p",
      { class: "cb-dock-pick-empty" },
      "no other sessions"
    );
    items.push(noOther);
  }
  const content = h16("div", { class: "cb-dock-pick-list" }, ...items);
  const sheet5 = {
    el: h16("div", { class: "cb-dock-pick-sheet" }, content),
    close() {
      this.el.remove();
    }
  };
  document.body.append(sheet5.el);
  function onKey(e) {
    if (e.key === "Escape") {
      sheet5.close();
      document.removeEventListener("keydown", onKey);
    }
  }
  document.addEventListener("keydown", onKey);
  return Promise.resolve();
}
async function moveSession(ctx, fromSession, toSession) {
  try {
    await ctx.api.post("/sessions/move", {
      session: fromSession,
      target: toSession
    });
  } catch (err) {
    console.error("[dock] move session:", err);
  }
}
function openSessionMoveSheet(ctx, fromSession, targets) {
  const items = targets.map((s) => {
    const el2 = sessionItem(s);
    el2.onclick = () => {
      void moveSession(ctx, fromSession, s.id);
      sheet5.close();
    };
    return el2;
  });
  if (items.length === 0) {
    const noOther = h16(
      "p",
      { class: "cb-dock-pick-empty" },
      "no other sessions"
    );
    items.push(noOther);
  }
  const content = h16("div", { class: "cb-dock-pick-list" }, ...items);
  const sheet5 = {
    el: h16("div", { class: "cb-dock-pick-sheet" }, content),
    close() {
      this.el.remove();
    }
  };
  document.body.append(sheet5.el);
  function onKey(e) {
    if (e.key === "Escape") {
      sheet5.close();
      document.removeEventListener("keydown", onKey);
    }
  }
  document.addEventListener("keydown", onKey);
  return Promise.resolve();
}
function buildSessionPicker(sessions, currentId, onSelect) {
  const items = pickable(sessions).map((s) => {
    const el2 = sessionItem(s, s.busy ? "busy" : "");
    if (s.id === currentId) el2.classList.add("cb-dock-pick-item--on");
    el2.onclick = () => {
      onSelect(s.id);
      picker.remove();
    };
    return el2;
  });
  if (items.length === 0) {
    items.push(
      h16("p", { class: "cb-dock-pick-empty" }, "no agent sessions are here")
    );
  }
  const picker = h16(
    "div",
    { class: "cb-dock-picker", role: "listbox" },
    ...items
  );
  function onKey(e) {
    if (e.key === "Escape") {
      picker.remove();
      document.removeEventListener("keydown", onKey);
    }
  }
  document.addEventListener("keydown", onKey);
  function onClick(e) {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener("click", onClick);
    }
  }
  setTimeout(() => document.addEventListener("click", onClick), 0);
  return picker;
}
function makeDock(ctx) {
  let sessions = [];
  let currentSessionId = "";
  let threads = [];
  let currentThreadId = 0;
  let messages = [];
  let currentDelivery = null;
  let urlRead = false;
  let auto = false;
  const sessionDot = h16("span", { class: "cb-dock-dot" });
  const sessionLabelEl = h16("span", {
    class: "cb-dock-session-label",
    "data-testid": "dock-session-name"
  });
  const sessionMetaEl = h16("div", {
    class: "cb-dock-meta-row",
    "data-testid": "dock-session-meta"
  });
  const sessionPickerBtn = h16("button", {
    class: "cb-dock-agent-btn",
    "aria-label": "pick agent session",
    onclick(e) {
      e.stopPropagation();
      const p = buildSessionPicker(sessions, currentSessionId, (id) => {
        void attach(id, true);
      });
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      p.style.top = `${rect.bottom + 4}px`;
      p.style.right = `${window.innerWidth - rect.right}px`;
      document.body.append(p);
    }
  });
  sessionPickerBtn.textContent = "AGENT ▾";
  const collapseBtn = h16(
    "button",
    {
      type: "button",
      class: "cb-dock-collapse",
      title: "collapse the agent pane",
      "aria-label": "collapse the agent pane",
      onclick() {
        setManual(false);
      }
    },
    "›"
  );
  const opener = h16(
    "button",
    {
      type: "button",
      class: "cb-dock-opener",
      title: "open the agent pane",
      "aria-label": "open the agent pane",
      onclick() {
        setManual(true);
      }
    },
    h16("span", { class: "cb-dock-opener-dot" }),
    h16("span", { class: "cb-dock-opener-label" }, "agent")
  );
  const leftStatusRow = h16("div", { class: "cb-dock-left-row" });
  leftStatusRow.hidden = true;
  const sessionHeader = h16(
    "div",
    { class: "cb-dock-header" },
    h16(
      "div",
      { class: "cb-dock-header-row" },
      h16("span", { class: "cb-dock-who" }, sessionDot, sessionLabelEl),
      sessionPickerBtn,
      collapseBtn
    ),
    sessionMetaEl,
    leftStatusRow
  );
  const chooser = h16("div", {
    class: "cb-dock-chooser",
    "data-testid": "dock-chooser"
  });
  chooser.hidden = true;
  const threadChips = h16("div", { class: "cb-dock-threads" });
  const messageArea = h16("div", {
    class: "cb-dock-messages",
    "data-testid": "dock-messages"
  });
  const blocked = () => {
    switch (attachedState(currentSessionId, sessions)) {
      case "none":
        return "choose a session first";
      case "left":
      case "unknown":
        return "your session left";
    }
    return "";
  };
  const batchTray = makeBatchTray(ctx, {
    blocked,
    say: (text) => composer.say(text),
    currentSession: () => currentSessionId,
    threadMoved: () => void loadThreads()
  });
  const progLine = makeProgressLine();
  const waitStrip = makeWaitingStrip();
  const composer = makeComposer(ctx, {
    currentThread: () => currentThreadId,
    currentSession: () => currentSessionId,
    blocked,
    threadMoved: () => void loadThreads(),
    threadCreated(t) {
      threads = [...threads, t];
      currentThreadId = t.id;
      renderThreadChips();
      void batchTray.load(t.id);
    }
  });
  const rail = h16("div", { class: "cb-dock-inner" });
  rail.append(
    opener,
    sessionHeader,
    chooser,
    threadChips,
    messageArea,
    progLine.el,
    waitStrip.el,
    composer.el
  );
  let manual = storedPane();
  function setManual(v) {
    manual = v;
    storePane(v);
    paintPane();
  }
  let loaded = false;
  const shownBefore = storedShown();
  function paintPane() {
    const focused = document.activeElement === composer.input && rail.contains(composer.input);
    let open = dockOpen(messages.length > 0, focused, manual);
    if (!loaded && manual === null && shownBefore !== null) open = shownBefore;
    if (loaded) storePane(open, SHOWN);
    rail.parentElement?.classList.toggle("cb-dock-strip", !open);
    rail.classList.toggle("cb-dock-folded", !open);
  }
  function agentName() {
    return sessions.find((s) => s.id === currentSessionId)?.harness || "agent";
  }
  function renderHeader() {
    const state = attachedState(currentSessionId, sessions);
    sessionHeader.setAttribute("data-attach", state);
    const sess = sessions.find((s) => s.id === currentSessionId);
    ctx.setDockTarget(
      sess && !blocked() ? { id: sess.id, name: sessionTitle(sess) } : null
    );
    if (!sess) {
      sessionDot.style.background = "var(--kit-muted)";
      sessionLabelEl.textContent = state === "unknown" ? "session not here" : "no session";
      sessionMetaEl.textContent = "";
      sessionHeader.removeAttribute("title");
      leftStatusRow.hidden = true;
      if (state === "unknown") sessionHeader.setAttribute("data-left", "1");
      else sessionHeader.removeAttribute("data-left");
      renderChooser(state, null);
      return;
    }
    const stale = !!sess.left;
    sessionDot.style.removeProperty("background");
    sessionLabelEl.textContent = sessionTitle(sess);
    sessionMetaEl.textContent = sessionMeta(sess);
    sessionHeader.title = sess.id;
    if (stale) {
      leftStatusRow.textContent = "";
      const moveLink = h16("button", {
        class: "cb-dock-move-link",
        "data-testid": "dock-move-link",
        onclick(e) {
          e.stopPropagation();
          const others = pickable(sessions).filter((s) => s.id !== sess.id);
          void openSessionMoveSheet(ctx, sess.id, others);
        }
      });
      moveLink.textContent = "move to…";
      const parts = [h16("span", {}, "left")];
      if (sess.queued > 0) {
        parts.push(h16("span", { class: "cb-dock-sep" }, "·"));
        parts.push(h16("span", {}, `${sess.queued} queued`));
      }
      parts.push(h16("span", { class: "cb-dock-sep" }, "·"));
      parts.push(moveLink);
      leftStatusRow.append(...parts);
      leftStatusRow.hidden = false;
      sessionHeader.setAttribute("data-left", "1");
    } else {
      leftStatusRow.hidden = true;
      leftStatusRow.textContent = "";
      sessionHeader.removeAttribute("data-left");
    }
    renderChooser(state, sess);
  }
  function renderChooser(state, sess) {
    const none = state === "none";
    threadChips.hidden = none;
    messageArea.hidden = none;
    chooser.textContent = "";
    if (state === "here") {
      chooser.hidden = true;
      return;
    }
    chooser.hidden = false;
    chooser.setAttribute("data-state", state);
    const offered = pickable(sessions).filter((s) => s.id !== currentSessionId);
    const lead = h16("p", {
      class: "cb-dock-chooser-lead",
      "data-testid": "dock-chooser-lead"
    });
    if (none) {
      lead.textContent = offered.length > 0 ? "Choose the session your messages go to." : "No agent session is here. Ask one to casebook_open this page.";
    } else {
      const who = sess ? sessionTitle(sess) : "This page’s session";
      lead.textContent = offered.length > 0 ? `${who} left. Messages wait for it; choose a session to keep talking.` : `${who} left. Messages wait for it; no other session is here.`;
    }
    chooser.append(lead);
    for (const s of offered) {
      const el2 = sessionItem(s, s.busy ? "busy" : "");
      el2.onclick = () => {
        void attach(s.id, true);
      };
      chooser.append(el2);
    }
  }
  function renderThreadChips() {
    threadChips.innerHTML = "";
    for (const t of threads) {
      const chip = h16("button", {
        class: "kit-chip" + (t.id === currentThreadId ? " on" : ""),
        "data-thread": String(t.id),
        onclick() {
          void switchThread(t.id);
        }
      });
      chip.textContent = t.name;
      threadChips.append(chip);
    }
    const addChip = h16("button", {
      class: "kit-chip cb-dock-add",
      "data-testid": "dock-add-thread",
      onclick() {
        void newThread();
      }
    });
    addChip.textContent = "+";
    threadChips.append(addChip);
  }
  function renderMessages() {
    for (const c of [...messageArea.children]) {
      if (c !== batchTray.el) c.remove();
    }
    if (batchTray.el.parentNode !== messageArea) {
      messageArea.append(batchTray.el);
    }
    const cards = [];
    if (messages.length === 0) {
      cards.push(h16("p", { class: "cb-dock-empty" }, "no messages"));
    }
    const name = agentName();
    for (const msg of messages) {
      cards.push(renderMsgCard(msg, currentDelivery, sessions, ctx, name));
    }
    batchTray.el.before(...cards);
    messageArea.scrollTop = messageArea.scrollHeight;
    paintPane();
  }
  const loadSessions = coalesced(fetchSessions);
  async function fetchSessions() {
    try {
      const attached = currentSessionId || (urlRead ? "" : urlSession(location.href));
      const sv = await ctx.api.get(
        "/sessions",
        attached ? { session: attached } : void 0
      );
      sessions = sv.sessions ?? [];
      if (!currentSessionId) {
        const fromUrl = urlRead ? "" : urlSession(location.href);
        urlRead = true;
        const r = resolveAttachment(fromUrl, sessions);
        if (r.id) {
          await attach(r.id, !r.auto);
          return;
        }
      } else if (auto && pickable(sessions).length > 1) {
        detach();
        return;
      } else {
        await loadDelivery();
      }
      renderHeader();
      updateSessionParts();
    } catch (err) {
      console.error("[dock] loadSessions:", err);
    }
  }
  async function attach(id, explicit) {
    auto = !explicit;
    if (explicit) {
      const next = urlWithSession(location.href, id);
      if (next !== location.href) {
        history.replaceState(history.state, "", next);
      }
      ctx.setDockSession(id);
    }
    if (id === currentSessionId) {
      renderHeader();
      return;
    }
    await switchSession(id);
  }
  async function loadThreads() {
    if (!currentSessionId) return;
    try {
      const tv = await ctx.api.get("/threads", {
        session: currentSessionId
      });
      threads = tv.threads ?? [];
      if (!threads.some((t) => t.id === currentThreadId)) {
        currentThreadId = threads.length > 0 ? threads[0].id : 0;
      }
      renderThreadChips();
      await loadMessages();
      await loadDelivery();
      await batchTray.load(currentThreadId);
    } catch (err) {
      console.error("[dock] loadThreads:", err);
    }
  }
  let shownThread = 0;
  async function loadMessages() {
    if (!currentThreadId) {
      messages = [];
      shownThread = 0;
      loaded = true;
      renderMessages();
      return;
    }
    try {
      const thread = currentThreadId;
      const mv = await ctx.api.get("/messages", {
        thread: String(thread)
      });
      if (thread !== currentThreadId) return;
      const next = threadOrder(mv.messages ?? []);
      const arrived = shownThread === thread && next.length > messages.length;
      messages = next;
      shownThread = thread;
      loaded = true;
      if (arrived && manual === false) setManual(null);
      renderMessages();
    } catch (err) {
      console.error("[dock] loadMessages:", err);
    }
  }
  async function loadDelivery() {
    if (!currentSessionId) return;
    try {
      const dv = await ctx.api.get("/session/delivery", {
        session: currentSessionId
      });
      currentDelivery = dv.delivery ?? null;
      renderMessages();
    } catch (err) {
      console.error("[dock] loadDelivery:", err);
    }
  }
  let progSeq = 0;
  async function loadProgress() {
    const sid = currentSessionId;
    const mine = ++progSeq;
    if (!sid) {
      progLine.clear();
      return;
    }
    try {
      const pv = await ctx.api.get("/session/progress", {
        session: sid
      });
      if (sid !== currentSessionId || mine !== progSeq) return;
      if (pv.progress) {
        const age = Date.parse(pv.now) - Date.parse(pv.progress.updated_at);
        progLine.set(pv.progress, Date.now() - Math.max(0, age));
      } else {
        progLine.clear();
      }
    } catch (err) {
      console.error("[dock] loadProgress:", err);
    }
  }
  function updateSessionParts() {
    const sess = sessions.find((s) => s.id === currentSessionId);
    const turn = !!sess && sess.busy && !sess.left;
    waitStrip.setQueued(turn ? sess.queued : 0);
    composer.setAgent(sess?.harness ?? "");
    ctx.setAgentName(sess?.harness ?? "");
  }
  const tellAttached = latestInOrder(
    (id) => ctx.api.post("/page/attached", { session: id })
  );
  function detach() {
    auto = false;
    if (currentSessionId) tellAttached("");
    currentSessionId = "";
    currentThreadId = 0;
    threads = [];
    messages = [];
    currentDelivery = null;
    void batchTray.load(0);
    progLine.clear();
    renderHeader();
    renderThreadChips();
    renderMessages();
    updateSessionParts();
  }
  async function switchSession(id) {
    currentSessionId = id;
    tellAttached(id);
    currentThreadId = 0;
    void batchTray.load(0);
    threads = [];
    messages = [];
    currentDelivery = null;
    progLine.clear();
    renderHeader();
    renderThreadChips();
    renderMessages();
    updateSessionParts();
    await Promise.all([loadThreads(), loadProgress()]);
  }
  async function switchThread(id) {
    currentThreadId = id;
    messages = [];
    currentDelivery = null;
    renderThreadChips();
    renderMessages();
    await loadMessages();
    await loadDelivery();
    await batchTray.load(id);
  }
  async function newThread() {
    const sessId = currentSessionId;
    const why = blocked();
    if (why) {
      composer.say(why);
      return;
    }
    try {
      const t = await ctx.api.post("/threads", {
        session: sessId,
        name: "thread"
      });
      threads = [...threads, t];
      currentThreadId = t.id;
      messages = [];
      currentDelivery = null;
      renderThreadChips();
      renderMessages();
      await batchTray.load(t.id);
    } catch (err) {
      console.error("[dock] newThread:", err);
    }
  }
  ctx.on("sessions", (data) => {
    void loadSessions();
    const d = data;
    if (d?.moved_from && d.moved_from === currentSessionId) {
      void loadThreads();
    }
  });
  ctx.on("thread", (data) => {
    void loadThreads();
    void data;
  });
  ctx.on("messages", (data) => {
    const d = data;
    if (!d.ids) return;
    const msgIds = new Set(d.ids);
    if (messages.some((m) => msgIds.has(m.id))) {
      void loadMessages();
      void loadDelivery();
    }
  });
  ctx.on("delivery", (data) => {
    const d = data;
    const isOurs = !d.session || d.session === currentSessionId || d.from === currentSessionId || d.id !== void 0 && currentDelivery?.id === d.id;
    if (d.from && d.from === currentSessionId && d.session !== d.from) {
      void loadThreads();
      void loadSessions();
    } else if (isOurs) {
      void loadMessages().then(() => loadDelivery());
      void loadSessions();
    }
  });
  ctx.on("progress", (data) => {
    const p = data;
    if (p.session_id !== currentSessionId) return;
    progSeq++;
    progLine.set(p, Date.now());
  });
  ctx.on("settled", (data) => {
    const d = data;
    if (d.session !== currentSessionId) return;
    progSeq++;
    progLine.clear();
    void loadMessages();
    void loadSessions();
  });
  ctx.on("gap", () => {
    void loadSessions();
    void loadThreads();
    void loadProgress();
  });
  ctx.on("drafts", () => {
    void batchTray.reload();
  });
  ctx.on("batch", () => {
    void batchTray.reload();
    void loadMessages();
    void loadSessions();
  });
  ctx.on("message", (data) => {
    const m = data;
    if (m.thread_id === currentThreadId) {
      void loadMessages();
      if (m.state === "draft") void batchTray.reload();
    }
    void loadSessions();
  });
  setInterval(() => progLine.tick(), 1e3);
  ctx.keys.register({
    keys: ".",
    label: "focus the composer",
    group: "agent",
    run() {
      if (manual !== true) setManual(true);
      composer.focus();
    }
  });
  ctx.keys.register({
    keys: "⌘↵",
    label: "add to batch",
    group: "agent",
    inField: true,
    run(e) {
      if (e.target !== composer.input) return false;
      composer.addToBatch();
    }
  });
  void loadSessions();
  queueMicrotask(paintPane);
  return {
    el: rail,
    setAttached(a, jobTitle2) {
      composer.setAttached(a, jobTitle2);
    },
    focusComposer() {
      if (manual !== true) setManual(true);
      composer.focus();
    },
    currentThread() {
      return currentThreadId;
    },
    currentSession() {
      return currentSessionId;
    },
    sendText(body, attached, purpose) {
      if (manual !== true) setManual(true);
      return composer.sendText(body, attached, purpose);
    },
    pane: () => manual,
    setPane(v) {
      if (v !== manual) setManual(v);
    }
  };
}

// entry.ts
registerSection(makeDecide);
registerSection(makeApply);
registerDock(makeDock);
boot();
