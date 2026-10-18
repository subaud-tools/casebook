// item.ts — the reading-column document for a casebook item.
//
// renderItem(ctx, detail) produces the item page, top to bottom:
//   what it is: the « ‹ › » row (decide's, when the item is in its list) ·
//     kicker · h1 title (two lines kept for it) · one line of facts
//     ("came back · ‹reason›" first when it came back)
//   decide: one fixed-height row of short decision buttons (choices.ts),
//     the recommended one marked, "Look into it" last
//   the reading (.cb-reading): who is looking into it, the recommendation's
//     reason and source, the description, evidence beside history
//
// Everything above the row keeps its size from item to item, so moving
// between items doesn't move the buttons. Nothing scrolls on its own: the
// page does. The returned element replaces the .kit-read content; it is a
// plain HTMLElement, not a kit component, so it can be replaced at will.

import { h, facts, fold } from '/_kit/kit.js';
import type { ItemDetailView, Evidence, Event, LogEntry } from './wire.d.ts';
import type { Ctx } from './app.ts';
import { getVocab } from './decide.ts';
import { renderChoices, asNotNow } from './choices.ts';
import { keyWithoutKind, recommendsWho, stripOwnKey } from './decide-math.ts';
import type { DecisionVocabView } from './wire.d.ts';
import { lookingLine } from './sessions.ts';

// Body is capped at 600 chars per the spec; anything longer is folded.
const BODY_CAP = 600;

