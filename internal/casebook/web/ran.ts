// ran.ts — a job, and what ran on one item.
//
// renderJob draws a running or finished job (#/run/<id>): its facts, the
// cards that need Court, and the steps table. renderRan draws an item run
// lists (#/run?item=<key>): its head, what ran on it (every step on it,
// across jobs, with undo and its cards' skip and hand to agent), then its
// job: the latest job it ran in, the steps around this item's ("this
// item"), and "all N steps →" to the job.

import { h, facts, buttons, card, type Button } from '/_kit/kit.js';
import type {
  ItemDetailView,
  Job,
  JobStep,
  JobView,
  NeedsYou,
} from './wire.d.ts';
import type { Ctx } from './app.ts';
import { keyLabel, pluralize } from './decide-math.ts';
import { DANGER_DISPS } from './decide.ts';
import {
  actionVerb,
  aroundSteps,
  isRunning,
  jobLanes,
  jobTitle,
  laneLabel,
  nextSteps,
  progress,
  resumeVerb,
  stepMark,
  stepLine,
  stepKey,
} from './apply-text.ts';
import { midHead } from './mid.ts';

// A destructive verb reads in danger text (delete, close, archive).
const dangerVerb = (verb: string) =>
  DANGER_DISPS.has(verb) || verb === 'remove';

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
 * stepKeyLines is a step's key in the steps table (stepKey): for a branch,
 * the repo (muted, the row's full width) over the branch, which shares its
 * line with the state; neither wraps mid-word (Court, 2026-10-18). Any other
 * key, a worktree by its label, is the one line beside the state. The full
 * key is the hover.
 */
function stepKeyLines(full: string): HTMLElement[] {
  const k = stepKey(full);
  if (k.repo === undefined)
    return [h('span', { class: 'cb-step-k', title: full }, k.key)];
  return [
    h('span', { class: 'cb-step-repo', title: full }, k.repo),
    h('span', { class: 'cb-step-k', title: full }, k.key),
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
      ...shown.map((s) => stepRow(s, next.has(s.id), hooks)),
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
export function needsCard(
  c: NeedsYou,
  step: JobStep | undefined,
  j: Job,
  agent: string,
  hooks: JobHooks,
): HTMLElement {
  const key = step ? keyLabel(step.key) : '';
  const verb = step ? resumeVerb(step.action) : 'run';
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
          step
            ? h(
                'code',
                { class: 'cb-cmd', title: step.command },
                stepLine(step),
              )
            : null,
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

// stepRow is one step in a steps table: its mark, its key, its state,
// undo where serve says it can be undone (not when read-only: another
// item's step, beside this one in its job), and why it stopped.
function stepRow(
  s: JobStep,
  next: boolean,
  hooks: Pick<JobHooks, 'undo'>,
  o: {
    what?: string;
    here?: boolean;
    job?: boolean;
    line?: boolean;
    readOnly?: boolean;
  } = {},
): HTMLElement {
  const m = stepMark(s, next);
  const text = o.what ? `${o.what} \u00b7 ${m.text}` : m.text;
  return h(
    'div',
    {
      class: 'kit-tr cb-step' + (o.here ? ' cb-here' : ''),
      'data-step': String(s.id),
      'data-state': s.state,
      'data-key': s.key,
    },
    h('span', { class: `cb-step-g cb-tone-${m.tone}` }, m.glyph),
    // One line for the key (whole on hover), or a branch's repo over it.
    ...(o.line
      ? [h('span', { class: 'cb-step-k', title: s.key }, keyLabel(s.key))]
      : stepKeyLines(s.key)),
    h(
      'span',
      { class: 'cb-step-w' },
      h('span', { class: 'cb-step-t' }, text),
      o.job
        ? h(
            'a',
            { class: 'cb-link cb-step-job', href: `#/run/${s.job_id}` },
            `job #${s.job_id}`,
          )
        : null,
      o.here ? h('span', { class: 'cb-step-here' }, 'this item') : null,
      s.undoable && !o.readOnly
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
    m.why ? h('span', { class: 'cb-step-why', title: m.why }, m.why) : null,
  );
}

// ranHead is a run item's head in the middle's fixed lines: the small line
// (its kind and key), its title, and a context line (how it stands, its
// repo), each one line, whole on hover. Its buttons are below it, on the
// needs-you cards and the steps.
function ranHead(detail: ItemDetailView): HTMLElement[] {
  const it = detail.item;
  const key = keyLabel(it.key);
  const status = detail.done_how
    ? `${it.status}: ${detail.done_how}`
    : (it.status ?? '');
  return midHead({
    kick: [it.kind, key, it.relation].filter(Boolean).join(' \u00b7 '),
    title: it.title || key,
    ctx: [status, it.repo].filter(Boolean).join(' \u00b7 '),
    acts: [],
  });
}

/**
 * renderRan draws an item run lists: its head; what ran on it, every step
 * on it from every job that ran, each with its result, its job and undo,
 * and the open cards of its steps (skip, hand to agent); then its job, the
 * latest it ran in, with the steps around this item's marked "this item"
 * and, past those, "all N steps →".
 */
export function renderRan(
  ctx: Ctx,
  detail: ItemDetailView,
  job: JobView | null,
  cards: NeedsYou[],
  hooks: JobHooks,
): HTMLElement {
  const key = detail.item.key;
  const steps = detail.steps ?? [];
  const doc = h(
    'article',
    { class: 'cb-apply-doc cb-ran', 'data-key': key },
    ...ranHead(detail),
  );
  doc.append(
    h('h3', { class: 'kit-label' }, 'what ran on this item'),
    h(
      'div',
      { class: 'kit-table cb-steps', 'data-testid': 'what-ran' },
      ...steps.map((s) =>
        stepRow(s, false, hooks, {
          what: actionVerb(s.action),
          job: true,
          line: true,
        }),
      ),
    ),
  );
  const mine = new Set(steps.map((s) => s.id));
  const open = cards.filter((c) => c.state === 'open' && mine.has(c.step_id));
  if (open.length) {
    const cardsEl = h('div', { class: 'cb-needs', 'data-testid': 'needs-you' });
    for (const c of open) {
      const s = steps.find((x) => x.id === c.step_id);
      const j = job && job.job.id === c.job_id ? job.job : null;
      cardsEl.append(
        needsCard(
          c,
          s,
          j ?? {
            id: c.job_id,
            machine: '',
            session: '',
            state: '',
            paused: false,
            created_at: '',
            steps: [],
          },
          j ? hooks.agent(j) : 'agent',
          hooks,
        ),
      );
    }
    doc.append(cardsEl);
  }
  const note = hooks.note();
  if (note)
    doc.append(h('p', { class: 'cb-apply-note', role: 'status' }, note));
  if (!job) return doc;
  const j = job.job;
  const all = j.steps ?? [];
  const around = aroundSteps(all, key, 3);
  const next = nextSteps(all);
  doc.append(
    h(
      'h3',
      { class: 'kit-label cb-its-job' },
      'its job \u00b7 ',
      h('a', { class: 'cb-link', href: `#/run/${j.id}` }, `job #${j.id}`),
      ` \u00b7 ${jobTitle(j)}`,
    ),
    h(
      'div',
      { class: 'kit-table cb-steps', 'data-testid': 'its-job' },
      ...around.steps.map((s) =>
        // The other items' steps are read-only: what they are and how
        // they stand. The job's page acts on the whole job.
        stepRow(s, next.has(s.id), hooks, {
          here: s.key === key,
          line: true,
          readOnly: s.key !== key,
        }),
      ),
      around.hidden
        ? h(
            'div',
            { class: 'kit-tr cb-steps-more' },
            h('span'),
            h(
              'a',
              { class: 'cb-link cb-step-k', href: `#/run/${j.id}` },
              `all ${all.length} steps \u2192`,
            ),
          )
        : null,
    ),
  );
  return doc;
}
