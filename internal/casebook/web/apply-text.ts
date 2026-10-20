// apply-text.ts — apply's words and counts, as pure
// functions over serve's jobs (no kit or browser imports, so node --test can
// load it).

import type {
  ItemView,
  RunMark,
  Job,
  JobStep,
  NeedsYou,
  Plan,
  Step,
  Waiting,
  Hold,
} from './wire.d.ts';
import { keyLabel, pluralize } from './decide-math.ts';
import type { Tone } from './list-pane-text.ts';

/**
 * runOrder splits the jobs as run lists them, each part newest first:
 * running (approved, running, paused) on top, done (done, failed) below. A
 * plan is review's (it hasn't run), and a cancelled job is a plan that was
 * replaced before it ran: neither is listed.
 */
export function runOrder(jobs: Job[]): { running: Job[]; done: Job[] } {
  const out = { running: [] as Job[], done: [] as Job[] };
  for (const j of [...jobs].sort((a, b) => b.id - a.id)) {
    if (j.state === 'planned' || j.state === 'cancelled') continue;
    if (FINISHED_JOB.has(j.state)) out.done.push(j);
    else out.running.push(j);
  }
  return out;
}

// A job that will not run again.
const FINISHED_JOB = new Set(['done', 'failed', 'cancelled']);

/** isRunning: approved, running or paused (runOrder's running). */
export function isRunning(job: Job): boolean {
  return job.state !== 'planned' && !FINISHED_JOB.has(job.state);
}

/** isFinished: done, failed or cancelled. */
export function isFinished(job: Job): boolean {
  return FINISHED_JOB.has(job.state);
}

/**
 * applyLabel names a waiting group of n items by what will happen, in
 * serve's words: the choice's many ("Delete {n}") with the count and the
 * kind's noun, "Delete 3 branches".
 */
export function applyLabel(
  many: string,
  noun: string,
  nouns: string,
  n: number,
): string {
  return many.replace('{n}', `${n} ${n === 1 ? noun : nouns}`);
}

const TITLES: Record<string, string> = {
  'branch-delete-local': 'delete local branches',
  'branch-delete-remote': 'delete remote branches',
  'worktree-remove': 'remove worktrees',
  'repo-archive': 'archive repos',
  'repo-delete': 'delete repos',
  'pr-close': 'close PRs',
  'pr-merge': 'merge PRs',
  'issue-close': 'close issues',
};

/** actionTitle names a group of steps: "Delete local branches". */
export function actionTitle(action: string): string {
  return TITLES[action] ?? action;
}

/**
 * planTitle names a plan by what it does and to how many: "Delete 7
 * repos", one part per action ("Delete 1 local branch, close 2 prs").
 * nouns gives a kind's singular and plural (serve's vocabulary); a branch
 * deleted locally and on the remote counts once in each.
 */
export function planTitle(
  job: Job,
  nouns: (kind: string) => [string, string],
): string {
  const parts = groupSteps(job.steps ?? []).map((g) => {
    const n = new Set(g.steps.map((s) => s.key)).size;
    const kind = g.steps[0]?.key.slice(0, g.steps[0].key.indexOf(':')) ?? '';
    const [one, many] = nouns(kind);
    const words = actionTitle(g.action).split(' ');
    const mid = words.slice(1, -1);
    return [words[0], String(n), ...mid, n === 1 ? one : many].join(' ');
  });
  if (!parts.length) return `job #${job.id}`;
  return parts.join(', ');
}

const PAST: Record<string, string> = {
  'branch-delete-local': 'deleted',
  'branch-delete-remote': 'deleted on the remote',
  'worktree-remove': 'removed',
  'repo-archive': 'archived',
  'repo-delete': 'deleted',
  'pr-close': 'closed',
  'pr-merge': 'merged',
  'issue-close': 'closed',
};

/** The verb a paused step would do if Court resumes it: "close anyway". */
const RESUME: Record<string, string> = {
  'branch-delete-local': 'delete',
  'branch-delete-remote': 'delete',
  'worktree-remove': 'remove',
  'repo-archive': 'archive',
  'repo-delete': 'delete',
  'pr-close': 'close',
  'pr-merge': 'merge',
  'issue-close': 'close',
};

