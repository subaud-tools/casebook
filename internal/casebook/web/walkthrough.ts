// walkthrough.ts — the first-run walkthrough, on the real page.
//
// The first time casebook opens (and on g w), the page pauses: an overlay
// takes every click and key, and the live stream is held (app.ts), so
// nothing moves under it. One control at a time is outlined with a short
// note, in the order casebook is used: decide, filters, rules, a decision
// button (the first listed item is opened for it; no item, no step), review,
// the agent (the pane is opened for it). Each step has next and skip (Esc
// skips, → goes on). It never decides or runs anything: the controls it
// points at can't be clicked under it. Done or skipped, it is marked seen
// (localStorage casebook.walkthrough), the page goes back to the address
// and the pane it had, and what the stream held is delivered.
//
// Only type imports: node --test loads the steps and placeNote.

import type { Ctx } from './app.ts';

/** Where the walkthrough is marked seen ('seen'). */
export const WALKTHROUGH_SEEN = 'casebook.walkthrough';

export type WalkStepId =
  'decide' | 'filters' | 'rules' | 'decision' | 'review' | 'agent';

export interface WalkStep {
  id: WalkStepId;
  /** The control it outlines: a selector on the real page. */
  target: string;
  note: string;
}

export const WALKTHROUGH_STEPS: WalkStep[] = [
  {
    id: 'decide',
    target: '.kit-ctl[data-id="decide"]',
    note: 'decide lists everything that needs a decision: branches, pull requests, issues, repos and worktrees.',
  },
  {
    id: 'filters',
    target: '.kit-list:not([hidden]) .cb-filters',
    note: 'Filters narrow the list. Pick one or more; + filter saves a new one.',
  },
  {
    id: 'rules',
    target: '.kit-list:not([hidden]) .cb-rule-row',
    note: 'Rules recommend a decision for many items at once. Each rule\u2019s recommendations are a group in the list, with one button for all of them.',
  },
  {
    id: 'decision',
    target: '.kit-read:not([hidden]) .cb-decide-row .cb-choice',
    note: 'A button like this decides the item. Nothing happens yet: what you decide waits in review.',
  },
  {
    id: 'review',
    target: '.kit-ctl[data-id="review"]',
    note: 'review shows what each group of decisions will do, command by command. Its button runs it, and run shows the job as it goes.',
  },
  {
    id: 'agent',
    target: '.kit-rail',
    note: 'Ask the agent at any point. It knows what you\u2019re looking at.',
  },
];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(v, hi));

/**
 * placeNote puts the note beside its control, inside the window and off
 * the control: below it, else above, else to its left, else to its right
 * (the first that fits); else in the middle of the window.
 */
export function placeNote(
  target: Box,
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = 12,
): { x: number; y: number } {
  const maxX = Math.max(MARGIN, view.width - card.width - MARGIN);
  const maxY = Math.max(MARGIN, view.height - card.height - MARGIN);
  const x = clamp(target.x, MARGIN, maxX);
  const y = clamp(target.y, MARGIN, maxY);
  const below = target.y + target.height + gap;
  if (below + card.height <= view.height - MARGIN) return { x, y: below };
  const above = target.y - gap - card.height;
  if (above >= MARGIN) return { x, y: above };
  const left = target.x - gap - card.width;
  if (left >= MARGIN) return { x: left, y };
  const right = target.x + target.width + gap;
  if (right + card.width <= view.width - MARGIN) return { x: right, y };
  return {
    x: clamp((view.width - card.width) / 2, MARGIN, maxX),
    y: clamp((view.height - card.height) / 2, MARGIN, maxY),
  };
}