// Format a UTC string for display.
function fmtDate(s: string | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Short mono date for history entries: MM-DD (year omitted for brevity).
function fmtShortDate(s: string | undefined): string {
  if (!s)
    return '\
def';
  const d = new Date(s);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

// ---- evidence ---------------------------------------------------------------

function renderEvidence(evs: Evidence[]): HTMLElement {
  const section = h('section', { class: 'cb-evidence' });
  section.append(h('h3', { class: 'kit-label' }, 'evidence'));
  if (evs.length === 0) {
    section.append(h('p', { class: 'cb-empty' }, 'no evidence'));
    return section;
  }
  for (const ev of evs) {
    // Author is shown in agent colour at the start of the meta line.
    const authorEl = ev.author
      ? h('span', { class: 'cb-evidence-author' }, ev.author + ' ')
      : null;
    const time = h(
      'span',
      { class: 'cb-muted' },
      ` · ${fmtShortDate(ev.created_at)}`,
    );
    const item = h(
      'div',
      { class: 'cb-evidence-item' },
      h(
        'p',
        { class: 'cb-evidence-meta' },
        ...(authorEl ? [authorEl] : []),
        ev.text,
        time,
      ),
    );
    section.append(item);
  }
  return section;
}

// ---- history ----------------------------------------------------------------

function renderHistory(
  events: Event[],
  decisions: LogEntry[],
  ownKey: string,
): HTMLElement {
  const section = h('section', { class: 'cb-history' });
  section.append(h('h3', { class: 'kit-label' }, 'history'));

  if (events.length === 0 && decisions.length === 0) {
    section.append(h('p', { class: 'cb-empty' }, 'no history'));
    return section;
  }

  // Decisions (git log): strip the item's own key from the subject so entries
  // read as "decide \u2192 close by schuettc" rather than repeating the key.
  for (const entry of decisions) {
    const display = stripOwnKey(entry.Subject, ownKey);
    section.append(
      h(
        'div',
        { class: 'cb-history-item cb-history-decision' },
        h('span', { class: 'cb-history-time' }, fmtShortDate(entry.Time)),
        h('span', { class: 'cb-history-msg' }, display),
      ),
    );
  }

  // Journal events (most recent last; already trimmed to 50 by the server).
  for (const ev of events) {
    const label =
      ev.actions && ev.actions.length > 0
        ? ev.actions
            .map((a) => (a as { hook?: string }).hook ?? '')
            .filter(Boolean)
            .join(', ')
        : (ev.hook ?? ev.src);
    section.append(
      h(
        'div',
        { class: 'cb-history-item' },
        h('span', { class: 'cb-history-time' }, fmtShortDate(ev.ts)),
        h('span', { class: 'cb-history-msg' }, label),
      ),
    );
  }

  return section;
}

// ---- the decide step ---------------------------------------------------------

/** What the decide step does with a pick (decide-list.ts). */
export interface ItemHooks {
  /** A button was picked: decide the item (Not now with its until, a close
   * with its closing comment: note, '' for none). */
  decide?: (disposition: string, until?: string, note?: string) => void;
  /** The decision buttons are in place: decide adds "Look into it". */
  cardsReady?: () => void;
  /** The « ‹ › » row, at the top (decide's; none when the item is not in
   * its list). */
  nav?: HTMLElement | null;
  /** A recommendation's source by name ("rule:‹id›": the rule's name), ''
   * when the page has none for it. */
  sourceName?: (source: string) => string;
}

// renderDecideRow is the decide step: one fixed-height row of short
// decision buttons (serve's labels; each hover is serve's says), the
// recommended one marked, "Look into it" last (decide-list.ts). serve's
// question for the kind names the row for a screen reader.
function renderDecideRow(
  ctx: Ctx,
  detail: ItemDetailView,
  hooks: ItemHooks,
): HTMLElement {
  const it = detail.item;
  const section = h('section', { class: 'cb-decide', role: 'group' });
  const pending =
    it.proposal && it.proposal.state === 'pending' ? it.proposal : null;
  const cards = renderChoices(ctx, it.kind, {
    recommended: pending?.disposition,
    chosen: it.decision?.disposition,
    note: it.decision?.note,
    onPick(d, until, note) {
      hooks.decide?.(d, until, note);
    },
    onCards() {
      hooks.cardsReady?.();
    },
  });
  cards.querySelector('.cb-choices')?.classList.add('cb-decide-row');
  section.append(cards);
  void getVocab(ctx).then((vocab: DecisionVocabView) => {
    const kv = (vocab.kinds ?? []).find((k) => k.kind === it.kind);
    section.setAttribute('aria-label', kv?.question ?? '');
  });
  return section;
}

// renderRec is the pending recommendation, first in the reading: who
// recommends it ("agent recommends", a rule by its name), the choice,
// its reason and its until. None when nothing is recommended.
function renderRec(
  ctx: Ctx,
  detail: ItemDetailView,
  hooks: ItemHooks,
): HTMLElement | null {
  const it = detail.item;
  const p = it.proposal && it.proposal.state === 'pending' ? it.proposal : null;
  if (!p) return null;
  const who = h('p', { class: 'cb-rec-who' });
  const label = h('p', { class: 'cb-rec-label' }, p.disposition);
  const el = h(
    'section',
    { class: 'cb-rec' },
    who,
    label,
    p.note ? h('p', { class: 'cb-rec-note' }, p.note) : null,
    p.until ? h('p', { class: 'cb-rec-until' }, `until ${p.until}`) : null,
  );
  // The vocabulary is fetched once and cached: this resolves at once after
  // the first item.
  void getVocab(ctx).then((vocab: DecisionVocabView) => {
    const kv = (vocab.kinds ?? []).find((k) => k.kind === it.kind);
    const rec = asNotNow(p.disposition);
    label.textContent =
      kv?.choices?.find((c) => c.disposition === rec)?.label ?? p.disposition;
    who.textContent = recommendsWho(
      vocab,
      p.source,
      hooks.sourceName?.(p.source) ?? '',
    );
  });
  return el;
}

// cameBack is why the item came back for a decision (its due reason, or
// serve's words for its status), '' when it didn't.
function cameBack(
  vocab: DecisionVocabView,
  it: ItemDetailView['item'],
): string {
  const status = vocab.came_back?.[it.status ?? ''];
  if (status) return it.due_reason || status;
  return it.new_activity ? (it.due_reason ?? '') : '';
}

// ---- public -----------------------------------------------------------------

export function renderItem(
  ctx: Ctx,
  detail: ItemDetailView,
  hooks: ItemHooks = {},
): HTMLElement {
  const it = detail.item;

  const el = h('article', { class: 'cb-item', dataset: { key: it.key } });

  // ---- kicker ---------------------------------------------------------------
  // Show the kind prefix once, then the key without its kind prefix. The key
  // links to the item's GitHub page (serve's url: a PR, an issue, a repo) in
  // a new tab; a branch or a worktree has none, and its key is plain text.
  const displayKey = keyWithoutKind(it.key);
  const keyEl: Node | string = it.url
    ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, displayKey)
    : displayKey;
  const kicker = h('p', { class: 'cb-kicker kit-kick' });
  const parts = [it.kind, keyEl, it.relation].filter(
    (part): part is Node | string => !!part,
  );
  parts.forEach((part, i) => {
    if (i > 0) kicker.append(' \u00b7 ');
    kicker.append(part);
  });
  el.append(kicker);

  // ---- title ----------------------------------------------------------------
  // Fallback: use the display key (without kind prefix) so titleless items
  // like branch:schuettc/hail@feat/client show "schuettc/hail@feat/client"
  // rather than repeating the kind already shown in the kicker.
  // Two lines are kept for it, and a longer one is cut there (whole in its
  // tooltip).
  const title = it.title ?? keyWithoutKind(it.key);
  el.append(h('h1', { class: 'cb-title kit-h1', title }, title));

  // ---- facts: one line, "came back · ‹reason›" first when it came back -----
  const factPairs: Array<[string, string]> = [];
  if (it.repo) factPairs.push(['repo', it.repo]);
  if (it.status) factPairs.push(['status', it.status]);
  if (it.author)
    factPairs.push(['author', it.author + (it.author_is_bot ? ' (bot)' : '')]);
  if (it.created_at) factPairs.push(['opened', fmtDate(it.created_at)]);
  if (it.updated_at) factPairs.push(['updated', fmtDate(it.updated_at)]);
  if (it.labels && it.labels.length > 0)
    factPairs.push(['labels', it.labels.join(', ')]);
  if (it.landed) factPairs.push(['landed', it.landed_how ?? it.landed]);
  const factsEl = facts(factPairs);
  factsEl.title = factsEl.textContent ?? '';
  el.append(factsEl);
  void getVocab(ctx).then((vocab: DecisionVocabView) => {
    const why = cameBack(vocab, it);
    if (!why) return;
    const line = vocab.came_back_fact.replaceAll('{reason}', why);
    factsEl.prepend(h('span', { class: 'cb-came-back', title: line }, line));
    factsEl.title = factsEl.textContent ?? '';
  });

  // ---- decide: one row of buttons -------------------------------------------
  el.append(renderDecideRow(ctx, detail, hooks));

  // ---- the reading: the recommendation, the description, evidence, history -
  // The parts that grow, below the row; the page scrolls, nothing in it does.
  // "‹session› is looking into it" leads it (decide-list.ts keeps it
  // current), and a recommendation that came mid-input says so first.
  const looking = lookingLine(it.looking);
  const reading = h(
    'div',
    { class: 'cb-reading' },
    h('p', { class: 'cb-looking', hidden: !looking }, looking),
    renderRec(ctx, detail, hooks),
  );
  if (it.body) {
    const excerpt = it.body.slice(0, BODY_CAP);
    const rest = it.body.slice(BODY_CAP);
    reading.append(
      h(
        'section',
        { class: 'cb-body' },
        h('p', null, excerpt),
        rest ? fold('read more', h('p', null, rest)) : null,
      ),
    );
  }
  reading.append(
    h(
      'div',
      { class: 'cb-trail' },
      renderEvidence(detail.evidence ?? []),
      renderHistory(detail.history ?? [], detail.decisions ?? [], it.key),
    ),
  );
  el.append(reading);

  // Wrap in .kit-doc for the centred reading column (wider for an item).
  return h('div', { class: 'kit-doc cb-item-doc' }, hooks.nav ?? null, el);
}