export function resumeVerb(action: string): string {
  return RESUME[action] ?? 'run';
}

/** What a step does, naming where a branch is deleted (which copy failed matters). */
const VERB: Record<string, string> = {
  'branch-delete-local': 'local delete',
  'branch-delete-remote': 'GitHub delete',
  'worktree-remove': 'worktree remove',
  'repo-archive': 'archive',
  'repo-delete': 'delete',
  'pr-close': 'close',
  'pr-merge': 'merge',
  'issue-close': 'close',
};

/** actionVerb names what a step does: "GitHub delete", "merge". */
export function actionVerb(action: string): string {
  return VERB[action] ?? 'run';
}

/**
 * laneLabel is a lane as the page names it: casebook's own steps are local,
 * the agent's go outward ("pi · outward").
 */
export function laneLabel(lane: string, agent: string): string {
  return lane === 'agent'
    ? `${agent || 'agent'} \u00b7 outward`
    : 'casebook \u00b7 local';
}

export interface StepGroup<S extends Step = Step> {
  action: string;
  lane: string;
  /** Whether its steps can be undone, in serve's words (Group.undo). */
  undo: string;
  steps: S[];
}

/**
 * groupSteps groups steps by (action, lane) in first-seen order: what serve's
 * Plan.Groups does, for a job read back from GET /api/job.
 */
export function groupSteps<S extends Step & { undo_note?: string }>(
  steps: S[],
): StepGroup<S>[] {
  const out: StepGroup<S>[] = [];
  const at = new Map<string, number>();
  for (const s of steps) {
    const k = `${s.action}\u0000${s.lane}`;
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({
        action: s.action,
        lane: s.lane,
        undo: s.undo_note ?? '',
        steps: [s],
      });
    } else out[i].steps.push(s);
  }
  return out;
}

/** jobTitle: its groups' titles, "Delete local branches, archive repos". */
export function jobTitle(job: Job): string {
  const titles = [
    ...new Set(groupSteps(job.steps ?? []).map((g) => actionTitle(g.action))),
  ];
  if (!titles.length) return `job #${job.id}`;
  return titles.join(', ');
}

/** jobLanes: the lanes a job has steps in, casebook's first. */
export function jobLanes(job: Job): string[] {
  const have = new Set((job.steps ?? []).map((s) => s.lane));
  return ['casebook', 'agent'].filter((l) => have.has(l));
}

// A step no lane will move again on its own.
const FINISHED = new Set(['verified', 'reported', 'skipped', 'failed']);

export interface Progress {
  total: number;
  /** Steps finished (verified, reported, skipped, failed). */
  finished: number;
  /** Finished per lane, for the bar's two colours. */
  byLane: Record<string, number>;
  verified: number;
  paused: number;
  skipped: number;
  failed: number;
  /** Any step has moved, or the job is running. */
  started: boolean;
}

export function progress(job: Job): Progress {
  const p: Progress = {
    total: 0,
    finished: 0,
    byLane: {},
    verified: 0,
    paused: 0,
    skipped: 0,
    failed: 0,
    started: job.state === 'running',
  };
  for (const s of job.steps ?? []) {
    p.total++;
    if (s.state !== 'pending') p.started = true;
    if (FINISHED.has(s.state)) {
      p.finished++;
      p.byLane[s.lane] = (p.byLane[s.lane] ?? 0) + 1;
    }
    if (s.state === 'verified') p.verified++;
    if (s.state === 'paused') p.paused++;
    if (s.state === 'skipped') p.skipped++;
    if (s.state === 'failed') p.failed++;
  }
  return p;
}

/** needsLine is the list row's signal line: "1 needs you · 1 paused". */
export function needsLine(needsYou: number, paused: number): string {
  const parts: string[] = [];
  if (needsYou)
    parts.push(`${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`);
  if (paused) parts.push(`${paused} paused`);
  return parts.join(' \u00b7 ');
}

