// apply.ts — review and run (spec §5, points 17-19; Court, 2026-10-17:
// decide → review → run): decided items wait in review, grouped by what
// will happen; a group's button runs it, and the job runs in run while Court
// answers what needs him.
//
// review lists the decided items waiting, grouped by what will happen
// (serve's to-apply groups, "Delete 3 branches"), each group collapsed with
// decide's heads; ticking narrows a group. An item in a job approved,
// running or paused leaves its group. A group's head is its button
// ("Delete 3 branches…", or, with some ticked, for those): it opens the
// group in the middle pane (#/review?group=<id>). Opening it builds serve's
// plan for exactly those items (serve reuses the plan it built for them, or
// replaces one that held any of them), so what the pane shows is serve's:
// the title with its counts ("Delete 7 repos"), what it does (red "Cannot be
// undone." when a step is permanent), "runs through <agent>" (the agent the
// page is attached to, the only runner), one button named for the action,
// then each group's where, undo and exact commands. The button runs it: a
// permanent step asks first, naming each item; then serve approves it and
// the job opens in run. Leaving the group runs nothing. With no agent
// attached, a plan with outward steps says "Open casebook from an agent to
// run this." and its button is off; an all-local plan needs no agent. A plan
// serve refuses as stale shows serve's words and "sync first": serve syncs
// (POST /api/sync), and when the live wire says the sync is done the group
// is opened again. The foot says how old serve's observations are.
//
// run lists jobs approved, running or paused on top (each row its lanes,
// its title, a thin progress bar and n/total or "queued", a signal line when
// something needs Court), then the finished ones (done, failed) collapsed.
// #/run/<job> opens a job: its facts, the needs-you cards (signal edge; a
// text card's post and close · edit text · close without comment · skip, a
// batch's confirm, a failed step's hand to the agent, the agent's paused
// step), and the steps table (✓ verified, ‖ paused, · next), with undo on a
// finished step serve says it can undo.
//
// The bar's primary follows what is open: the group's action in review
// (once it can run), Sync first after a stale refusal, Pause job while a job
// runs, Resume while it is paused. Live job, step and needs_you events mark
// the job they name; one reload runs at a time (at most one more queued)
// and fetches only those jobs; decisions (index, decided) reload the waiting
// groups. A redraw keeps what Court was doing: an open "edit text" field's
// text, the focused control and the caret. A reload never draws over a newer
// reply. While review or run is the active section it feeds the composer
// {job: <id>} for the open job and {} otherwise; hidden, it never touches the
// attached line or the bar's primary.

import {
  ApiError,
  createSelection,
  h,
  facts,
  buttons,
  card,
  sheet,
  type KeyBinding,
  type Primary,
  type Selection,
} from '/_kit/kit.js';
import type {
  AnswerResult,
  DecisionVocabView,
  FilterRow,
  FiltersView,
  GroupView,
  HeldBack,
  ItemDetailView,
  ItemView,
  ItemsView,
  Job,
  JobStep,
  JobView,
  JobsView,
  NeedsYou,
  NeedsYouView,
  PlanView,
  Session,
  SessionsView,
  Step,
  SummaryView,
  SyncEvent,
  SyncView,
  UndoResult,
  Waiting,
} from './wire.d.ts';
import type { Ctx, Section } from './app.ts';
import { keyWithoutKind, pluralize } from './decide-math.ts';
import {
  actionTitle,
  groupSteps,
  jobTitle,
  laneLabel,
  makeSeq,
  needsSession,
  openCardsByJob,
  progress,
  publicLine,
  reviewKick,
  reviewLine,
  untickHidden,
  ranLine,
  runBulk,
  tickedRunWords,
  waitBlocks,
  heldText,
  otherHalf,
  runsNow,
  stepTags,
  tagText,
  type Tag,
  applyLabel,
  runOrder,
  runsThrough,
  startedKeys,
  heldOutside,
  planTitle,
  isRunning,
  type StepGroup,
  stepLine,
} from './apply-text.ts';
import { pathEscape } from './router-helpers.ts';
import { getVocab } from './decide.ts';
import { coalesced } from './coalesce.ts';
import {
  makePane,
  setHashQuery,
  type Pane,
  type PaneGroup,
} from './list-pane.ts';
import {
  paneParams,
  paneQuery,
  withPane,
  type PaneQuery,
} from './list-pane-text.ts';
import { midHead, midRows } from './mid.ts';
import { makeObs } from './obs.ts';
import { renderJob, renderRan, type JobHooks } from './ran.ts';

// Decided items are fetched 200 at a time (serve's cap, like decide).
const PAGE = 200;
// The steps table shows this many rows at a time.
const STEPS_PAGE = 200;

// run's groups that start open (serve's ids; a waiting group's id is
// serve's too, "<disposition>|<kind>").
const NEEDS_YOU = 'needs-you';
const RUNNING = 'running';

type Mode = 'review' | 'run';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- keeping focus across a redraw ------------------------------------------
//
// A live event redraws the open job. What Court was doing there survives it:
// the focused control is found again in the new drawing by what it is (its
// card, step or session, its kind, its label), and a text field keeps its
// caret. (An edit's text itself is kept by the section, per card.)

interface FocusSnap {
  key: string;
  start: number | null;
  end: number | null;
}

function focusKey(el: Element): string {
  const host = el.closest(
    '[data-card],[data-step],[data-session],[data-testid]',
  );
  const hostKey = host
    ? ['card', 'step', 'session', 'testid']
        .map((a) => host.getAttribute(`data-${a}`) ?? '')
        .join('/')
    : '';
  const own =
    el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.className
      : (el.textContent ?? '');
  return `${hostKey}|${el.tagName}|${own}`;
}

function focusSnapshot(root: HTMLElement): FocusSnap | null {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) return null;
  const field =
    a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement
      ? a
      : null;
  return {
    key: focusKey(a),
    start: field ? field.selectionStart : null,
    end: field ? field.selectionEnd : null,
  };
}

