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
  list,
  h,
  facts,
  buttons,
  card,
  sheet,
  type Button,
  type KeyBinding,
  type ListHandle,
  type Primary,
} from '/_kit/kit.js';
import type {
  AnswerResult,
  DecisionVocabView,
  GroupView,
  HeldBack,
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
import { DANGER_DISPS } from './decide.ts';
import {
  actionTitle,
  actionVerb,
  groupSteps,
  jobLanes,
  jobTitle,
  laneLabel,
  makeSeq,
  needsLine,
  needsSession,
  nextSteps,
  observations,
  openCardsByJob,
  progress,
  publicLine,
  reviewKicker,
  reviewKeys as chooseReviewKeys,
  waitBlocks,
  heldText,
  otherHalf,
  runsNow,
  stepTags,
  tagText,
  type Tag,
  stepMark,
  applyLabel,
  runOrder,
  runsThrough,
  startedKeys,
  heldOutside,
  planTitle,
  isFinished,
  isRunning,
  type StepGroup,
} from './apply-text.ts';
import { pathEscape } from './router-helpers.ts';
import { getVocab } from './decide.ts';
import { coalesced } from './coalesce.ts';

// Decided items are fetched 200 at a time (serve's cap, like decide).
const PAGE = 200;
// The steps table shows this many rows at a time.
const STEPS_PAGE = 200;

// run's parts (a waiting group's id is serve's, "<disposition>|<kind>").
const RUNNING = 'running';
const DONE = 'done';

type Row =
  | { t: 'job'; job: Job }
  | { t: 'item'; item: ItemView }
  | { t: 'more'; left: number };

type Mode = 'review' | 'run';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A destructive verb reads in danger text (delete, close, archive).
const dangerVerb = (verb: string) =>
  DANGER_DISPS.has(verb) || verb === 'remove';

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
  const startsOpen = (id: string): boolean => id === RUNNING;
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

  // review: the group the address asks for (#/review?group=<id>) until it is
  // opened, the group open, the items it was opened for and serve's plan.
  let wantGroup = '';
  let reviewGroup = '';
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  const sameKeys = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((k, i) => k === b[i]);
  let reviewKeys: string[] = [];
  // How many groups the open review's ticks are from: several make one
  // review.
  let reviewTicked = 0;
  let reviewView: PlanView | null = null;
  // drawnView is the plan drawReview last put on the page: only it runs.
  let drawnView: PlanView | null = null;
  // serve's words when the group's plan wasn't built (nothing to plan, an
  // item already running): shown in the pane, no "sync first".
  let reviewNote = '';
  let refusal = '';
  // A plan is being asked for: a second press of the group asks nothing.
  let opening = false;

  // run: the job open.
  let openId: number | null = null;
  let open: JobView | null = null;
  let stepsShown = STEPS_PAGE;
  let note = '';
  let busy = false;
  let painting = false;
  // serve's observation age: when the index was built, one sync interval,
  // and whether a sync (POST /api/sync) is running.
  let builtAt = 0;
  let intervalMs = 0;
  let syncing = false;
  let syncError = '';
  // The group a refused plan was for, opened again once a sync Court asked
  // for here (sync first, in this tab) is done.
  let afterSync: string | null = null;
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

  // ---- the list ----

  const obsText = h('span', { 'data-testid': 'observations' });
  const obsEl = h(
    'div',
    { class: 'cb-apply-obs' },
    h('i', { class: 'cb-apply-obs-dot', 'aria-hidden': 'true' }),
    obsText,
  );
  const foot = h('div', { class: 'cb-apply-foot' }, obsEl);

  // In a job approved, running or paused: key → that job. Such an item
  // leaves its waiting group (a plan holds nothing: it is review's own).
  const held = () => startedKeys(jobs);
  const order = () => runOrder(jobs);

  // groupName is a waiting group's kind, plural ("repos"); choiceOf its
  // decision as decide words it ("Delete it").
  const groupName = (g: GroupView): string => {
    const kind = g.id.slice(g.id.indexOf('|') + 1);
    return kindVocab(kind)?.nouns ?? '';
  };
  const choiceOf = (g: GroupView): string => {
    const kind = g.id.slice(g.id.indexOf('|') + 1);
    return (
      kindVocab(kind)?.choices?.find((c) => c.disposition === g.disposition)
        ?.label ?? ''
    );
  };
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
    const kind = g.id.slice(g.id.indexOf('|') + 1);
    const kv = kindVocab(kind);
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
  const tickedIn = (g: GroupView) => {
    const sel = new Set(handle.selectedIds());
    return waiting(g)
      .map((it) => it.key)
      .filter((k) => sel.has(k));
  };

  const handle: ListHandle<Row> = list<Row>({
    label: '',
    openOnMove: false,
    row(r: Row) {
      if (r.t === 'more') {
        return {
          id: 'more',
          title: `\u2026 ${pluralize(r.left, 'more decided item')}`,
          meta: 'show more',
        };
      }
      if (r.t === 'item') {
        const it = r.item;
        return {
          id: it.key,
          key: `${it.kind} \u00b7 ${keyWithoutKind(it.key)}`,
          title: it.title ?? keyWithoutKind(it.key),
          selectable: true,
        };
      }
      const j = r.job;
      const p = progress(j);
      const lanes = jobLanes(j)
        .map((l) => laneLabel(l, agentOf(j)))
        .join(' + ');
      return {
        id: `job:${j.id}`,
        key: lanes || `job #${j.id}`,
        title: titleOf(j),
        meta:
          p.started || isFinished(j) ? `${p.finished}/${p.total}` : 'queued',
        sub: needsLine(cardsFor(j.id), p.paused) || undefined,
      };
    },
    onOpen(r: Row, i: number) {
      if (painting) return;
      if (r.t === 'job') ctx.route.go('run', String(r.job.id));
      else if (r.t === 'item') handle.toggle(i);
      else void loadItems(items.length);
    },
    onSelect() {
      paintHeads();
      // The open review follows the ticks in its group; with none open,
      // ticking items opens their group's review.
      if (mode !== 'review') return;
      let g = reviewGroup
        ? groups.find((x) => x.id === reviewGroup)
        : undefined;
      if (!g) {
        g = groups.find((x) => tickedIn(x).length > 0);
        if (!g) return;
      }
      if (followTimer) clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        followTimer = null;
        // Only while review is still shown, and the group still ticked or
        // open: a run unticks its items and leaves for run, which must stay.
        if (!g || mode !== 'review') return;
        if (reviewGroup === g.id) void openGroup(g, true);
        else if (!reviewGroup && tickedIn(g).length) openFromHead(g);
      }, 250);
    },
    foot,
  });
  handle.el.classList.add('cb-apply-list');

  // What needs Court (a paused step is counted as paused, not twice).
  const cardsFor = (jobId: number) =>
    openCardsByJob(cards.filter((c) => c.kind !== 'paused')).get(jobId) ?? 0;

  // ---- the parts and their heads ----
  //
  // review: the waiting groups by what will happen (serve's order). run:
  // Running (jobs approved, running or paused, each with its progress bar),
  // then Done, collapsed. A part with nothing in it shows no head.

  interface Part {
    id: string;
    label: string;
    n: number;
    rows: Row[];
    group?: GroupView;
  }

  function parts(): Part[] {
    const ps: Part[] = [];
    if (mode === 'run') {
      const o = order();
      const job = (job: Job): Row => ({ t: 'job', job });
      if (o.running.length)
        ps.push({
          id: RUNNING,
          label: 'Running',
          n: o.running.length,
          rows: o.running.map(job),
        });
      if (o.done.length)
        ps.push({
          id: DONE,
          label: 'Done',
          n: o.done.length,
          rows: o.done.map(job),
        });
      return ps;
    }
    for (const g of groups) {
      const n = waitingCount(g);
      if (!n) continue;
      ps.push({
        id: g.id,
        label: labelFor(g, n),
        n,
        group: g,
        rows: waiting(g).map((item): Row => ({ t: 'item', item })),
      });
    }
    if (itemsTotal > items.length) {
      const last = ps.length ? ps[ps.length - 1] : null;
      if (last?.group)
        last.rows.push({ t: 'more', left: itemsTotal - items.length });
    }
    return ps;
  }

  // The rows shown now (a collapsed part's aside), in the list's order.
  let shown: Row[] = [];
  // The heads drawn now, painted again when the selection changes.
  let heads: Array<{ el: HTMLElement; paint(): void }> = [];

  function paintList(): void {
    ctx.bar.setCount('run', order().running.length);
    const ps = parts();
    shown = ps.flatMap((p) => (collapsed.has(p.id) ? [] : p.rows));
    handle.setItems(shown);
    const els = handle.el.querySelectorAll<HTMLElement>('.kit-rows > .kit-row');
    els.forEach((rowEl, i) => {
      const r = shown[i];
      if (!r) return;
      if (r.t === 'item') rowEl.dataset.key = r.item.key;
      else if (r.t === 'more') rowEl.classList.add('cb-apply-more');
      else decorateJobRow(rowEl, r.job);
    });
    placeHeads(ps, els);
    const openAt =
      mode === 'run'
        ? shown.findIndex((r) => r.t === 'job' && r.job.id === openId)
        : -1;
    if (openAt >= 0) {
      painting = true;
      try {
        handle.open(openAt);
      } finally {
        painting = false;
      }
    }
    if (mode === 'review') markOpenGroup();
    paintObs();
    // With nothing open, the overview's counts follow the list.
    drawOverview();
  }

  // placeHeads puts each part's head before its first row or, collapsed,
  // where its rows would be.
  function placeHeads(ps: Part[], els: NodeListOf<HTMLElement>): void {
    const body = handle.el.querySelector<HTMLElement>('.kit-rows');
    heads = [];
    if (!body) return;
    let at = 0;
    let last: Element | null = null;
    for (const p of ps) {
      const head = partHead(p);
      heads.push(head);
      const n = collapsed.has(p.id) ? 0 : p.rows.length;
      if (n) {
        els[at]?.before(head.el);
        last = els[at + n - 1] ?? head.el;
      } else {
        if (last) last.after(head.el);
        else body.prepend(head.el);
        last = head.el;
      }
      at += n;
    }
  }

  // partHead is a part's head, as decide draws a group's: the caret (it
  // collapses and expands the part), a checkbox for a waiting group (it
  // ticks the group's items), the label and the count; a waiting group's
  // header is its button ("Delete 3 branches\u2026", or for the ticked
  // items), which opens the group in the middle pane.
  function partHead(p: Part): { el: HTMLElement; paint(): void } {
    const isOpen = !collapsed.has(p.id);
    const toggleOpen = (): void => {
      if (collapsed.has(p.id)) collapsed.delete(p.id);
      else collapsed.add(p.id);
      paintList();
    };
    const g = p.group;
    const box = g
      ? h('span', {
          class: 'cb-group-box',
          role: 'checkbox',
          'aria-checked': 'false',
          'aria-label': p.label,
          onclick() {
            const keys = waiting(g).map((it) => it.key);
            if (tickedIn(g).length === keys.length) handle.deselect(keys);
            else handle.selectAll(keys);
          },
        })
      : h('span', { class: 'cb-group-nobox' });
    const top = h(
      'div',
      { class: 'cb-group-top' },
      h(
        'button',
        {
          type: 'button',
          class: 'cb-group-caret',
          'aria-expanded': String(isOpen),
          'aria-label': p.label,
          onclick: toggleOpen,
        },
        isOpen ? '\u25bc' : '\u25b6',
      ),
      box,
      g
        ? h('div', { class: 'cb-group-acts cb-apply-head-acts' })
        : h(
            'span',
            { class: 'cb-group-name', onclick: toggleOpen },
            h(
              'span',
              { class: 'cb-group-line' },
              h('span', { class: 'cb-group-label' }, p.label),
            ),
          ),
      h('span', { class: 'cb-group-n' }, String(p.n)),
    );
    const acts = g
      ? top.querySelector<HTMLElement>('.cb-apply-head-acts')
      : null;
    const el = h(
      'div',
      {
        class: 'cb-group cb-apply-part' + (isOpen ? '' : ' collapsed'),
        role: 'presentation',
        dataset: { part: p.id },
      },
      top,
    );
    const paint = (): void => {
      if (!g || !acts) return;
      const ticked = tickedIn(g);
      const all = waiting(g).length;
      box.setAttribute(
        'aria-checked',
        !ticked.length ? 'false' : ticked.length === all ? 'true' : 'mixed',
      );
      // The group's name (what is in it, and its decision in serve's
      // words), which opens its review: the one button that runs it is
      // there, named for the action.
      const bs: HTMLElement[] = [
        h(
          'button',
          {
            type: 'button',
            class: 'cb-group-plan cb-group-namebtn',
            title: 'review these',
            onclick() {
              openFromHead(g);
            },
          },
          h('span', { class: 'cb-group-label' }, groupName(g)),
          h('span', { class: 'cb-group-choice' }, choiceOf(g)),
        ),
      ];
      if (ticked.length && vocab?.untick)
        bs.push(
          h(
            'button',
            {
              type: 'button',
              class: 'cb-group-untick',
              onclick() {
                handle.deselect(ticked);
              },
            },
            vocab.untick,
          ),
        );
      acts.replaceChildren(...bs);
    };
    paint();
    return { el, paint };
  }

  function paintHeads(): void {
    for (const hd of heads) hd.paint();
  }

  // markOpenGroup marks the open group's head in the list.
  function markOpenGroup(): void {
    for (const el of handle.el.querySelectorAll<HTMLElement>('.cb-apply-part'))
      el.classList.toggle(
        'cb-focus',
        !!reviewGroup && el.dataset.part === reviewGroup,
      );
  }

  // A job row: its lanes in their colours, the progress bar under the
  // title (one segment per lane), the signal line.
  function decorateJobRow(rowEl: HTMLElement, j: Job): void {
    rowEl.dataset.job = String(j.id);
    rowEl.classList.add('cb-job-row');
    const p = progress(j);
    const kicker = rowEl.querySelector<HTMLElement>('.kit-kicker');
    const lanes = jobLanes(j);
    if (kicker && lanes.length) {
      kicker.replaceChildren(
        ...lanes.flatMap((l, i) => [
          i ? ' + ' : '',
          h(
            'span',
            { class: `cb-lanename cb-lanename-${l}`, 'data-lane': l },
            laneLabel(l, agentOf(j)),
          ),
        ]),
      );
    }
    const meta = rowEl.querySelector<HTMLElement>('.kit-meta');
    if (meta?.textContent === 'queued') meta.classList.add('cb-queued');
    rowEl.querySelector('.kit-sub')?.classList.add('cb-needs-line');
    const bar = h('div', {
      class: 'cb-pb',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': String(p.total),
      'aria-valuenow': String(p.finished),
    });
    for (const l of lanes) {
      const n = p.byLane[l] ?? 0;
      if (!n) continue;
      bar.append(
        h('span', {
          class: `cb-pb-${l}`,
          style: `width:${(100 * n) / Math.max(1, p.total)}%`,
        }),
      );
    }
    rowEl.querySelector('.kit-title')?.after(bar);
  }

  function paintObs(): void {
    const o = builtAt
      ? observations(builtAt, intervalMs, Date.now())
      : { text: '', stale: false };
    obsText.textContent = syncing ? 'syncing observations\u2026' : o.text;
    obsEl.dataset.state = syncing ? 'syncing' : o.stale ? 'stale' : 'fresh';
    obsEl.hidden = !builtAt && !syncing;
  }
  // The age moves on its own: the foot says so without an event.
  const obsTimer = setInterval(paintObs, 1000);
  void obsTimer;

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
          jobs: [...dirty.jobs],
        };
        dirty.all = dirty.items = dirty.sessions = dirty.summary = false;
        dirty.jobs.clear();
        // An event that names no job reloads the list, and the open job.
        const some = d.all && openId !== null ? [openId] : d.all ? [] : d.jobs;
        await Promise.all([
          d.all ? loadJobs() : null,
          some.length ? loadSome(some) : null,
          d.items ? loadItems() : null,
          d.sessions ? loadSessions() : null,
          d.summary ? loadSummary() : null,
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

  async function loadItems(offset = 0): Promise<void> {
    const mine = itemsSeq.next();
    try {
      const v = await ctx.api.get<ItemsView>('/items', {
        view: 'to-apply',
        limit: String(PAGE),
        offset: String(offset),
      });
      if (!itemsSeq.isLatest(mine)) return;
      const got = v.items ?? [];
      items = offset ? [...items, ...got] : got;
      itemsTotal = v.total;
      itemsLoaded = true;
      // A decided item that left the list (applied, or decided again) leaves
      // the selection too.
      groups = v.groups ?? [];
      const keep = new Set(items.map((i) => i.key));
      const gone = handle.selectedIds().filter((k) => !keep.has(k));
      if (gone.length && offset === 0 && itemsTotal <= items.length) {
        handle.deselect(gone);
      }
      paintList();
      openWanted();
    } catch {
      // non-fatal
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
      builtAt = Date.parse(s.built_at) || 0;
      intervalMs = s.sync_interval_ms;
      syncing = s.syncing;
      paintObs();
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
    // A job opened by URL shows in its part: a collapsed Done opens.
    if (isFinished(v.job) && v.job.state !== 'cancelled')
      collapsed.delete(DONE);
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
    } catch (err) {
      note = message(err);
      drawOpen();
    } finally {
      busy = false;
    }
  }

  // ---- review: opening a group ----

  // openFromHead opens group g from its head: again, for what is ticked
  // now, when it is the group open.
  function openFromHead(g: GroupView): void {
    if (reviewGroup === g.id && ctx.route.current().section === 'review') {
      if (!opening) void openGroup(g);
    } else ctx.route.go('review', '', `group=${encodeURIComponent(g.id)}`);
  }

  // openWanted opens the group the address asks for, once the waiting
  // groups have loaded.
  function openWanted(): void {
    if (!wantGroup || !active || mode !== 'review' || !itemsLoaded) return;
    const id = wantGroup;
    wantGroup = '';
    const g = groups.find((x) => x.id === id);
    if (g && waitingCount(g)) {
      void openGroup(g);
      return;
    }
    reviewGroup = id;
    reviewView = null;
    refusal = '';
    reviewNote = 'Nothing in this group is waiting.';
    drawReview();
    feed();
  }

  // openGroup builds serve's plan for group g's ticked items, or every item
  // of it that waits (every page: fetched when the list hasn't them all),
  // and shows it. serve reuses the plan it built for exactly these items.
  // follow (a tick changed while g is open) keeps what is shown until the
  // new plan is in, so the review follows the ticks without a flash.
  async function openGroup(g: GroupView, follow = false): Promise<void> {
    reviewGroup = g.id;
    if (!follow) reviewView = null;
    reviewNote = '';
    refusal = '';
    note = '';
    if (!follow) {
      if (collapsed.has(g.id)) collapsed.delete(g.id);
      paintList();
      focusHead(g.id);
    }
    const mine = planSeq.next();
    // Ticks in any group make one review of every ticked item; with none
    // anywhere, review shows the open group's waiting items.
    const choice = chooseReviewKeys(
      groups.map((x) => ({
        ticked: tickedIn(x),
        waiting: x.id === g.id ? waiting(g).map((it) => it.key) : [],
      })),
      groups.findIndex((x) => x.id === g.id),
    );
    let keys = choice.keys;
    const nTicked = choice.groups;
    if (!groups.some((x) => tickedIn(x).length > 0)) {
      if (itemsTotal > items.length) {
        try {
          keys = await groupKeys(g.id);
        } catch (err) {
          if (!planSeq.isLatest(mine)) return;
          reviewNote = message(err);
          drawReview();
          return;
        }
      }
    }
    if (!planSeq.isLatest(mine)) return;
    if (follow && sameKeys(keys, reviewKeys)) return;
    reviewKeys = keys;
    reviewTicked = nTicked;
    if (!follow) drawReview();
    if (!keys.length) return;
    opening = true;
    try {
      // Review only shows: the plan is stored when Court runs it, so two
      // tabs reviewing one group change nothing.
      const v = await ctx.api.post<PlanView>('/apply/plan', {
        keys,
        preview: true,
      });
      if (!planSeq.isLatest(mine) || reviewGroup !== g.id) return;
      reviewView = v;
      afterSync = null;
      syncError = '';
    } catch (err) {
      if (!planSeq.isLatest(mine) || reviewGroup !== g.id) return;
      const msg = message(err);
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        msg.includes('sync first')
      )
        refusal = msg;
      else reviewNote = msg;
    } finally {
      if (planSeq.isLatest(mine)) opening = false;
    }
    if (!planSeq.isLatest(mine)) return;
    drawReview();
    feed();
  }

  // groupKeys is every key of to-apply group id a job doesn't hold.
  async function groupKeys(id: string): Promise<string[]> {
    const h0 = held();
    const keys: string[] = [];
    for (let total = Infinity; keys.length < total;) {
      const v = await ctx.api.get<ItemsView>('/items', {
        view: 'to-apply',
        group: id,
        limit: '500',
        offset: String(keys.length),
      });
      const got = v.items ?? [];
      total = v.total;
      if (!got.length) break;
      keys.push(...got.map((i) => i.key));
    }
    return keys.filter((k) => !h0.has(k));
  }

  function focusHead(id: string): void {
    const head = handle.el.querySelector<HTMLElement>(
      `.cb-apply-part[data-part="${CSS.escape(id)}"]`,
    );
    head?.scrollIntoView({ block: 'nearest' });
  }

  function closeReview(): void {
    planSeq.next(); // a plan on its way no longer draws
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
    reviewGroup = '';
    reviewView = null;
    reviewKeys = [];
    reviewTicked = 0;
    reviewNote = '';
    opening = false;
    markOpenGroup();
  }

  // syncFirst asks serve to sync (one sync, however often it is asked); the
  // live wire says when it is done, and the group is opened again.
  async function syncFirst(): Promise<void> {
    syncError = '';
    // Armed here, in the tab where Court asked, before serve is asked (its
    // done can be heard before its reply): another tab's sync opens nothing.
    afterSync = reviewGroup;
    try {
      const v = await ctx.api.post<SyncView>('/sync', {});
      syncing = v.running;
    } catch (err) {
      afterSync = null;
      syncError = message(err);
    }
    paintObs();
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
      if (e.state === 'done' && afterSync !== null) {
        const id = afterSync;
        afterSync = null;
        refusal = '';
        const g = groups.find((x) => x.id === id);
        if (g && reviewGroup === id) void openGroup(g);
      } else if (e.state === 'done' && refusal) {
        // Another tab's sync made the observations fresh: the refusal no
        // longer holds, and nothing is planned here unasked.
        refusal = '';
      }
    }
    paintObs();
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
    return { v, can: !!steps.length && rt.can && !busy, text: rt.text };
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
    busy = true;
    note = '';
    drawReview();
    try {
      const saved = await ctx.api.post<PlanView>('/apply/plan', {
        keys: reviewKeys,
      });
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
      });
      patchJob(v);
      handle.deselect(reviewKeys);
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

  function paint(doc: HTMLElement): void {
    const keep = focusSnapshot(readEl);
    readEl.replaceChildren(h('div', { class: 'kit-doc' }, doc));
    focusRestore(readEl, keep);
  }

  // drawOverview is the middle pane with nothing open.
  function drawOverview(): void {
    if (!active) return;
    if (mode === 'review') {
      if (reviewGroup) return;
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
              : 'Nothing decided is waiting',
          ),
          h(
            'p',
            null,
            "Click a group's name, or tick items in it, to review it here: the exact command for each item, where it runs and whether it can be undone. Nothing runs until you press its button there; then it runs in run. This machine applies what is on it; GitHub steps run once, from whichever machine runs them.",
          ),
        ),
      );
      return;
    }
    if (openId !== null) return;
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
            : 'Nothing is running',
        ),
        facts([
          ['running', String(o.running.length)],
          ['needs you', String(needs)],
          ['done', String(o.done.length)],
        ]),
        h(
          'p',
          null,
          "A group's button in review starts a job here. A job's row opens it: each step as it runs, and anything that needs you.",
        ),
      ),
    );
  }

  // drawReview is the open group: what it does and who runs it, its one
  // button, then each part's where, undo and exact commands.
  function drawReview(): void {
    drawnView = null;
    if (!active || mode !== 'review' || !reviewGroup) return;
    const g = groups.find((x) => x.id === reviewGroup);
    const v = reviewView;
    const j = v?.job;
    const doc = h(
      'article',
      {
        class: 'cb-apply-doc cb-plan',
        'data-testid': 'review-group',
        'data-group': reviewGroup,
      },
      h('p', { class: 'kit-kick' }, reviewKicker(reviewTicked)),
      h(
        'h1',
        { class: 'kit-h1' },
        j && j.steps?.length
          ? titleOf(j)
          : g
            ? labelFor(g, reviewKeys.length || waitingCount(g))
            : reviewGroup,
      ),
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
    if (steps.length) drawnView = v;
    doc.append(runBlock(v));
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
        ? 'Delete on GitHub'
        : first
          ? 'Remove worktrees first'
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
          ...p.steps.map((s) =>
            h(
              'div',
              { class: 'kit-tr cb-plan-step', 'data-key': s.key },
              h('span', { class: 'cb-step-k' }, keyWithoutKind(s.key)),
              h(
                'code',
                { class: 'cb-cmd', 'data-cmd': s.command },
                s.command,
                github && s.expected_tip
                  ? h(
                      'span',
                      { class: 'cb-cmd-if' },
                      ` (if still at ${s.expected_tip.slice(0, 7)})`,
                    )
                  : null,
              ),
              s.posts && s.comment
                ? h('span', { class: 'cb-publine' }, publicLine(s))
                : null,
            ),
          ),
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
          `Waits for ${m} \u00b7 ${ws.length}`,
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
        `Held \u00b7 ${held.length}`,
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
            h('span', { class: 'cb-step-k' }, keyWithoutKind(x.key)),
            h(
              'span',
              { class: 'cb-held-why' },
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

  // runBlock: what runs now and where, what waits and is held, its tags,
  // who runs it, and the one button named for the action.
  function runBlock(v: PlanView): HTMLElement {
    const j = v.job;
    const steps = j.steps ?? [];
    const rc = runCheck();
    const el = h('div', { class: 'cb-approve', 'data-testid': 'run-group' });
    const [first, rest] = runsNow(v.plan).split('\n');
    el.append(
      h(
        'p',
        { class: 'cb-approve-what' },
        first,
        rest ? h('br') : null,
        rest ?? null,
      ),
    );
    const tags = stepTags(steps);
    if (tags.length)
      el.append(h('p', { class: 'cb-tags-line' }, ...tagEls(tags, 0)));
    if (!steps.length) return el;
    const row = h('div', { class: 'cb-approve-row' });
    if (rc?.text)
      row.append(
        h(
          'span',
          {
            class: rc.can || busy ? 'cb-approve-lab' : 'cb-approve-none',
            'data-testid': rc.can || busy ? 'runs-through' : 'no-agent',
          },
          rc.text,
        ),
      );
    row.append(
      buttons([
        {
          label: titleOf(j),
          fill: true,
          disabled: !rc?.can,
          run: () => runGroup(),
        },
      ]),
    );
    el.append(row);
    if (note)
      el.append(h('p', { class: 'cb-apply-note', role: 'status' }, note));
    return el;
  }

  function drawOpen(): void {
    if (!open || !active || mode !== 'run') return;
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
          : { label: 'Sync first', run: () => void syncFirst() };
      // The one button that runs it is in the review, not the bar too.
      return null;
    }
    if (open && openId !== null && isRunning(open.job)) {
      return open.job.paused
        ? { label: 'Resume', run: pauseOrResume }
        : { label: 'Pause job', run: pauseOrResume };
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

  void loadJobs();
  void loadItems();
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
    list: handle.el,
    read: readEl,
    listKeys: () => ({ nav: handle, selects: mode === 'review' }),
    keys: () => (mode === 'review' ? reviewBindings : runBindings),
    show(sub: string, query: string) {
      active = true;
      const was = mode;
      mode = ctx.route.current().section === 'run' ? 'run' : 'review';
      if (was !== mode) note = '';
      if (mode === 'review') {
        closeJob();
        // #/review?group=<id> opens that group in the middle pane.
        const group = new URLSearchParams(query ?? '').get('group') ?? '';
        if (!group) {
          closeReview();
          paintList();
        } else if (group !== reviewGroup) {
          closeReview();
          wantGroup = group;
          paintList();
          openWanted();
        } else {
          paintList();
          drawReview();
        }
        feed();
        return;
      }
      wantGroup = '';
      const id = sub ? Number(decodeURIComponent(sub).replace(/^#/, '')) : NaN;
      if (!sub || !Number.isFinite(id)) {
        closeJob();
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
      active = false;
    },
    onLive(type: string, data: unknown) {
      if (type === 'job' || type === 'step' || type === 'needs_you') {
        const about = jobOf(type, data);
        mark((d) => {
          if (about === null) d.all = true;
          else d.jobs.add(about);
        });
      } else if (type === 'index' || type === 'decided') {
        mark((d) => {
          d.items = true;
          if (type === 'index') d.summary = true;
        });
      } else if (type === 'sessions') {
        mark((d) => (d.sessions = true));
      } else if (type === 'gap') {
        // Events this page never heard were pruned: reload all it shows.
        mark((d) => {
          d.all = d.items = d.sessions = d.summary = true;
        });
      } else if (type === 'sync') {
        onSync((data ?? {}) as SyncEvent);
      }
    },
    primary,
  };
}

// ---- a job --------------------------------------------------------------------

export interface JobHooks {
  agent(job: Job): string;
  stepsShown(): number;
  showMore(): void;
  note(): string;
  answer(card: NeedsYou, action: string, text: string, ok?: () => void): void;
  undo(step: JobStep): void;
  /** An open "edit text" field's text for a card (undefined: not editing). */
  editing(card: number): string | undefined;
  /** Keep (text) or drop (null) a card's open edit across redraws. */
  edit(card: number, text: string | null): void;
}

/**
 * renderJob draws a running or finished job: its facts, the cards that need
 * Court (signal edge) or say the agent paused (amber), and the steps table.
 */
/**
 * stepKeyLines is a step's key in the steps table: for a branch, the repo
 * (muted, the row's full width) over the branch, which shares its line with
 * the state; neither wraps mid-word (Court, 2026-10-18). Any other key is the
 * one line beside the state.
 */
function stepKeyLines(key: string): HTMLElement[] {
  const at = key.indexOf('@');
  if (at < 0) return [h('span', { class: 'cb-step-k' }, key)];
  return [
    h('span', { class: 'cb-step-repo' }, key.slice(0, at)),
    h('span', { class: 'cb-step-k' }, key.slice(at + 1)),
  ];
}

export function renderJob(_ctx: Ctx, v: JobView, hooks: JobHooks): HTMLElement {
  const j = v.job;
  const steps = j.steps ?? [];
  const p = progress(j);
  const agent = hooks.agent(j);
  const open = (v.needs_you ?? []).filter((c) => c.state === 'open');
  const stepOf = (id: number) => steps.find((s) => s.id === id);
  const lanes = jobLanes(j).map((l) => laneLabel(l, agent));
  const state = j.paused && isRunning(j) ? 'paused' : j.state;

  const doc = h(
    'article',
    { class: 'cb-apply-doc cb-job', 'data-job': String(j.id) },
    h(
      'p',
      { class: 'kit-kick' },
      [lanes.join(' + '), `job #${j.id}`, state]
        .filter(Boolean)
        .join(' \u00b7 '),
    ),
    h('h1', { class: 'kit-h1' }, jobTitle(j)),
  );
  const pairs: Array<[string, string]> = [
    ['done', `${p.verified} of ${p.total}`],
    ['needs you', String(open.filter((c) => c.kind !== 'paused').length)],
    ['paused', String(p.paused)],
  ];
  if (p.skipped) pairs.push(['skipped', String(p.skipped)]);
  if (p.failed) pairs.push(['failed', String(p.failed)]);
  const restores = steps.filter((s) => s.restore).length;
  if (restores) pairs.push(['restore records', String(restores)]);
  doc.append(facts(pairs));

  const cardsEl = h('div', { class: 'cb-needs', 'data-testid': 'needs-you' });
  for (const c of open)
    cardsEl.append(needsCard(c, stepOf(c.step_id), j, agent, hooks));
  doc.append(cardsEl);
  const note = hooks.note();
  if (note)
    doc.append(h('p', { class: 'cb-apply-note', role: 'status' }, note));

  // The steps table.
  const next = nextSteps(steps);
  const shown = steps.slice(0, hooks.stepsShown());
  doc.append(
    h('h3', { class: 'kit-label' }, 'steps'),
    h(
      'div',
      { class: 'kit-table cb-steps', 'data-testid': 'steps' },
      ...shown.map((s) => {
        const m = stepMark(s, next.has(s.id));
        return h(
          'div',
          {
            class: 'kit-tr cb-step',
            'data-step': String(s.id),
            'data-state': s.state,
            'data-key': s.key,
          },
          h('span', { class: `cb-step-g cb-tone-${m.tone}` }, m.glyph),
          ...stepKeyLines(keyWithoutKind(s.key)),
          h(
            'span',
            { class: 'cb-step-w' },
            h('span', { class: 'cb-step-t' }, m.text),
            s.undoable
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'kit-btn cb-undo',
                    onclick() {
                      hooks.undo(s);
                    },
                  },
                  'undo',
                )
              : null,
          ),
          m.why ? h('span', { class: 'cb-step-why' }, m.why) : null,
        );
      }),
      steps.length > shown.length
        ? h(
            'div',
            { class: 'kit-tr cb-steps-more' },
            h('span'),
            h(
              'span',
              { class: 'cb-step-k' },
              `\u2026 ${pluralize(steps.length - shown.length, 'more step')}`,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'cb-link',
                onclick() {
                  hooks.showMore();
                },
              },
              'show more',
            ),
          )
        : null,
    ),
  );
  return doc;
}

// needsCard is one open card: what serve asks Court, with serve's actions.
function needsCard(
  c: NeedsYou,
  step: JobStep | undefined,
  j: Job,
  agent: string,
  hooks: JobHooks,
): HTMLElement {
  const key = step ? keyWithoutKind(step.key) : '';
  const verb = step ? actionVerb(step.action) : 'run';
  const answer = (action: string, text = '') => hooks.answer(c, action, text);
  let el: HTMLElement;
  switch (c.kind) {
    case 'text': {
      const quote = h('blockquote', { class: 'cb-needs-text' }, c.text);
      const body = h(
        'div',
        null,
        h(
          'p',
          { class: 'cb-needs-what' },
          h('code', null, key),
          ` \u00b7 ${verb} with comment`,
        ),
        quote,
      );
      const four: Button[] = [
        {
          label: 'post and close',
          fill: true,
          run: () => answer('post-and-close', c.text),
        },
        {
          label: 'edit text',
          run() {
            hooks.edit(c.id, c.text);
            startEdit(c.text, true);
          },
        },
        {
          label: 'close without comment',
          run: () => answer('close-without-comment'),
        },
        { label: 'skip', run: () => answer('skip') },
      ];
      el = card({
        edge: 'signal',
        head: c.question ? `needs you \u00b7 ${c.question}` : 'needs you',
        body,
        actions: four,
      });
      // edit text: the comment becomes a field; save sends it to serve (the
      // card stays open with the new text). While it is open its text is
      // kept by the section, so a redraw (a live event) draws it again as
      // Court left it.
      const startEdit = (text: string, focus: boolean) => {
        const field = h('textarea', {
          class: 'cb-needs-edit',
          'aria-label': 'comment',
          rows: 4,
        }) as HTMLTextAreaElement;
        field.value = text;
        field.addEventListener('input', () => hooks.edit(c.id, field.value));
        quote.replaceWith(field);
        el.querySelector('.kit-btns')?.replaceWith(
          buttons([
            {
              label: 'save text',
              fill: true,
              run: () =>
                hooks.answer(c, 'edit-text', field.value, () =>
                  hooks.edit(c.id, null),
                ),
            },
            {
              label: 'cancel',
              run() {
                hooks.edit(c.id, null);
                field.replaceWith(quote);
                el.querySelector('.kit-btns')?.replaceWith(buttons(four));
              },
            },
          ]),
        );
        if (focus) field.focus();
      };
      const draft = hooks.editing(c.id);
      if (draft !== undefined) startEdit(draft, false);
      break;
    }
    case 'batch':
      el = card({
        edge: 'signal',
        head: 'needs you \u00b7 confirm the batch',
        body: h('p', null, c.question),
        actions: [
          { label: 'confirm', fill: true, run: () => answer('confirm') },
          { label: 'skip batch', run: () => answer('skip-batch') },
        ],
      });
      break;
    case 'failed': {
      const bs: Button[] = [];
      if (j.session)
        bs.push({
          label: 'hand to agent',
          run: () => answer('hand-to-agent'),
        });
      bs.push({ label: 'skip', run: () => answer('skip') });
      el = card({
        edge: 'signal',
        head: `needs you \u00b7 ${key || 'a step'} failed`,
        body: h(
          'div',
          null,
          h('p', null, c.question),
          step ? h('code', { class: 'cb-cmd' }, step.command) : null,
        ),
        actions: bs,
      });
      break;
    }
    case 'paused':
      el = card({
        edge: 'agent',
        head: `${agent} paused`,
        body: h(
          'p',
          null,
          key ? h('code', null, key) : null,
          key ? ': ' : '',
          c.question,
        ),
        actions: [
          {
            label: `${verb} anyway`,
            danger: dangerVerb(verb),
            run: () => answer('resume'),
          },
          { label: 'skip', run: () => answer('skip') },
        ],
      });
      break;
    default:
      el = card({
        edge: 'signal',
        head: `needs you \u00b7 ${c.kind}`,
        body: c.question,
      });
  }
  el.classList.add('cb-needs-card');
  el.dataset.card = String(c.id);
  el.dataset.kind = c.kind;
  return el;
}