/** openCardsByJob counts the open needs-you cards of each job. */
export function openCardsByJob(cards: NeedsYou[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) {
    if (c.state !== 'open') continue;
    m.set(c.job_id, (m.get(c.job_id) ?? 0) + 1);
  }
  return m;
}

export type { Tone };

export interface StepMark {
  glyph: string;
  text: string;
  /** Why it paused, failed or was skipped: its own line under the key. */
  why?: string;
  tone: Tone;
}

/**
 * stepMark is a step's line in the steps table: ✓ verified, ‖ paused,
 * · next (the next step of its lane), and so on.
 */
export function stepMark(s: JobStep, next: boolean): StepMark {
  const past = PAST[s.action] ?? 'done';
  // The reason gets its own line: beside the key, a long one (a path)
  // squeezed the key to one character wide (Court, 2026-10-18).
  const why = (glyph: string, text: string, tone: Tone): StepMark =>
    s.detail ? { glyph, text, why: s.detail, tone } : { glyph, text, tone };
  if (s.undone_at) return { glyph: '\u21ba', text: 'undone', tone: 'muted' };
  switch (s.state) {
    case 'verified':
      return { glyph: '\u2713', text: `${past} \u00b7 verified`, tone: 'ok' };
    case 'reported':
      return {
        glyph: '\u2713',
        text: `${past} \u00b7 reported`,
        tone: 'muted',
      };
    case 'running':
      return {
        glyph: '\u25b8',
        text: 'running',
        tone: s.lane === 'agent' ? 'agent' : 'signal',
      };
    case 'paused':
      return why('\u2016', 'paused', 'agent');
    case 'needs_you':
      return { glyph: '!', text: 'needs you', tone: 'signal' };
    case 'failed':
      return why('\u2717', 'failed', 'signal');
    case 'skipped':
      return why('\u2013', 'skipped', 'muted');
    default:
      return { glyph: '\u00b7', text: next ? 'next' : 'queued', tone: 'wait' };
  }
}

/** nextSteps: the first pending step of each lane (what runs next there). */
export function nextSteps(steps: JobStep[]): Set<number> {
  const out = new Set<number>();
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.state !== 'pending' || seen.has(s.lane)) continue;
    seen.add(s.lane);
    out.add(s.id);
  }
  return out;
}

/** planSummary: a plan's size, "5 steps · 3 local · 2 outward". */
export function planSummary(steps: Step[]): string {
  let local = 0;
  let out = 0;
  for (const s of steps) {
    if (s.lane === 'agent') out++;
    else local++;
  }
  const parts = [pluralize(steps.length, 'step')];
  if (local) parts.push(`${local} local`);
  if (out) parts.push(`${out} outward`);
  return parts.join(' \u00b7 ');
}

/** needsSession: a plan with agent-lane steps needs a session to approve. */
export function needsSession(steps: Step[]): boolean {
  return steps.some((s) => s.lane === 'agent');
}

/**
 * makeSeq orders replies by when they were asked for: a reply to an older
 * request never replaces what a newer one drew.
 */
export function makeSeq(): { next(): number; isLatest(n: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (n) => n === latest,
  };
}

/**
 * startedKeys maps each item key with a step in a job approved, running or
 * paused to that job (the newest, when two hold it). A plan not yet
 * approved holds nothing here: its items still wait in review, where
 * opening their group builds (or reuses) the plan.
 */
export function startedKeys(jobs: Job[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const j of jobs) {
    if (!STARTED.has(j.state)) continue;
    for (const s of j.steps ?? []) {
      const was = m.get(s.key);
      if (was === undefined || j.id > was) m.set(s.key, j.id);
    }
  }
  return m;
}

const STARTED = new Set(['approved', 'running', 'paused']);

/**
 * runsThrough is review's line about who runs a plan: its outward steps
 * run through the agent the page is attached to; with none attached they
 * can't run. An all-local plan needs no agent.
 */
export function runsThrough(
  steps: Step[],
  agent: string | null,
): { text: string; can: boolean } {
  if (!needsSession(steps)) return { text: '', can: true };
  if (agent === null)
    return { text: 'Open casebook from an agent to run this.', can: false };
  return { text: `runs through ${agent || 'agent'}`, can: true };
}