function focusRestore(root: HTMLElement, snap: FocusSnap | null): void {
  if (!snap) return;
  const els = root.querySelectorAll<HTMLElement>(
    'button, textarea, input, a[href], [tabindex]',
  );
  for (const el of els) {
    if (focusKey(el) !== snap.key) continue;
    el.focus({ preventScroll: true });
    if (
      (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
      snap.start !== null
    ) {
      el.setSelectionRange(snap.start, snap.end ?? snap.start);
    }
    return;
  }
}

export function makeApply(ctx: Ctx): Section {
  const readEl = h('div', { class: 'kit-read cb-apply-read' });
  let mode: Mode = 'review';
  let jobs: Job[] = [];
  let cards: NeedsYou[] = [];
  let sessions: Session[] = [];
  let items: ItemView[] = [];
  let itemsTotal = 0;
  let itemsLoaded = false;
  // serve's waiting groups (GET /api/items?view=to-apply), in its order.
  let groups: GroupView[] = [];
  // serve's decision vocabulary: a group's words for a count.
  let vocab: DecisionVocabView | null = null;
  // The parts Court opened or closed (flipped from how they start): run's
  // Running starts open; Done and every waiting group start collapsed
  // (Court, 2026-10-17: what a group is about stands out).
  const flipped = new Set<string>();
  const startsOpen = (id: string): boolean =>
    id === RUNNING || id === NEEDS_YOU;
  const collapsed = {
    has: (id: string): boolean => startsOpen(id) === flipped.has(id),
    delete(id: string): boolean {
      if (!this.has(id)) return false;
      if (flipped.has(id)) flipped.delete(id);
      else flipped.add(id);
      return true;
    },
    add(id: string): void {
      if (this.has(id)) return;
      if (flipped.has(id)) flipped.delete(id);
      else flipped.add(id);
    },
  };
  let active = false;

  // review: the group the address asks to tick (#/review?group=<id>) until
  // the groups load, whether a plan for the ticks is shown, the items it is
  // for and serve's plan.
  let wantGroup = '';
  let reviewOpen = false;
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  const sameKeys = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((k, i) => k === b[i]);
  let reviewKeys: string[] = [];
  let reviewView: PlanView | null = null;
  // drawnView is the plan drawReview last put on the page: only it runs.
  let drawnView: PlanView | null = null;
  // reviewPending: review's list is loading (a filter, a search, a reload);
  // until it is drawn, and the ticked document with it, nothing runs.
  let reviewPending = false;
  // runPending: the same for run's list.
  let runPending = false;
  // serve's words when the group's plan wasn't built (nothing to plan, an
  // item already running): shown in the pane, no "sync first".
  let reviewNote = '';
  let refusal = '';

  // run: the job open.
  let openId: number | null = null;
  let open: JobView | null = null;
  let stepsShown = STEPS_PAGE;
  let note = '';
  let busy = false;
  let painting = false;
  // Whether a sync (POST /api/sync) is running: a refused plan waits for it.
  let syncing = false;
  let syncError = '';
  // A refused plan is asked for again once a sync Court asked for here
  // (sync first, in this tab) is done.
  let afterSync = false;
  // An open "edit text" field's text, by card id: a redraw keeps it.
  const editors = new Map<number, string>();
  const itemsSeq = makeSeq();
  const listSeq = makeSeq();
  const jobSeq = makeSeq();
  const planSeq = makeSeq();

  // The runner: the session the page is attached to (the dock's, while it
  // is here), or none.
  const runner = () => ctx.dockTarget();
  const harnessOf = (id: string): string =>
    sessions.find((s) => s.id === id)?.harness || '';
  // The agent outward steps run through: the runner's, by its harness.
  const runnerAgent = (): string | null => {
    const t = runner();
    if (!t) return null;
    return harnessOf(t.id) || ctx.agentName() || 'agent';
  };
  // The agent a job's outward steps went to: its session's.
  const agentOf = (job: Job): string =>
    harnessOf(job.session) || ctx.agentName() || 'agent';

  // ---- the lists: review's items and run's jobs, each on its pane ----

  // review's search and filters: the address keeps them
  // (#/review?filters=…&q=…), and serve narrows to them (GET /api/items
  // view=to-apply). The saved filters are decide's.
  let reviewQ: PaneQuery = { filters: [], q: '' };
  let runQ: PaneQuery = { filters: [], q: '' };
  let filterRows: FilterRow[] = [];
  // What the page knows of each waiting item's group: loaded rows, and a
  // group fetched whole (a tick on a page not loaded is counted from here).
  const groupOfKey = new Map<string, string>();
  const reviewSel: Selection = createSelection();
  const runSel: Selection = createSelection();
  // Each tab's generation: it moves when its ticks or what it shows change.
  // A whole-group fetch that finishes after it moved adds nothing.
  const gen = { review: 0, run: 0 };
  reviewSel.onChange(() => gen.review++);
  runSel.onChange(() => gen.run++);

  // In a job approved, running or paused: key → that job. Such an item
  // leaves its waiting group (a plan holds nothing: it is review's own).
  const held = () => startedKeys(jobs);
  const order = () => runOrder(jobs);

  // groupName is a waiting group's kind, plural ("repos"); choiceOf its
  // decision as decide words it ("delete it"); doneOf what it did ("deleted it").
  const kindOfGroup = (g: GroupView): string =>
    g.id.slice(g.id.indexOf('|') + 1);
  const groupName = (g: GroupView): string =>
    kindVocab(kindOfGroup(g))?.nouns ?? '';
  const choiceVocabOf = (g: GroupView) =>
    kindVocab(kindOfGroup(g))?.choices?.find(
      (c) => c.disposition === g.disposition,
    );
  const choiceOf = (g: GroupView): string => choiceVocabOf(g)?.label ?? '';
  const doneOf = (g: GroupView): string => choiceVocabOf(g)?.done ?? '';
  // titleOf names a plan with its counts, in serve's nouns: "Delete 7 repos".
  const titleOf = (j: Job): string =>
    planTitle(j, (kind) => {
      const kv = kindVocab(kind);
      return kv ? [kv.noun, kv.nouns] : [kind, `${kind}s`];
    });
  const kindVocab = (kind: string) =>
    vocab?.kinds?.find((k) => k.kind === kind);
  // labelFor names n items of waiting group g in serve's words ("Delete 3
  // branches"); before the vocabulary loads, serve's label for the group.
  function labelFor(g: GroupView, n: number): string {
    const kv = kindVocab(kindOfGroup(g));
    if (!kv || !g.many) return g.label;
    return applyLabel(g.many, kv.noun, kv.nouns, n);
  }
  // waiting is the group's items not held by a job (the loaded ones).
  const waiting = (g: GroupView) =>
    items.filter((it) => it.group === g.id && !held().has(it.key));
  // waitingCount is how many of g's items wait: serve's count less those a
  // job holds (every loaded one; one not loaded counts once, by its key).
  function waitingCount(g: GroupView): number {
    const loaded = new Set(items.map((i) => i.key));
    let n = items.filter(
      (it) => it.group === g.id && held().has(it.key),
    ).length;
    if (itemsTotal > items.length) n += heldOutside(jobs, g.id, loaded);
    return Math.max(0, g.total - n);
  }
  const tickedIn = (id: string): string[] =>
    reviewSel.ids().filter((k) => groupOfKey.get(k) === id);
  // tickedKeys is every ticked item, group by group in the list's order,
  // in key order in each (ticked again, an item is the same plan).
  const tickedKeys = (): string[] =>
    groups.flatMap((g) => tickedIn(g.id).sort());

  // run's items (GET /api/items view=run: each item a job ran on, grouped by
  // what happened), its groups, and each item's group (a tick on a page not
  // loaded is counted from here).
  let runItems: ItemView[] = [];
  let runTotal = 0;
  let runGroups: GroupView[] = [];
  const runGroupOfKey = new Map<string, string>();
  const runItemOf = new Map<string, ItemView>();
  const noteRun = (it: ItemView): void => {
    runGroupOfKey.set(it.key, it.group);
    runItemOf.set(it.key, it);
  };
  const noteReview = (it: ItemView): void => {
    groupOfKey.set(it.key, it.group);
  };
  const runSeq = makeSeq();
  // The item run shows (#/run?item=<key>): what ran on it, and its job.
  let ranKey = '';
  let ranDetail: ItemDetailView | null = null;
  let ranJob: JobView | null = null;
  const ranSeq = makeSeq();
  const runItemQuery = (): string =>
    ranKey ? `item=${encodeURIComponent(ranKey)}` : '';

  const reviewPane: Pane<ItemView> = makePane<ItemView>(
    ctx,
    'review',
    reviewSel,
    {
      row(it: ItemView) {
        const g = groups.find((x) => x.id === it.group);
        const st = reviewLine(it, g ? doneOf(g) : '');
        return {
          id: it.key,
          key: it.key,
          title: it.title || undefined,
          stands: st.text,
          tone: st.tone,
        };
      },
      groupOf: (it: ItemView) => it.group,
      onOpen() {
        // review has no item page: a row's click ticks it.
        if (!painting) reviewPane.handle.toggle();
      },
      onQuery(q: PaneQuery) {
        reviewQ = q;
        setHashQuery(withPane('', reviewQ));
        void loadItems(0, true);
      },
      onToggle(id: string) {
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        paintList();
      },
      onTickGroup(id: string) {
        void tickGroup(id);
      },
      tickedIn,
      onMore() {
        void loadItems(items.length);
      },
      onFilterOpen(row: FilterRow) {
        ctx.route.go('decide', '', `filters=${row.filter.id}`);
      },
      onFilterNew() {
        ctx.route.go('decide', '', 'new=filter');
      },
    },
  );

  const runPane: Pane<ItemView> = makePane<ItemView>(ctx, 'run', runSel, {
    row(it: ItemView) {
      const st = it.ran
        ? ranLine(it.ran, it.holds ?? [])
        : { text: '', tone: 'muted' as const };
      return {
        id: it.key,
        key: it.key,
        title: it.title || undefined,
        stands: st.text,
        tone: st.tone,
      };
    },
    groupOf: (it: ItemView) => it.group,
    onOpen(it: ItemView) {
      if (painting) return;
      ctx.route.go(
        'run',
        '',
        withPane(`item=${encodeURIComponent(it.key)}`, runQ),
      );
    },
    onQuery(q: PaneQuery) {
      runQ = q;
      setHashQuery(withPane(runItemQuery(), runQ));
      void loadRun(0, true);
    },
    onToggle(id: string) {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      paintList();
    },
    onTickGroup(id: string) {
      void tickRunGroup(id);
    },
    tickedIn: (id: string) =>
      runSel.ids().filter((k) => runGroupOfKey.get(k) === id),
    onMore() {
      void loadRun(runItems.length);
    },
    onFilterOpen(row: FilterRow) {
      ctx.route.go('decide', '', `filters=${row.filter.id}`);
    },
    onFilterNew() {
      ctx.route.go('decide', '', 'new=filter');
    },
  });
  reviewPane.el.classList.add('cb-apply-list');
  runPane.el.classList.add('cb-apply-list');
  const listEl = h(
    'div',
    { class: 'kit-list cb-panes' },
    reviewPane.el,
    runPane.el,
  );
  function showPane(): void {
    reviewPane.el.hidden = mode !== 'review';
    runPane.el.hidden = mode !== 'run';
  }
  showPane();

  // Ticks open their plan in the middle (after a moment, so a run of ticks
  // asks once); with none, the overview.
  // run: ticked items show in the middle with the buttons that fit them
  // all; unticked, the item or job open, or the overview, again.
  // runTickedOn: the middle shows what is ticked (until an item or a job
  // is opened, or nothing is ticked).
  let runTickedOn = false;
  runSel.onChange(() => {
    runPane.paintHeads();
    runTickedOn = runSel.ids().length > 0;
    if (mode !== 'run') return;
    if (runTickedOn) drawRunTicked();
    else if (openId !== null) drawOpen();
    else if (ranKey) drawRan();
    else drawOverview();
  });

  reviewSel.onChange(() => {
    reviewPane.paintHeads();
    if (mode !== 'review') return;
    // Ticks only cover what the plan drawn is for: the buttons go off now,
    // not after the moment the new plan takes.
    if (!sameKeys(tickedKeys(), reviewKeys)) freezeMid();
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      if (mode === 'review') void openTicked();
    }, 250);
  });

  // What needs Court (a paused step is counted as paused, not twice).
  const cardsFor = (jobId: number) =>
    openCardsByJob(cards.filter((c) => c.kind !== 'paused')).get(jobId) ?? 0;

  // ---- the groups ----
  //
  // review: the waiting groups by what will happen (serve's order), each
  // headed by its kind and its decision ("branches · delete it"). run
  // (until it lists items): running, then done.

  function paintList(): void {
    ctx.bar.setCount('run', order().running.length);
    const gs: PaneGroup[] = groups
      .map((g) => ({ g, n: waitingCount(g) }))
      .filter((x) => x.n > 0)
      .map(({ g, n }) => ({
        id: g.id,
        label: groupName(g) || g.label,
        tag: choiceOf(g),
        n,
        box: true,
      }));
    painting = true;
    try {
      reviewPane.setRows(
        items.filter((it) => !held().has(it.key)),
        gs,
        new Set(gs.filter((g) => !collapsed.has(g.id)).map((g) => g.id)),
      );
      reviewPane.setMore(Math.min(PAGE, itemsTotal - items.length));
      const rgs: PaneGroup[] = runGroups.map((g) => ({
        id: g.id,
        label: g.label,
        n: g.total,
        box: true,
      }));
      const shownRun = runPane.setRows(
        runItems,
        rgs,
        new Set(rgs.filter((g) => !collapsed.has(g.id)).map((g) => g.id)),
      );
      runPane.setMore(Math.min(PAGE, runTotal - runItems.length));
      paintRunning();
      const openAt =
        mode === 'run' && ranKey
          ? shownRun.findIndex((it) => it.key === ranKey)
          : -1;
      if (openAt >= 0) runPane.handle.open(openAt);
    } finally {
      painting = false;
    }
    // With nothing open, the overview's counts follow the list.
    drawOverview();
  }

  // paintRunning is run's own row: one line per running job, which opens
  // it ("job #35 · Delete 215 branches · 87 of 215").
  function paintRunning(): void {
    const running = order().running;
    runPane.ownRow.replaceChildren(
      ...(running.length
        ? [
            h('span', { class: 'cb-bar-label' }, 'running'),
            ...running.map((j) => {
              const p = progress(j);
              const text = `job #${j.id} \u00b7 ${titleOf(j)} \u00b7 ${p.finished} of ${p.total}`;
              return h(
                'button',
                {
                  type: 'button',
                  class: 'kit-chip cb-run-job',
                  'data-job': String(j.id),
                  title: text,
                  onclick() {
                    ctx.route.go('run', String(j.id));
                  },
                },
                text,
              );
            }),
          ]
        : []),
    );
  }

  // How old the observations are, at the foot of both lists (obs.ts).
  const obs = makeObs(ctx, (text, state) => {
    reviewPane.setObs(text, state);
    runPane.setObs(text, state);
  });

  // ---- loading ----
  //
  // Live events don't each fetch: they mark what changed, and one reload
  // runs at a time (after a short window that gathers a burst), with at most
  // one more queued behind it that takes everything marked meanwhile. An
  // event about a job fetches that job (GET /api/job, which carries its open
  // cards), never the whole list.

  const dirty = {
    all: false,
    items: false,
    sessions: false,
    summary: false,
    run: false,
    jobs: new Set<number>(),
  };
  let flushing = false;
  let queued = false;

  function mark(f: (d: typeof dirty) => void): void {
    f(dirty);
    if (flushing) {
      queued = true;
      return;
    }
    flushing = true;
    // A short window gathers the events of a burst into the first reload.
    setTimeout(() => void flush(), 40);
  }

  async function flush(): Promise<void> {
    try {
      do {
        queued = false;
        const d = {
          all: dirty.all,
          items: dirty.items,
          sessions: dirty.sessions,
          summary: dirty.summary,
          run: dirty.run,
          jobs: [...dirty.jobs],
        };
        dirty.all =
          dirty.items =
          dirty.sessions =
          dirty.summary =
          dirty.run =
            false;
        dirty.jobs.clear();
        // An event that names no job reloads the list, and the open job.
        const some = d.all && openId !== null ? [openId] : d.all ? [] : d.jobs;
        await Promise.all([
          d.all ? loadJobs() : null,
          some.length ? loadSome(some) : null,
          d.items ? loadItems() : null,
          d.sessions ? loadSessions() : null,
          d.summary ? loadSummary() : null,
          d.run ? loadRun(0) : null,
          d.run && ranKey ? loadRan(ranKey) : null,
        ]);
      } while (queued);
    } finally {
      flushing = false;
    }
  }

  // patchJob puts a job serve sent into the list, with its open cards.
  function patchJob(v: JobView): void {
    const i = jobs.findIndex((j) => j.id === v.job.id);
    if (i >= 0) jobs[i] = v.job;
    else jobs = [...jobs, v.job];
    cards = [
      ...cards.filter((c) => c.job_id !== v.job.id),
      ...(v.needs_you ?? []).filter((c) => c.state === 'open'),
    ];
  }

  async function loadJobs(): Promise<void> {
    const mine = listSeq.next();
    try {
      const [j, c] = await Promise.all([
        ctx.api.get<JobsView>('/jobs'),
        ctx.api.get<NeedsYouView>('/needs-you'),
      ]);
      if (!listSeq.isLatest(mine)) return;
      jobs = j.jobs ?? [];
      cards = c.cards ?? [];
      // The open job is drawn from its own, sequenced replies.
      if (open) patchJob(open);
      paintList();
      askNamedSessions();
    } catch {
      // non-fatal: the list stays as it was
    }
  }

  // loadSome fetches the jobs live events were about.
  async function loadSome(ids: number[]): Promise<void> {
    const openMine =
      openId !== null && ids.includes(openId) ? jobSeq.next() : 0;
    const at = openId;
    const got = await Promise.all(
      ids.map((id) =>
        ctx.api.get<JobView>('/job', { id: String(id) }).catch(() => null),
      ),
    );
    let drawn: JobView | null = null;
    got.forEach((v, i) => {
      if (!v) return;
      if (ids[i] === at) {
        // A newer reply (Court's own action) drew it: this one is older.
        if (!jobSeq.isLatest(openMine) || openId !== at) return;
        drawn = v;
      }
      patchJob(v);
    });
    if (drawn) setOpen(drawn);
    else paintList();
    askNamedSessions();
  }

  // loadItems loads review's waiting items, narrowed by its filters and
  // search (serve's), a page at a time. On a first page a tick the list no
  // longer shows (applied, decided again, or filtered or searched away) is
  // taken off: the plan covers only what is shown and ticked.
  async function loadItems(offset = 0, narrowed = false): Promise<void> {
    const mine = itemsSeq.next();
    if (offset === 0) gen.review++;
    if (offset === 0) {
      reviewPending = true;
      if (mode === 'review' && reviewOpen) freezeMid();
    }
    try {
      const v = await ctx.api.get<ItemsView>('/items', {
        view: 'to-apply',
        ...paneParams(reviewQ),
        limit: String(PAGE),
        offset: String(offset),
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
        const shown =
          itemsTotal <= items.length
            ? items.map((it) => it.key)
            : await viewKeys('to-apply', reviewQ, noteReview);
        if (!itemsSeq.isLatest(mine)) return;
        const gone = untickHidden(reviewSel.ids(), new Set(shown));
        if (gone.length) reviewSel.deselect(gone);
      }
      reviewPending = false;
      paintList();
      if (offset === 0) drawReview();
      applyWanted();
    } catch (err) {
      if (!itemsSeq.isLatest(mine)) return;
      reviewPending = false;
      drawReview();
      // A filter serve refuses (deleted elsewhere, not valid) says why and
      // lists nothing: never the list unfiltered.
      if (err instanceof ApiError && err.status === 400 && narrowed) {
        reviewPane.setFilterError(err.message);
        items = [];
        itemsTotal = 0;
        groups = [];
        // Nothing is shown, so nothing stays ticked or planned.
        reviewSel.clear();
        closeReview();
        paintList();
        if (active && mode === 'review') {
          drawOverview();
          feed();
        }
      }
    }
  }

  // loadSessions asks for serve's sessions this section names: the runner
  // (its harness names the agent) and its jobs' (the agent a job's steps
  // went to). Coalesced: one request in flight and one queued.
  const loadSessions = coalesced(fetchSessions);
  // The sessions the last list was asked for by name.
  let sessionsNamed = new Set<string>();
  function namedSessions(): string[] {
    const ids = [
      runner()?.id ?? '',
      open?.job.session ?? '',
      ...jobs.map((j) => j.session),
    ];
    return [...new Set(ids.filter(Boolean))].sort();
  }
  // A job naming a session the list hasn't got, nor was asked for, asks
  // again (once: a session serve no longer knows stays unknown).
  function askNamedSessions(): void {
    const missing = namedSessions().some(
      (id) => !sessionsNamed.has(id) && !sessions.some((s) => s.id === id),
    );
    if (missing) mark((d) => (d.sessions = true));
  }
  async function fetchSessions(): Promise<void> {
    try {
      const named = namedSessions();
      sessionsNamed = new Set(named);
      const v = await ctx.api.get<SessionsView>(
        '/sessions',
        named.length ? { session: named.join(',') } : undefined,
      );
      sessions = v.sessions ?? [];
      paintList();
      if (reviewView) drawReview();
      if (active) ctx.setPrimary(primary());
    } catch {
      // non-fatal
    }
  }

  async function loadSummary(): Promise<void> {
    try {
      const s = await ctx.api.get<SummaryView>('/summary');
      syncing = s.syncing;
      drawOverview();
    } catch {
      // non-fatal
    }
  }

  // loadJob loads the job a route opened; only the newest request may draw.
  async function loadJob(id: number): Promise<void> {
    const mine = jobSeq.next();
    try {
      const v = await ctx.api.get<JobView>('/job', { id: String(id) });
      if (!jobSeq.isLatest(mine) || openId !== id) return;
      setOpen(v);
      askNamedSessions();
    } catch (err) {
      if (!jobSeq.isLatest(mine) || openId !== id) return;
      open = null;
      readEl.replaceChildren(
        h(
          'div',
          { class: 'cb-read-empty' },
          h('p', { class: 'cb-read-empty-section kit-label' }, 'run'),
          h('p', { class: 'cb-read-empty-prompt' }, message(err)),
        ),
      );
      feed();
    }
  }

  // setOpen draws a job serve sent (a reload, or a reply to Court's own
  // action, which is sequenced like a reload).
  function setOpen(v: JobView): void {
    const first = open?.job.id !== v.job.id;
    open = v;
    patchJob(v);
    // An edit whose card has closed has nothing left to edit.
    for (const id of [...editors.keys()]) {
      if (!(v.needs_you ?? []).some((c) => c.id === id && c.state === 'open'))
        editors.delete(id);
    }
    if (first) stepsShown = STEPS_PAGE;
    paintList();
    if (mode !== 'run') return;
    drawOpen();
    if (first) readEl.scrollTop = 0;
    feed();
  }

  // act posts one of Court's actions on the open job; a JobView reply is
  // drawn in order with the reloads. ok runs once serve has taken it, before
  // the job is drawn again.
  async function act<T>(
    path: string,
    body: unknown,
    ok?: () => void,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    note = '';
    const mine = jobSeq.next();
    try {
      const r = await ctx.api.post<T>(path, body);
      ok?.();
      const jv = r as unknown as JobView;
      if (jv && typeof jv === 'object' && 'job' in jv && jv.job) {
        if (jobSeq.isLatest(mine) && openId === jv.job.id) setOpen(jv);
        else patchJob(jv);
      } else if (openId !== null) {
        const id = openId;
        mark((d) => d.jobs.add(id));
      }
      if (ranKey) mark((d) => (d.run = true));
    } catch (err) {
      note = message(err);
      drawOpen();
      drawRan();
    } finally {
      busy = false;
    }
  }

  // ---- review: what is ticked ----

  // tickGroup ticks every waiting item of group id (every page: fetched
  // when the list hasn't them all), or, all ticked, unticks them. Ticking a
  // collapsed group expands it: its rows show what is ticked.
  async function tickGroup(id: string, only = false): Promise<void> {
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
      const was = gen.review;
      try {
        keys = await groupKeys(id);
      } catch {
        return;
      }
      // The list or the ticks changed while its pages came: old keys.
      if (was !== gen.review) return;
    }
    reviewSel.all(keys);
    if (collapsed.has(id)) {
      collapsed.delete(id);
      paintList();
    }
  }

  // applyWanted ticks the group the address asked for (#/review?group=<id>,
  // decide's "waiting in review"), once the waiting groups have loaded; the
  // address keeps only the list's filters and search.
  function applyWanted(): void {
    if (!wantGroup || !active || mode !== 'review' || !itemsLoaded) return;
    const id = wantGroup;
    wantGroup = '';
    reviewSel.clear();
    void tickGroup(id, true);
  }

  // openTicked builds serve's plan for exactly the ticked items and shows
  // it; serve reuses the plan it built for exactly these items. With
  // nothing ticked the overview shows. The plan shown stays until the new
  // one is in, so the review follows the ticks without a flash.
  async function openTicked(force = false): Promise<void> {
    const keys = tickedKeys();
    if (!keys.length) {
      closeReview();
      drawOverview();
      feed();
      return;
    }
    if (!force && reviewOpen && sameKeys(keys, reviewKeys)) {
      // Ticked back to the plan shown: its buttons come back on.
      drawReview();
      return;
    }
    const mine = planSeq.next();
    reviewOpen = true;
    reviewKeys = keys;
    reviewNote = '';
    refusal = '';
    note = '';
    if (!reviewView) drawReview();
    try {
      // Review only shows: the plan is stored when Court runs it, so two
      // tabs reviewing one group change nothing.
      const v = await ctx.api.post<PlanView>('/apply/plan', {
        keys,
        preview: true,
      });
      if (!planSeq.isLatest(mine)) return;
      reviewView = v;
      afterSync = false;
      syncError = '';
    } catch (err) {
      if (!planSeq.isLatest(mine)) return;
      reviewView = null;
      const msg = message(err);
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        msg.includes('sync first')
      )
        refusal = msg;
      else reviewNote = msg;
    }
    if (!planSeq.isLatest(mine)) return;
    drawReview();
    feed();
  }

  // viewKeys is every key a view lists now (review's to-apply or run's,
  // with its filters and search; group: one group of it), every page,
  // each item noted.
  async function viewKeys(
    view: 'to-apply' | 'run',
    q: PaneQuery,
    note: (it: ItemView) => void,
    group = '',
  ): Promise<string[]> {
    const keys: string[] = [];
    for (let total = Infinity; keys.length < total;) {
      const v = await ctx.api.get<ItemsView>('/items', {
        view,
        ...paneParams(q),
        ...(group ? { group } : {}),
        limit: '500',
        offset: String(keys.length),
      });
      const got = v.items ?? [];
      total = v.total;
      if (!got.length) break;
      for (const it of got) note(it);
      keys.push(...got.map((i) => i.key));
    }
    return keys;
  }

  // groupKeys is every key of to-apply group id a job doesn't hold (the
  // list's filters and search apply).
  async function groupKeys(id: string): Promise<string[]> {
    const h0 = held();
    const keys = await viewKeys('to-apply', reviewQ, noteReview, id);
    return keys.filter((k) => !h0.has(k));
  }

  // ---- run: its items ----

  // loadRun loads run's items (serve's view=run, narrowed by its filters
  // and search). A first page reloads as many rows as were shown; a tick
  // the list no longer shows is taken off.
  async function loadRun(offset = 0, narrowed = false): Promise<void> {
    const mine = runSeq.next();
    if (offset === 0) {
      gen.run++;
      runPending = true;
      if (mode === 'run' && runTickedOn) freezeMid();
    }
    try {
      const v = await ctx.api.get<ItemsView>('/items', {
        view: 'run',
        ...paneParams(runQ),
        limit: String(
          offset ? PAGE : Math.min(500, Math.max(PAGE, runItems.length)),
        ),
        offset: String(offset),
      });
      if (!runSeq.isLatest(mine)) return;
      runPane.setFilterError(null);
      const got = v.items ?? [];
      runItems = offset ? [...runItems, ...got] : got;
      runTotal = v.total;
      runGroups = v.groups ?? [];
      for (const it of got) noteRun(it);
      if (offset === 0 && runSel.ids().length) {
        const shown =
          runTotal <= runItems.length
            ? runItems.map((it) => it.key)
            : await viewKeys('run', runQ, noteRun);
        if (!runSeq.isLatest(mine)) return;
        const gone = untickHidden(runSel.ids(), new Set(shown));
        if (gone.length) runSel.deselect(gone);
      }
      if (offset === 0) runPending = false;
      paintList();
      if (offset === 0 && runTickedOn) drawRunTicked();
    } catch (err) {
      if (!runSeq.isLatest(mine)) return;
      runPending = false;
      if (runTickedOn) drawRunTicked();
      if (err instanceof ApiError && err.status === 400 && narrowed) {
        runPane.setFilterError(err.message);
        runItems = [];
        runTotal = 0;
        runGroups = [];
        // Nothing is shown, so nothing stays ticked.
        runSel.clear();
        paintList();
      }
    }
  }

  // tickRunGroup ticks every item of run's group id (every page), or, all
  // ticked, unticks them; a collapsed group expands.
  async function tickRunGroup(id: string): Promise<void> {
    const g = runGroups.find((x) => x.id === id);
    if (!g) return;
    const ticked = runSel.ids().filter((k) => runGroupOfKey.get(k) === id);
    if (g.total > 0 && ticked.length >= g.total) {
      runSel.deselect(ticked);
      return;
    }
    let keys = runItems.filter((it) => it.group === id).map((it) => it.key);
    if (keys.length < g.total) {
      const was = gen.run;
      try {
        keys = await viewKeys('run', runQ, noteRun, id);
      } catch {
        return;
      }
      // The list or the ticks changed while its pages came: old keys.
      if (was !== gen.run) return;
    }
    runSel.all(keys);
    if (collapsed.has(id)) {
      collapsed.delete(id);
      paintList();
    }
  }

  // loadRan loads the item run shows: every step on it (those of a job
  // that never ran left out) and its latest job that ran, both serve's.
  async function loadRan(key: string): Promise<void> {
    const mine = ranSeq.next();
    try {
      const d = await ctx.api.get<ItemDetailView>('/item', { key });
      if (!ranSeq.isLatest(mine) || ranKey !== key) return;
      // serve says which job is the item's (the latest that ran) and the
      // steps that ran: a cold load has no jobs here to work it out from.
      const steps = d.ran_steps ?? [];
      const jobId = d.ran?.job ?? 0;
      const jv = jobId
        ? await ctx.api
            .get<JobView>('/job', { id: String(jobId) })
            .catch(() => null)
        : null;
      if (!ranSeq.isLatest(mine) || ranKey !== key) return;
      if (jv) patchJob(jv);
      ranDetail = { ...d, steps };
      ranJob = jv;
      drawRan();
      paintList();
    } catch (err) {
      if (!ranSeq.isLatest(mine) || ranKey !== key) return;
      ranDetail = null;
      paint(
        h(
          'article',
          { class: 'cb-apply-doc' },
          h('p', { class: 'cb-apply-note', role: 'status' }, message(err)),
        ),
      );
    }
  }

  // drawRunTicked is the middle pane for run's ticked items: what they are
  // and their jobs, then skip, undo and hand to agent where each fits every
  // one of them (undo only when all can be undone), then a row each.
  // runTicked is run's ticked items as run lists them now.
  const runTicked = (): ItemView[] =>
    runSel
      .ids()
      .map((k) => runItemOf.get(k))
      .filter((x): x is ItemView => !!x?.ran);
  // bulkNow is the steps each button acts on, for what is ticked and shown
  // now (worked out again as Court presses).
  function bulkNow(): { skip: JobStep[]; hand: JobStep[]; undo: JobStep[] } {
    const marks = runTicked()
      .map((it) => it.ran)
      .filter((m) => !!m);
    const b = runBulk(marks, cards);
    const sent = b.hand.every(
      (x) => !!jobs.find((j) => j.id === x.job_id)?.session,
    );
    return { ...b, hand: sent ? b.hand : [] };
  }

  function drawRunTicked(): void {
    if (!active || mode !== 'run') return;
    const its = runTicked();
    const marks = its.map((it) => it.ran).filter((m) => !!m);
    const can = bulkNow();
    const gs = [...new Set(its.map((it) => it.group))];
    const where =
      gs.length === 1
        ? (runGroups.find((g) => g.id === gs[0])?.label ?? gs[0])
        : `${gs.length} groups`;
    const btn = (label: string, run: () => void): HTMLElement =>
      h(
        'button',
        {
          type: 'button',
          class: 'kit-btn',
          disabled: busy || runPending,
          onclick: run,
        },
        label,
      );
    const acts: HTMLElement[] = [];
    if (can.skip.length) acts.push(btn('skip', () => void answerAll('skip')));
    if (can.undo.length) acts.push(btn('undo', () => void undoAll()));
    if (can.hand.length)
      acts.push(btn('hand to agent', () => void answerAll('hand-to-agent')));
    const shown = its.slice(0, 20);
    paint(
      h(
        'article',
        { class: 'cb-apply-doc cb-ticked', 'data-testid': 'run-ticked' },
        ...midHead({ ...tickedRunWords(marks, where), acts }),
        note ? h('p', { class: 'cb-apply-note', role: 'status' }, note) : null,
        midRows(
          shown.map((it) => {
            const l = it.ran
              ? ranLine(it.ran, it.holds ?? [])
              : { text: '', tone: 'muted' as const };
            return { key: it.key, stands: l.text, tone: l.tone };
          }),
          its.length - shown.length,
        ),
      ),
    );
  }

  // answerAll answers the open card of every step of each ticked item that
  // needs Court (skip, hand to agent), one post per step; the items it acted
  // on are unticked.
  async function answerAll(action: string): Promise<void> {
    if (busy || runPending) return;
    const b = bulkNow();
    const steps = action === 'skip' ? b.skip : b.hand;
    if (!steps.length) return;
    busy = true;
    note = '';
    const done: string[] = [];
    try {
      for (const st of steps) {
        const c = cards.find(
          (x) =>
            x.state === 'open' &&
            x.step_id === st.id &&
            (x.kind === 'failed' || (action === 'skip' && x.kind === 'paused')),
        );
        if (!c) continue;
        await ctx.api.post<AnswerResult>('/jobs/answer', {
          needs_you: c.id,
          action,
          text: '',
        });
        done.push(st.key);
      }
    } catch (err) {
      note = message(err);
    } finally {
      busy = false;
      mark((d) => {
        d.all = true;
        d.run = true;
      });
    }
    if (done.length) runSel.deselect(done);
    else drawRunTicked();
  }

  // undoAll undoes every step of each ticked item that can be undone, one
  // post per step.
  async function undoAll(): Promise<void> {
    if (busy || runPending) return;
    const steps = bulkNow().undo;
    if (!steps.length) return;
    busy = true;
    note = '';
    const done: string[] = [];
    try {
      for (const st of steps) {
        await ctx.api.post<UndoResult>('/jobs/undo', { step: st.id });
        done.push(st.key);
      }
    } catch (err) {
      note = message(err);
    } finally {
      busy = false;
      mark((d) => {
        d.all = true;
        d.run = true;
      });
    }
    if (done.length) runSel.deselect(done);
    else drawRunTicked();
  }

  // drawRan draws the item run shows.
  function drawRan(): void {
    if (!active || mode !== 'run' || !ranKey || openId !== null || !ranDetail)
      return;
    if (runTickedOn) return;
    paint(renderRan(ctx, ranDetail, ranJob, cards, jobHooks));
  }

  function closeReview(): void {
    planSeq.next(); // a plan on its way no longer draws
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
    reviewOpen = false;
    reviewView = null;
    reviewKeys = [];
    reviewNote = '';
  }

  // syncFirst asks serve to sync (one sync, however often it is asked); the
  // live wire says when it is done, and the plan is asked for again.
  async function syncFirst(): Promise<void> {
    syncError = '';
    // Armed here, in the tab where Court asked, before serve is asked (its
    // done can be heard before its reply): another tab's sync opens nothing.
    afterSync = true;
    try {
      const v = await ctx.api.post<SyncView>('/sync', {});
      syncing = v.running;
    } catch (err) {
      afterSync = false;
      syncError = message(err);
    }
    drawReview();
    if (active) ctx.setPrimary(primary());
  }

  function onSync(e: SyncEvent): void {
    if (e.state === 'running') {
      syncing = true;
      syncError = '';
    } else {
      syncing = false;
      syncError = e.state === 'failed' ? (e.error ?? 'failed') : '';
      mark((d) => (d.summary = true));
      if (e.state === 'done' && afterSync) {
        afterSync = false;
        refusal = '';
        if (reviewOpen) void openTicked(true);
      } else if (e.state === 'done' && refusal) {
        // Another tab's sync made the observations fresh: the refusal no
        // longer holds, and nothing is planned here unasked.
        refusal = '';
      }
    }
    drawReview();
    if (active) ctx.setPrimary(primary());
  }

  // ---- review: running a group ----

  // runCheck: the open group's plan, and whether it can run now.
  function runCheck(): { v: PlanView; can: boolean; text: string } | null {
    const v = reviewView;
    if (!v || v !== drawnView || v.job.state !== 'planned') return null;
    const steps = v.job.steps ?? [];
    const rt = runsThrough(steps, runnerAgent());
    // Only the plan for exactly what is ticked and shown now runs.
    const now = !reviewPending && sameKeys(tickedKeys(), reviewKeys);
    return {
      v,
      can: !!steps.length && rt.can && !busy && now,
      text: rt.text,
    };
  }

  // runGroup runs the open group: a plan that holds a step that can never
  // be undone (serve's permanent: a deleted repository, a merge) asks first,
  // naming each item, on a button named for exactly what runs. serve
  // approves it, and the job opens in run.
  function runGroup(): void {
    const rc = runCheck();
    if (!rc?.can) return;
    const j = rc.v.job;
    const steps = j.steps ?? [];
    const go = (): void => {
      const now = runCheck();
      if (!now?.can || now.v !== rc.v) return;
      void saveAndRun(rc.v, needsSession(steps) ? (runner()?.id ?? '') : '');
    };
    const permanent = steps.filter((s) => s.permanent);
    if (!permanent.length) return go();
    const title = titleOf(j);
    const keys = [...new Set(permanent.map((s) => s.key))];
    const sh = sheet({
      title: `${title}?`,
      body: h(
        'div',
        { class: 'cb-confirm', 'data-testid': 'confirm-permanent' },
        h(
          'p',
          { class: 'cb-confirm-warn' },
          'This cannot be undone. These run on GitHub as soon as you confirm:',
        ),
        h(
          'ul',
          { class: 'cb-confirm-list' },
          ...keys.map((k) => h('li', {}, keyWithoutKind(k))),
        ),
      ),
      actions: [
        { label: 'cancel', run: () => sh.close() },
        {
          label: title,
          fill: true,
          run() {
            sh.close();
            go();
          },
        },
      ],
    });
  }

  // saveAndRun stores the plan for exactly the reviewed items and runs it.
  // If serve now builds different steps (a sync since), nothing runs: the
  // review shows the new plan to look at again.
  async function saveAndRun(shown: PlanView, session: string): Promise<void> {
    if (busy) return;
    // The keys sent are what is ticked and shown as Court presses: the
    // plan drawn must be for exactly them (serve checks the same).
    const keys = tickedKeys();
    if (reviewPending || !sameKeys(keys, reviewKeys)) return;
    busy = true;
    note = '';
    drawReview();
    try {
      const saved = await ctx.api.post<PlanView>('/apply/plan', { keys });
      const want = (shown.job.steps ?? []).map((x) => `${x.key} ${x.command}`);
      const got = (saved.job.steps ?? []).map((x) => `${x.key} ${x.command}`);
      if (want.join('\n') !== got.join('\n')) {
        reviewView = { ...saved, job: { ...saved.job } };
        note =
          'What would run changed since you looked; nothing ran. Look again.';
        busy = false;
        drawReview();
        return;
      }
      const v = await ctx.api.post<JobView>('/apply/approve', {
        plan_id: saved.job.id,
        session,
        keys,
      });
      patchJob(v);
      reviewSel.deselect(keys);
      closeReview();
      // The job just started opens in run.
      jobSeq.next();
      openId = v.job.id;
      open = v;
      stepsShown = STEPS_PAGE;
      ctx.route.go('run', String(v.job.id));
    } catch (err) {
      note = message(err);
      drawReview();
    } finally {
      busy = false;
      if (active) ctx.setPrimary(primary());
    }
  }

  // ---- the reading column ----

  function refusalCard(): HTMLElement {
    const body = h(
      'div',
      null,
      h('p', { 'data-testid': 'plan-refused' }, refusal),
    );
    if (syncing) {
      body.append(
        h(
          'p',
          { class: 'cb-apply-note', role: 'status', 'data-testid': 'syncing' },
          'syncing\u2026 the group opens again when the sync is done',
        ),
      );
    } else if (syncError) {
      body.append(
        h(
          'p',
          {
            class: 'cb-apply-note',
            role: 'status',
            'data-testid': 'sync-failed',
          },
          `not synced: ${syncError}`,
        ),
      );
    }
    const el = card({
      edge: 'signal',
      head: 'not ready',
      body,
      actions: syncing
        ? undefined
        : [{ label: 'sync first', fill: true, run: () => void syncFirst() }],
    });
    el.dataset.testid = 'refusal';
    return el;
  }

  // freezeMid turns every button in the middle pane off at once: what is
  // shown or ticked changed, and nothing acts until the new list and its
  // ticked document are drawn (the next paint draws them).
  function freezeMid(): void {
    drawnView = null;
    for (const b of readEl.querySelectorAll<HTMLButtonElement>('button'))
      b.disabled = true;
  }

  function paint(doc: HTMLElement): void {
    const keep = focusSnapshot(readEl);
    readEl.replaceChildren(h('div', { class: 'kit-doc' }, doc));
    focusRestore(readEl, keep);
  }

  // drawOverview is the middle pane with nothing open.
  function drawOverview(): void {
    if (!active) return;
    if (mode === 'review') {
      if (reviewOpen) return;
      const waitingN = groups.reduce((n, g) => n + waitingCount(g), 0);
      paint(
        h(
          'article',
          { class: 'cb-apply-doc', 'data-testid': 'review-overview' },
          h(
            'h1',
            { class: 'kit-h1' },
            waitingN
              ? `${pluralize(waitingN, 'decision')} waiting`
              : 'nothing decided is waiting',
          ),
          h(
            'p',
            null,
            'Tick items, or a whole group, to review them here: the exact command for each item, where it runs and whether it can be undone. Nothing runs until you press its button there; then it runs in run. This machine applies what is on it; GitHub steps run once, from whichever machine runs them.',
          ),
        ),
      );
      return;
    }
    if (runTickedOn) return drawRunTicked();
    if (openId !== null || ranKey) return;
    const o = order();
    const needs = o.running.reduce((n, j) => n + cardsFor(j.id), 0);
    paint(
      h(
        'article',
        { class: 'cb-apply-doc', 'data-testid': 'run-overview' },
        h(
          'h1',
          { class: 'kit-h1' },
          o.running.length
            ? `${pluralize(o.running.length, 'job')} running`
            : 'nothing is running',
        ),
        facts([
          ['running', String(o.running.length)],
          ['needs you', String(needs)],
          ['done', String(o.done.length)],
        ]),
        h(
          'p',
          null,
          "Running a plan in review starts a job: its items show here by what happened to them. An item opens what ran on it and its job; a running job's line opens the job.",
        ),
      ),
    );
  }

  // drawReview is the plan for what is ticked: its small line, title and
  // what runs now (fixed lines), its one button and who runs it; then each
  // part's where, undo and exact commands.
  function drawReview(): void {
    drawnView = null;
    if (!active || mode !== 'review' || !reviewOpen) return;
    const ids = new Set(reviewKeys.map((k) => groupOfKey.get(k) ?? ''));
    const gs = groups.filter((g) => ids.has(g.id));
    const v = reviewView;
    const j = v?.job;
    const runs = !!v && !!j?.steps?.length && !refusal && !reviewNote;
    if (runs) drawnView = v;
    const [first] = v ? runsNow(v.plan).split('\n') : [''];
    const doc = h(
      'article',
      {
        class: 'cb-apply-doc cb-plan',
        'data-testid': 'review-group',
        'data-group': gs.map((g) => g.id).join(','),
      },
      ...midHead({
        kick: reviewKick(
          reviewKeys.length,
          gs.map((g) => groupName(g) || g.label),
        ),
        title:
          j && j.steps?.length
            ? titleOf(j)
            : gs.length === 1
              ? labelFor(gs[0], reviewKeys.length)
              : pluralize(reviewKeys.length, 'item'),
        ctx: refusal || reviewNote ? '' : (first ?? ''),
        acts: runs && v ? [runActs(v)] : [],
      }),
    );
    if (refusal) {
      doc.append(refusalCard());
      return paint(doc);
    }
    if (reviewNote) {
      doc.append(
        h(
          'p',
          {
            class: 'cb-apply-note',
            role: 'status',
            'data-testid': 'plan-nothing',
          },
          reviewNote,
        ),
      );
      return paint(doc);
    }
    if (!v || !j) return paint(doc);
    const steps = j.steps ?? [];
    const held = v.plan.held_back ?? [];
    const waits = v.plan.waiting ?? [];
    if (!steps.length && !held.length && !waits.length) {
      doc.append(
        h(
          'p',
          { 'data-testid': 'plan-empty' },
          'Nothing in this group runs from this machine: no step is on it, and nothing outward.',
        ),
      );
      return paint(doc);
    }
    doc.append(planLines(v));
    const agent = runnerAgent() ?? 'an agent';
    const parts: StepGroup<Step>[] = (v.groups ?? []).map((x) => ({
      action: x.action,
      lane: x.lane,
      undo: x.undo,
      steps: x.steps ?? [],
    }));
    const deletesBranches = steps.some((s) => s.action.startsWith('branch-'));
    const shown: StepGroup<Step>[] = !steps.length
      ? []
      : parts.length
        ? parts
        : groupSteps<Step>(steps);
    for (const p of shown) {
      const github = p.action === 'branch-delete-remote';
      const first = p.action === 'worktree-remove' && deletesBranches;
      const title = github
        ? 'delete on GitHub'
        : first
          ? 'remove worktrees first'
          : actionTitle(p.action);
      const where =
        p.lane === 'agent'
          ? `Runs on GitHub, through ${agent}.`
          : github
            ? 'Runs from this Mac through GitHub, for branches on either Mac; refuses one that moved since it was observed.'
            : first
              ? 'Runs here, before their branches: each holds a branch below and is clean.'
              : `Runs here, on ${j.machine}.`;
      doc.append(
        h(
          'h3',
          { class: 'kit-label cb-group-label' },
          h(
            'span',
            { class: `cb-lanename cb-lanename-${p.lane}` },
            github ? 'casebook \u00b7 github' : laneLabel(p.lane, agent),
          ),
          ` \u00b7 ${title} \u00b7 ${p.steps.length}`,
          ...tagEls(stepTags(p.steps), p.steps.length),
        ),
        h(
          'p',
          { class: 'cb-plan-where', 'data-testid': 'plan-where' },
          where,
          p.undo
            ? h(
                'span',
                { class: 'cb-plan-undo', 'data-testid': 'plan-undo' },
                ` ${p.undo}`,
              )
            : null,
        ),
        h(
          'div',
          {
            class: 'kit-table cb-plan-group',
            'data-action': p.action,
            'data-lane': p.lane,
          },
          ...p.steps.flatMap((s) => [
            h(
              'div',
              { class: 'kit-tr cb-plan-step', 'data-key': s.key },
              h(
                'span',
                { class: 'cb-step-k', title: s.key },
                keyWithoutKind(s.key),
              ),
              h(
                'code',
                { class: 'cb-cmd', 'data-cmd': s.command, title: s.command },
                stepLine(s),
              ),
            ),
            // A post's comment: whole, on a fixed line of its own under its
            // step (two lines at most, "…" past them, whole on hover).
            s.posts && s.comment
              ? h(
                  'div',
                  {
                    class: 'kit-tr cb-plan-pub',
                    'data-key': s.key,
                    title: publicLine(s),
                  },
                  h('span', { class: 'cb-publine' }, publicLine(s)),
                )
              : null,
          ]),
        ),
      );
    }
    drawWaits(doc, waits, steps);
    drawHeld(doc, held, steps);
    paint(doc);
  }

  // drawWaits lists, per Mac, the items whose local copy is only there:
  // they run from review on that Mac.
  function drawWaits(
    doc: HTMLElement,
    waits: Waiting[],
    steps: Pick<Step, 'key' | 'action'>[],
  ): void {
    const byMachine = new Map<string, Waiting[]>();
    for (const w of waits)
      byMachine.set(w.machine, [...(byMachine.get(w.machine) ?? []), w]);
    for (const [m, ws] of byMachine) {
      doc.append(
        h(
          'h3',
          { class: 'kit-label cb-group-label cb-wait-h' },
          `waits for ${m} \u00b7 ${ws.length}`,
        ),
        ...waitBlocks(ws, steps).flatMap((b) => [
          h('p', { class: 'cb-plan-where' }, b.text),
          h(
            'div',
            {
              class: 'kit-table cb-plan-group cb-waits',
              'data-testid': 'plan-waits',
            },
            ...b.waits.map((w) =>
              h(
                'div',
                { class: 'kit-tr cb-plan-step' },
                h('span', { class: 'cb-step-k' }, keyWithoutKind(w.key)),
                h(
                  'span',
                  { class: 'cb-cmd' },
                  `on ${m}${w.path ? ` \u00b7 ${w.path}` : ''}`,
                ),
              ),
            ),
          ),
        ]),
      );
    }
  }

  // drawHeld lists the items held out of this run, each with what holds
  // it and a link to settle it.
  function drawHeld(
    doc: HTMLElement,
    held: HeldBack[],
    steps: Pick<Step, 'key'>[],
  ): void {
    if (!held.length) return;
    doc.append(
      h(
        'h3',
        { class: 'kit-label cb-group-label cb-held-h' },
        `held \u00b7 ${held.length}`,
      ),
      h('p', { class: 'cb-plan-where' }, heldText),
      h(
        'div',
        {
          class: 'kit-table cb-plan-group cb-held',
          'data-testid': 'plan-held',
        },
        ...held.map((x) => {
          const holds = x.holds ?? [];
          const links: HTMLElement[] = [];
          for (const hd of holds) {
            if (hd.by)
              links.push(
                h(
                  'a',
                  { class: 'cb-link', href: `#/decide/${pathEscape(hd.by)}` },
                  keyWithoutKind(hd.by),
                ),
              );
            else if (hd.kind === 'long-lived')
              links.push(
                h(
                  'a',
                  { class: 'cb-link', href: `#/decide/${pathEscape(x.key)}` },
                  'decide again',
                ),
              );
          }
          return h(
            'div',
            { class: 'kit-tr cb-plan-step cb-held-row', 'data-held': x.key },
            h(
              'span',
              { class: 'cb-step-k', title: x.key },
              keyWithoutKind(x.key),
            ),
            h(
              'span',
              {
                class: 'cb-held-why',
                title: holds.map((hd) => hd.text).join(' \u00b7 '),
              },
              holds.map((hd) => hd.text).join(' \u00b7 '),
              ...links.flatMap((a) => [' \u00b7 ', a]),
              otherHalf(x.key, steps),
            ),
          );
        }),
      ),
    );
  }

  // tagEls: a tag span per tag, for a heading of `of` steps (0: the summary).
  function tagEls(tags: Tag[], of: number): HTMLElement[] {
    return tags.map((t) =>
      h('span', { class: `cb-tag cb-tag-${t.kind}` }, tagText(t, of)),
    );
  }

  // runActs is the plan's one button, named for the action, then who runs
  // it.
  function runActs(v: PlanView): HTMLElement {
    const rc = runCheck();
    return h(
      'div',
      { class: 'cb-run-acts', 'data-testid': 'run-group' },
      buttons([
        {
          label: titleOf(v.job),
          fill: true,
          disabled: !rc?.can,
          run: () => runGroup(),
        },
      ]),
      rc?.text
        ? h(
            'span',
            {
              class: rc.can || busy ? 'cb-approve-lab' : 'cb-approve-none',
              'data-testid': rc.can || busy ? 'runs-through' : 'no-agent',
              title: rc.text,
            },
            rc.text,
          )
        : null,
    );
  }

  // planLines: what waits and is held, the plan's tags, and a note.
  function planLines(v: PlanView): HTMLElement {
    const steps = v.job.steps ?? [];
    const el = h('div', { class: 'cb-approve' });
    const [, rest] = runsNow(v.plan).split('\n');
    if (rest) el.append(h('p', { class: 'cb-approve-what' }, rest));
    const tags = stepTags(steps);
    if (tags.length)
      el.append(h('p', { class: 'cb-tags-line' }, ...tagEls(tags, 0)));
    if (note)
      el.append(h('p', { class: 'cb-apply-note', role: 'status' }, note));
    return el;
  }

  function drawOpen(): void {
    if (!open || !active || mode !== 'run') return;
    if (runTickedOn) return;
    const j = open.job;
    if (j.state === 'planned' || j.state === 'cancelled') {
      paint(
        h(
          'article',
          { class: 'cb-apply-doc cb-job', 'data-job': String(j.id) },
          h('p', { class: 'kit-kick' }, `job #${j.id}`),
          h('h1', { class: 'kit-h1' }, titleOf(j)),
          h(
            'p',
            { class: 'cb-approve-none', 'data-testid': 'never-ran' },
            j.state === 'planned'
              ? 'This has not run: its decisions wait in review.'
              : 'This was replaced before it ran: nothing in it ran.',
          ),
        ),
      );
      return;
    }
    paint(renderJob(ctx, open, jobHooks));
  }

  function pauseOrResume(): void {
    if (!open || !isRunning(open.job)) return;
    void act<JobView>(open.job.paused ? '/jobs/resume' : '/jobs/pause', {
      id: open.job.id,
    });
  }

  const jobHooks: JobHooks = {
    agent: (j) => agentOf(j),
    stepsShown: () => stepsShown,
    showMore() {
      stepsShown += STEPS_PAGE;
      drawOpen();
    },
    note: () => note,
    answer(card: NeedsYou, action: string, text: string, ok?: () => void) {
      void act<AnswerResult>(
        '/jobs/answer',
        { needs_you: card.id, action, text },
        ok,
      );
    },
    undo(step: JobStep) {
      void act<UndoResult>('/jobs/undo', { step: step.id });
    },
    editing: (id) => editors.get(id),
    edit(id, text) {
      if (text === null) editors.delete(id);
      else editors.set(id, text);
    },
  };

  // ---- the bar and the composer ----

  function primary(): Primary | null {
    if (mode === 'review') {
      if (refusal)
        return syncing
          ? null
          : { label: 'sync first', run: () => void syncFirst() };
      // The one button that runs it is in the review, not the bar too.
      return null;
    }
    if (open && openId !== null && isRunning(open.job)) {
      return open.job.paused
        ? { label: 'resume', run: pauseOrResume }
        : { label: 'pause job', run: pauseOrResume };
    }
    return null;
  }

  // feed tells the composer and the bar what is shown, only while review or
  // run is the active section: the open job (by number, with its title) once
  // it has loaded, else nothing.
  function feed(): void {
    if (!active) return;
    if (mode === 'run' && open && openId !== null)
      ctx.setAttached({ job: String(openId) }, jobTitle(open.job));
    else if (mode === 'run' && ranKey) ctx.setAttached({ open: ranKey });
    else ctx.setAttached({});
    ctx.setPrimary(primary());
  }

  // ---- keys (bound only while review or run is shown: review's a, run's p) ----

  const runKey: KeyBinding = {
    keys: 'a',
    label: 'run the open group',
    group: 'page',
    run() {
      runGroup();
    },
  };
  const pauseKey: KeyBinding = {
    keys: 'p',
    label: 'pause or resume the open job',
    group: 'page',
    run() {
      pauseOrResume();
    },
  };

  const reviewBindings: KeyBinding[] = [runKey];
  const runBindings: KeyBinding[] = [pauseKey];

  function closeJob(): void {
    jobSeq.next(); // a reply on its way no longer draws
    openId = null;
    open = null;
    note = '';
  }

  // The runner moved (attached, left, another chosen): the open group says
  // who runs it now.
  ctx.onDockTarget(() => {
    askNamedSessions();
    if (reviewView) drawReview();
    if (active) ctx.setPrimary(primary());
  });

  // loadFilters reads the saved filters (decide's), the chips on both panes.
  async function loadFilters(): Promise<void> {
    try {
      const v = await ctx.api.get<FiltersView>('/filters');
      filterRows = v.filters ?? [];
      reviewPane.setFilters(filterRows, reviewQ.filters);
      runPane.setFilters(filterRows, runQ.filters);
    } catch {
      // non-fatal: the chips stay as they were
    }
  }

  void obs.load();
  void loadFilters();
  void loadJobs();
  void loadItems();
  void loadRun();
  void loadSessions();
  void loadSummary();
  // The vocabulary words the waiting groups for a count.
  // Asked again until it comes (a serve restarting, a slow start): the
  // page never stays on raw words.
  const loadVocab = (): void => {
    getVocab(ctx)
      .then((v) => {
        vocab = v;
        paintList();
        drawReview();
      })
      .catch(() => setTimeout(loadVocab, 2000));
  };
  loadVocab();

  // Which job a live event is about.
  const jobOf = (type: string, data: unknown): number | null => {
    const d = (data ?? {}) as { id?: number; job_id?: number };
    if (type === 'job') return d.id ?? null;
    return d.job_id ?? null;
  };

  return {
    id: 'apply',
    list: listEl,
    read: readEl,
    listKeys: () =>
      mode === 'review'
        ? { nav: reviewPane.handle, selects: true }
        : { nav: runPane.handle, selects: true },
    keys: () => (mode === 'review' ? reviewBindings : runBindings),
    show(sub: string, query: string) {
      active = true;
      const was = mode;
      mode = ctx.route.current().section === 'run' ? 'run' : 'review';
      if (was !== mode) {
        note = '';
        // Leaving a tab clears its ticks: a tick covers only what is shown.
        (was === 'review' ? reviewSel : runSel).clear();
      }
      showPane();
      if (mode === 'review') {
        closeJob();
        // The address names the list's filters and search.
        const pq = paneQuery(query ?? '');
        if (
          pq.q !== reviewQ.q ||
          pq.filters.join(',') !== reviewQ.filters.join(',')
        ) {
          reviewQ = pq;
          reviewPane.setFilters(filterRows, pq.filters);
          reviewPane.setSearch(pq.q);
          void loadItems(0, true);
        }
        // #/review?group=<id> ticks that group's waiting items: their plan
        // opens in the middle pane.
        const group = new URLSearchParams(query ?? '').get('group') ?? '';
        if (group) {
          wantGroup = group;
          setHashQuery(withPane('', reviewQ));
          applyWanted();
        }
        paintList();
        if (reviewOpen) drawReview();
        else if (reviewSel.ids().length) void openTicked();
        feed();
        return;
      }
      wantGroup = '';
      // The address names run's filters and search, and the item open
      // (#/run?item=<key>) or the job (#/run/<id>).
      const pq = paneQuery(query ?? '');
      if (pq.q !== runQ.q || pq.filters.join(',') !== runQ.filters.join(',')) {
        runQ = pq;
        runPane.setFilters(filterRows, pq.filters);
        runPane.setSearch(pq.q);
        void loadRun(0, true);
      }
      const item = new URLSearchParams(query ?? '').get('item') ?? '';
      const id = sub ? Number(decodeURIComponent(sub).replace(/^#/, '')) : NaN;
      // Opening an item or a job shows it, ticks or not.
      if (item || sub) runTickedOn = false;
      if (sub && Number.isFinite(id)) ranKey = '';
      if ((!sub || !Number.isFinite(id)) && item) {
        closeJob();
        if (item !== ranKey) {
          ranKey = item;
          ranDetail = null;
          ranJob = null;
          paint(h('article', { class: 'cb-apply-doc cb-ran' }));
        }
        paintList();
        drawRan();
        void loadRan(item);
        feed();
      } else if (!sub || !Number.isFinite(id)) {
        closeJob();
        ranKey = '';
        paintList();
        feed();
      } else if (id !== openId) {
        openId = id;
        open = null;
        note = '';
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
      // Leaving the tab clears its ticks.
      (mode === 'review' ? reviewSel : runSel).clear();
      active = false;
    },
    onLive(type: string, data: unknown) {
      if (type === 'job' || type === 'step' || type === 'needs_you') {
        const about = jobOf(type, data);
        mark((d) => {
          if (about === null) d.all = true;
          else d.jobs.add(about);
          d.run = true;
        });
      } else if (type === 'index' || type === 'decided') {
        mark((d) => {
          d.items = true;
          d.run = true;
          if (type === 'index') d.summary = true;
        });
      } else if (type === 'sessions') {
        mark((d) => (d.sessions = true));
      } else if (type === 'gap') {
        // Events this page never heard were pruned: reload all it shows.
        mark((d) => {
          d.all = d.items = d.sessions = d.summary = d.run = true;
        });
      } else if (type === 'filters') {
        void loadFilters().then(() => {
          if (reviewQ.filters.length) mark((d) => (d.items = true));
          if (runQ.filters.length) mark((d) => (d.run = true));
        });
      }
      obs.onLive(type, data);
      if (type === 'sync') {
        onSync((data ?? {}) as SyncEvent);
      }
    },
    primary,
  };
}
