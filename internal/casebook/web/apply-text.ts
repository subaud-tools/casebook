// apply-text.ts — apply's words and counts, as pure
// functions over serve's jobs (no kit or browser imports, so node --test can
// load it).

import type { Job, JobStep, NeedsYou, Step } from './wire.d.ts';
import { pluralize } from './decide-math.ts';

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
  'branch-delete-local': 'Delete local branches',
  'branch-delete-remote': 'Delete remote branches',
  'worktree-remove': 'Remove worktrees',
  'repo-archive': 'Archive repos',
  'repo-delete': 'Delete repos',
  'pr-close': 'Close PRs',
  'pr-merge': 'Merge PRs',
  'issue-close': 'Close issues',
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
  return parts
    .map((t, i) => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t))
    .join(', ');
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
const VERB: Record<string, string> = {
  'branch-delete-local': 'delete',
  'branch-delete-remote': 'delete',
  'worktree-remove': 'remove',
  'repo-archive': 'archive',
  'repo-delete': 'delete',
  'pr-close': 'close',
  'pr-merge': 'merge',
  'issue-close': 'close',
};

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
  return titles
    .map((t, i) => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t))
    .join(', ');
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

export type Tone = 'ok' | 'agent' | 'signal' | 'wait' | 'muted';

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