/** ageText: a short age, "40s", "12m", "3h", "2d". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * observations says how old the observation a plan would be built from is,
 * by serve's rule (a plan is refused once the index is older than one sync
 * interval): "observations fresh", or "observations 34m old" when stale.
 */
export function observations(
  builtAt: number,
  intervalMs: number,
  now: number,
): { text: string; stale: boolean } {
  const age = now - builtAt;
  if (!intervalMs || age <= intervalMs)
    return { text: 'observations fresh', stale: false };
  return { text: `observations ${ageText(age)} old`, stale: true };
}

// STEP_DISPOSITION is the decision a step carries out: with its key's kind,
// the waiting group (serve's to-apply group id) its item was in.
const STEP_DISPOSITION: Record<string, string> = {
  'branch-delete-local': 'delete',
  'branch-delete-remote': 'delete',
  'worktree-remove': 'delete',
  'repo-archive': 'archive',
  'repo-delete': 'delete',
  'pr-close': 'close',
  'pr-merge': 'merge',
  'issue-close': 'close',
};
export function stepGroup(s: Step): string {
  return `${STEP_DISPOSITION[s.action] ?? ''}|${s.key.slice(0, s.key.indexOf(':'))}`;
}

/**
 * heldOutside counts the items of waiting group id that a started job
 * (approved, running, paused) holds and the list hasn't loaded: each item once, however many steps its
 * job has for it (a branch's local and remote delete).
 */
export function heldOutside(
  jobs: Job[],
  id: string,
  loaded: Set<string>,
): number {
  const held = new Set<string>();
  for (const j of jobs) {
    if (!STARTED.has(j.state)) continue;
    for (const s of j.steps ?? [])
      if (!loaded.has(s.key) && stepGroup(s) === id) held.add(s.key);
  }
  return held.size;
}

// ---- review's tags and lines ----

/** What a step's tag warns of: it can't be undone, it is undone on GitHub
 * (not here), or it posts a public comment. */
export type TagKind = 'permanent' | 'github-undo' | 'posts';

export interface Tag {
  kind: TagKind;
  n: number;
}

const ACTION_TAGS: Record<string, TagKind[]> = {
  'repo-delete': ['permanent'],
  'pr-merge': ['permanent'],
  'pr-close': ['github-undo'],
  'issue-close': ['github-undo'],
  'repo-archive': ['github-undo'],
};

/** actionTags: the tags a step of action always carries. */
export function actionTags(action: string): TagKind[] {
  return ACTION_TAGS[action] ?? [];
}

/** stepTags counts each tag over steps, in the order permanent, posts,
 * github-undo; a tag no step carries is left out. */
export function stepTags(steps: Step[]): Tag[] {
  const n: Record<TagKind, number> = {
    permanent: 0,
    posts: 0,
    'github-undo': 0,
  };
  for (const s of steps) {
    for (const k of actionTags(s.action)) n[k]++;
    if (s.posts) n.posts++;
  }
  return (['permanent', 'posts', 'github-undo'] as TagKind[])
    .filter((k) => n[k] > 0)
    .map((kind) => ({ kind, n: n[kind] }));
}

/** tagText words tag t; its count shows on the summary (of = 0) and on a
 * group heading where only some of its of steps carry it. */
export function tagText(t: Tag, of: number): string {
  const counted = of === 0 || t.n < of;
  const lead = counted ? `${count(t.n)} ` : '';
  switch (t.kind) {
    case 'permanent':
      return `${lead}can't be undone`;
    case 'github-undo':
      return `${lead}undo on GitHub`;
    case 'posts':
      return `${lead}${counted && t.n > 1 ? 'post' : 'posts'} a public comment`;
  }
}

/** publicLine is a posting step's line: what it posts, and whether anyone
 * can read it. */
export function publicLine(s: Step): string {
  return `posts publicly${s.public ? ' on a public repo' : ''}: \u201c${s.comment ?? ''}\u201d`;
}

/** count writes n with thousands separators: 1,240. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * runsNow is review's line above the run button: what runs now, by where,
 * then what waits for another Mac and how many are held.
 */