/** walkthroughSeen: the walkthrough was done or skipped in this browser. */
export function walkthroughSeen(): boolean {
  try {
    return localStorage.getItem(WALKTHROUGH_SEEN) === 'seen';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(WALKTHROUGH_SEEN, 'seen');
  } catch {
    // no storage: it shows again next time
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// waitFor polls for a shown element matching sel (up to ms).
async function waitFor(sel: string, ms: number): Promise<HTMLElement | null> {
  const end = Date.now() + ms;
  for (;;) {
    const e = document.querySelector<HTMLElement>(sel);
    if (e && e.getBoundingClientRect().width > 0) return e;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

const ROW = '.kit-list:not([hidden]) .kit-row:not(.cb-left-open)';
// decide's groups start collapsed (serve sends no rows for them): a list
// with items has group headers before it has rows.
// The left-open group holds items already decided: not something to decide.
const UNDECIDED =
  '.kit-list:not([hidden]) .cb-group:not([data-group="left-open"])';
const GROUP_CARET = `${UNDECIDED}.collapsed .cb-group-caret`;
const HAS_ITEMS = `${ROW}, ${UNDECIDED}`;

export function makeWalkthrough(ctx: Ctx): { start(): void } {
  let running = false;

  function start(): void {
    if (running) return;
    running = true;
    ctx.pauseLive(true);
    // No address is decide's: say so in place (no history entry, no route
    // change), so going back over the walkthrough's entries lands on it.
    if (!location.hash) history.replaceState(history.state, '', '#/decide');
    const startHash = location.hash;
    const pane = ctx.dockPane();
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const overlay = el('div', 'cb-walk');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'walkthrough');
    const ring = el('div', 'cb-walk-ring');
    const card = el('div', 'cb-walk-card');
    const count = el('p', 'cb-walk-count');
    const note = el('p', 'cb-walk-note');
    const skipBtn = el('button', 'kit-btn cb-walk-skip', 'skip');
    const nextBtn = el('button', 'kit-btn fill cb-walk-next', 'next');
    skipBtn.type = 'button';
    nextBtn.type = 'button';
    const acts = el('div', 'cb-walk-acts');
    acts.append(skipBtn, nextBtn);
    card.append(count, note, acts);
    // Nothing is outlined until the first step's control is found.
    ring.hidden = true;
    card.hidden = true;
    overlay.append(ring, card);
    document.body.append(overlay);

    let steps: WalkStep[] = WALKTHROUGH_STEPS;
    let at = -1;
    let ended = false;
    let raf = 0;
    // Each step moves on once; a click while one is getting ready waits.
    let moving = false;
    // pushed counts the history entries the walkthrough's own navigation
    // made (going to decide, opening the first item): the end goes back
    // over them, so it leaves no history. An address change while no step
    // is getting ready is Court's (Back, a link, the address bar): it ends
    // the walkthrough there.
    let pushed = 0;
    function onHash(): void {
      if (moving) pushed++;
      else finish(false);
    }
    window.addEventListener('hashchange', onHash);

    // place follows the step's control every frame (a list loading, the
    // pane opening): the outline on it, the note beside it.
    function place(): void {
      const step = steps[at];
      const target = step
        ? document.querySelector<HTMLElement>(step.target)
        : null;
      if (target) {
        const r = target.getBoundingClientRect();
        ring.style.left = `${r.x}px`;
        ring.style.top = `${r.y}px`;
        ring.style.width = `${r.width}px`;
        ring.style.height = `${r.height}px`;
        const p = placeNote(
          r,
          { width: card.offsetWidth, height: card.offsetHeight },
          { width: innerWidth, height: innerHeight },
        );
        card.style.left = `${p.x}px`;
        card.style.top = `${p.y}px`;
      }
      raf = requestAnimationFrame(place);
    }

    // show goes to step i or the first after it whose control is there.
    async function show(i: number): Promise<void> {
      for (; i < steps.length; i++) {
        const step = steps[i];
        if (step.id === 'decision') {
          // The first group opens (its rows load) when none is open yet.
          let row = document.querySelector<HTMLElement>(ROW);
          if (!row) {
            document.querySelector<HTMLElement>(GROUP_CARET)?.click();
            row = await waitFor(ROW, 4000);
            if (ended) return;
          }
          if (!row) continue;
          row.click();
        }
        if (step.id === 'agent') ctx.setDockPane(true);
        const target = await waitFor(step.target, 4000);
        if (ended) return;
        if (!target) continue;
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        at = i;
        overlay.dataset.step = step.id;
        count.textContent = `${i + 1} of ${steps.length}`;
        note.textContent = step.note;
        nextBtn.textContent = i === steps.length - 1 ? 'done' : 'next';
        ring.hidden = false;
        card.hidden = false;
        nextBtn.focus();
        return;
      }
      finish();
    }

    function next(): void {
      if (moving || ended) return;
      moving = true;
      void show(at + 1).finally(() => {
        moving = false;
      });
    }

    // finish ends it; restore (done, skip, Esc) goes back to where it
    // started, Court's own navigation (restore false) stays where he went.
    function finish(restore = true): void {
      if (ended) return;
      ended = true;
      markSeen();
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      overlay.remove();
      if (restore && pushed > 0) history.go(-pushed);
      else if (restore && location.hash !== startHash) {
        if (startHash) location.hash = startHash;
        else ctx.route.go('decide');
      }
      ctx.setDockPane(pane);
      if (focused?.isConnected) focused.focus();
      ctx.pauseLive(false);
      running = false;
    }

    // onKey takes every key first: Esc skips, → goes on, Tab moves between
    // the two buttons, Enter and space press the focused one; the page's
    // own keys wait.
    function onKey(e: KeyboardEvent): void {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === nextBtn ? skipBtn : nextBtn).focus();
        return;
      }
      const onButton = e.target === skipBtn || e.target === nextBtn;
      if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
      e.preventDefault();
    }

    skipBtn.addEventListener('click', () => finish());
    nextBtn.addEventListener('click', () => next());
    window.addEventListener('keydown', onKey, true);
    raf = requestAnimationFrame(place);

    // The walkthrough starts on decide, once its list has loaded; an empty
    // list has no decision step.
    moving = true;
    void (async () => {
      const at = ctx.route.current().section;
      if (at === 'review' || at === 'run') ctx.route.go('decide');
      await waitFor('.kit-list:not([hidden]) .kit-rows > *', 4000);
      if (ended) return;
      if (!document.querySelector(HAS_ITEMS))
        steps = WALKTHROUGH_STEPS.filter((s) => s.id !== 'decision');
      await show(0);
      moving = false;
    })();
  }

  return { start };
}