export function runsNow(plan: Plan): string {
  const steps = plan.steps ?? [];
  const by = (a: string) => steps.filter((s) => s.action === a).length;
  const agent = steps.filter((s) => s.lane === 'agent').length;
  const wt = by('worktree-remove');
  const remote = by('branch-delete-remote');
  const local = by('branch-delete-local');
  let first: string;
  if (steps.length && agent === steps.length) {
    first = `${pluralize(steps.length, 'step')} \u00b7 all on GitHub, through the agent.`;
  } else if (!steps.length) {
    first = 'nothing runs now.';
  } else {
    const parts: string[] = [];
    if (wt)
      parts.push(
        `${count(wt)} ${wt === 1 ? 'worktree' : 'worktrees'} removed${remote + local ? ' first' : ''}`,
      );
    if (remote) parts.push(`${count(remote)} deleted on GitHub`);
    if (local) parts.push(`${count(local)} deleted here`);
    if (agent) parts.push(`${count(agent)} on GitHub, through the agent`);
    first = `runs now: ${parts.join(', ')}.`;
  }
  const rest: string[] = [];
  const waits = new Map<string, number>();
  for (const w of plan.waiting ?? [])
    waits.set(w.machine, (waits.get(w.machine) ?? 0) + 1);
  for (const [m, n] of waits)
    rest.push(
      `Waits for ${m}: ${count(n)} ${n === 1 ? 'local copy' : 'local copies'}.`,
    );
  const held = plan.held_back?.length ?? 0;
  if (held) rest.push(`Held: ${count(held)}.`);
  return rest.length ? `${first}\n${rest.join(' ')}` : first;
}

/**
 * reviewKick is review's small line: how many are ticked, and in which
 * group, or how many groups.
 */
export function reviewKick(n: number, groups: string[]): string {
  const where = groups.length === 1 ? groups[0] : `${groups.length} groups`;
  return `review \u00b7 ${n} ticked in ${where}`;
}

/**
 * reviewLine is a review row's second line, where the item stands: what
 * holds it from its decision (agent); for a branch, where it is deleted
 * (its copies still there: GitHub's has no machine); for a worktree on
 * this Mac, "removed here" (what will happen, not serve's done word, which
 * reads as already gone); else its decision done, in serve's words, lower
 * case.
 */
export function reviewLine(
  it: ItemView,
  done: string,
): { text: string; tone: Tone } {
  const d = it.decision?.disposition ?? '';
  const stopping = (it.holds ?? []).filter((x) => (x.stops ?? []).includes(d));
  // A hold on one half (a local copy, or GitHub's) is not the item held:
  // the other half still runs (Court, 2026-10-20).
  const whole = stopping.find((x) => !x.local && !x.remote);
  if (whole) return { text: `held: ${whole.text}`, tone: 'agent' };
  if (it.kind === 'branch') {
    const there = (it.copies ?? []).filter((c) => !c.absent);
    const remote = stopping.find((x) => x.remote);
    const local = stopping.filter((x) => x.local);
    const stopped = new Set(local.map((x) => x.machine ?? ''));
    const gh = !remote && there.some((c) => !c.machine);
    const here = there.some((c) => !!c.machine && !stopped.has(c.machine));
    const parts: string[] = [];
    if (gh || here)
      parts.push(
        `deleted ${[gh ? 'on GitHub' : '', here ? 'here' : ''].filter(Boolean).join(' and ')}`,
      );
    let held = false;
    for (const x of local) {
      if (x.kind === 'other-mac')
        parts.push(`local copy waits for ${x.machine}`);
      else {
        parts.push(`local copy held: ${x.text}`);
        held = true;
      }
    }
    if (remote) {
      parts.push(`GitHub copy held: ${remote.text}`);
      held = true;
    }
    if (parts.length)
      return { text: parts.join(' \u00b7 '), tone: held ? 'agent' : 'muted' };
  }
  const part = stopping[0];
  if (part)
    return part.kind === 'other-mac'
      ? { text: `waits for ${part.machine}`, tone: 'muted' }
      : { text: `held: ${part.text}`, tone: 'agent' };
  if (it.kind === 'worktree') return { text: 'removed here', tone: 'muted' };
  return { text: done.toLowerCase(), tone: 'muted' };
}

/**
 * stepLine is a step's command as it reads to Court, under the key line
 * that names the item: what it does and the commit it insists on, rather than the GraphQL or git it runs
 * (Court, 2026-10-20). The exact command stays in the title (hover).
 */
export function stepLine(s: {
  action: string;
  key: string;
  command: string;
  expected_tip?: string;
}): string {
  const tip = s.expected_tip
    ? ` \u00b7 if still at ${s.expected_tip.slice(0, 7)}`
    : '';
  switch (s.action) {
    case 'branch-delete-remote':
      return `delete on GitHub${tip}`;
    case 'branch-delete-local':
      return `delete here${tip}`;
    case 'worktree-remove':
      return 'remove the worktree';
  }
  return s.command;
}

/** untickHidden is the ticked keys a filter or a search no longer shows. */
export function untickHidden(ticked: string[], shown: Set<string>): string[] {
  return ticked.filter((k) => !shown.has(k));
}

/**
 * stepKey is a step's key in a job's steps table: a worktree by its label
 * (keyLabel), a branch as its repo over its branch, any other key without
 * its kind. The full key goes in the hover.
 */
export function stepKey(key: string): { repo?: string; key: string } {
  const k = keyLabel(key);
  if (!key.startsWith('branch:')) return { key: k };
  const at = k.indexOf('@');
  return at < 0 ? { key: k } : { repo: k.slice(0, at), key: k.slice(at + 1) };
}

/**
 * reviewFollow is what review's middle pane shows once its list settles
 * (a search, a filter, a reload) or its ticks change: the summary with
 * nothing ticked (never a plan reviewed before), the plan for the ticks
 * left when they are not the ones the plan shown is for, or that plan
 * again.
 */
export function reviewFollow(
  ticked: string[],
  reviewed: string[],
  open: boolean,
): 'overview' | 'replan' | 'redraw' {
  if (!ticked.length) return 'overview';
  const same =
    open &&
    ticked.length === reviewed.length &&
    ticked.every((k, i) => k === reviewed[i]);
  return same ? 'redraw' : 'replan';
}

/**
 * waitBlocks splits the items waiting for another Mac into runs of rows
 * that one sentence is true of, in first-seen order: a branch whose GitHub
 * delete is among steps says its GitHub copy is deleted above, one without
 * doesn't, and a worktree is removed from review there.
 */
export function waitBlocks(
  waits: Waiting[],
  steps: Pick<Step, 'key' | 'action'>[],
): { text: string; waits: Waiting[] }[] {
  const github = new Set(
    steps.filter((s) => s.action === 'branch-delete-remote').map((s) => s.key),
  );
  const out: { text: string; waits: Waiting[] }[] = [];
  for (const w of waits) {
    const m = w.machine;
    let text: string;
    if (w.key.startsWith('worktree:'))
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

/** heldText is the Held section's line. */
export const heldText =
  'Not run here. Each says what holds it; settle that and it joins the next run.';

/**
 * otherHalf is a held row's suffix when another step of its item runs in
 * this plan (a branch held only on GitHub or only here).
 */
export function otherHalf(key: string, steps: Pick<Step, 'key'>[]): string {
  return steps.some((s) => s.key === key)
    ? ' \u00b7 its other half runs above'
    : '';
}

// ---- run's items ----

const NEEDS = new Set(['failed', 'needs_you', 'paused']);
const UNFINISHED = new Set(['pending', 'running', 'reported']);

/**
 * standsStep is the step that says where an item stands in its job: the
 * first that needs Court, else the first not finished, else the last.
 */
export function standsStep(m: RunMark): JobStep {
  const steps = m.steps ?? [];
  return (
    steps.find((s) => NEEDS.has(s.state)) ??
    steps.find((s) => UNFINISHED.has(s.state)) ??
    steps[steps.length - 1]
  );
}

/**
 * ranLine is a run row's second line: what happened and in which job. A
 * step that stopped names what it was ("GitHub delete failed · job #33");
 * one that ran says how it ended ("deleted · verified · job #28").
 */
export function ranLine(
  m: RunMark,
  holds: Hold[] = [],
): { text: string; tone: Tone } {
  const s = standsStep(m);
  if (!s) return { text: `job #${m.job}`, tone: 'muted' };
  const mark = stepMark(s, false);
  const stopped = NEEDS.has(s.state) || s.state === 'skipped';
  const what = stopped ? `${actionVerb(s.action)} ${mark.text}` : mark.text;
  // What still waits for another Mac, after what ran (Court, 2026-10-20).
  const waits = holds
    .filter((x) => x.kind === 'other-mac')
    .map((x) => ` \u00b7 local copy waits for ${x.machine}`)
    .join('');
  return { text: `${what} \u00b7 job #${m.job}${waits}`, tone: mark.tone };
}

/**
 * aroundSteps is the steps of a job around key's first: span before and
 * after it, and how many that leaves out.
 */
export function aroundSteps(
  steps: JobStep[],
  key: string,
  span: number,
): { steps: JobStep[]; hidden: number } {
  const i = Math.max(
    0,
    steps.findIndex((s) => s.key === key),
  );
  const shown = steps.slice(Math.max(0, i - span), i + span + 1);
  return { steps: shown, hidden: steps.length - shown.length };
}

/**
 * runBulk is the steps each of run's buttons acts on for the ticked items
 * (their marks), every step of each item, not one: skip covers each step
 * that needs Court in a job still open, when every one of them has an open
 * failed or paused card; hand to agent the same, open failed cards only;
 * undo every step that can be undone, when every item has one. Empty: the
 * button doesn't fit them all.
 */
export function runBulk(
  marks: RunMark[],
  cards: NeedsYou[],
): { skip: JobStep[]; hand: JobStep[]; undo: JobStep[] } {
  const open = (s: JobStep, kinds: string[]) =>
    cards.some(
      (c) => c.state === 'open' && c.step_id === s.id && kinds.includes(c.kind),
    );
  const per = (f: (m: RunMark) => JobStep[]): JobStep[] | null => {
    const each = marks.map(f);
    return marks.length > 0 && each.every((x) => x.length > 0)
      ? each.flat()
      : null;
  };
  const needs = per((m) =>
    m.finished ? [] : (m.steps ?? []).filter((s) => NEEDS.has(s.state)),
  );
  const fit = (kinds: string[]) =>
    needs && needs.every((s) => open(s, kinds)) ? needs : [];
  return {
    skip: fit(['failed', 'paused']),
    hand: fit(['failed']),
    undo: per((m) => (m.steps ?? []).filter((s) => !!s.undoable)) ?? [],
  };
}

// A step's state as ticked steps are counted: "2 failed steps".
const STATE_WORD: Record<string, string> = {
  failed: 'failed',
  paused: 'paused',
  needs_you: 'waiting',
  skipped: 'skipped',
  verified: 'done',
  reported: 'reported',
  running: 'running',
  pending: 'queued',
};

/**
 * tickedRunWords is the middle pane's lines for ticked run items: where
 * they are ticked, what their steps are ("2 failed steps"; "3 items" when
 * they differ), and their jobs.
 */
export function tickedRunWords(
  marks: RunMark[],
  groupLabel: string,
): { kick: string; title: string; ctx: string } {
  const n = marks.length;
  const steps = marks.map(standsStep).filter(Boolean);
  const states = [
    ...new Set(steps.map((s) => (s.undone_at ? 'undone' : s.state))),
  ];
  const word =
    states.length === 1
      ? states[0] === 'undone'
        ? 'undone'
        : STATE_WORD[states[0]]
      : '';
  const jobs = [...new Set(marks.map((m) => m.job))].sort((a, b) => a - b);
  return {
    kick: `run \u00b7 ${n} ticked in ${groupLabel}`,
    title: word
      ? `${n} ${word} ${n === 1 ? 'step' : 'steps'}`
      : pluralize(n, 'item'),
    ctx:
      jobs.length === 1
        ? `job #${jobs[0]}`
        : `jobs ${jobs.map((j) => `#${j}`).join(', ')}`,
  };
}
