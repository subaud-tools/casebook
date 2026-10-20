// decide-math.ts — pure decision-vocabulary helpers with no browser or kit
// imports.  This module is safe to import in node --test unit tests.
//
// These functions are the selection math the decide sheet uses:
//   kindFromKey   — extract the kind prefix from a casebook key
//   allowedForKind — look up allowed dispositions for one kind from server vocab
//   allowedForKeys — intersect allowed sets for a mixed-kind selection

import type {
  WaitingVocab,
  ChoiceVocab,
  CountWords,
  DecisionVocabView,
  GroupView,
  ItemView,
  LookIntoVocab,
  NotNowForm,
  RuleRow,
} from './wire.d.ts';
import { lookingLine, sessionName } from './sessions.ts';
import type { Tone } from './list-pane-text.ts';

/**
 * kindFromKey extracts the kind from a key by taking the prefix before the
 * first colon.  "pr:schuettc/hail#3" → "pr".
 */
export function kindFromKey(key: string): string {
  const i = key.indexOf(':');
  return i > 0 ? key.slice(0, i) : '';
}

/**
 * allowedForKind returns the valid dispositions for one item kind from the
 * server's vocabulary.  Falls back to an empty array for unknown kinds.
 */
export function allowedForKind(
  vocab: DecisionVocabView,
  kind: string,
): string[] {
  return (vocab.kinds ?? []).find((k) => k.kind === kind)?.allowed ?? [];
}

/**
 * keyWithoutKind strips the kind prefix from a casebook key, leaving only the
 * identifier part suitable for display beside a kind label.
 * "issue:schuettc/hail#4" → "schuettc/hail#4".
 * Returns the full key unchanged when there is no colon.
 */
export function keyWithoutKind(key: string): string {
  const i = key.indexOf(':');
  return i > 0 ? key.slice(i + 1) : key;
}

/**
 * keyLabel is a key as every page names it beside its kind: a worktree
 * ("worktree:<machine>:<path>") in a ".worktrees" or ".claude/worktrees"
 * folder is "<the folder above it> · <the path from that folder on>"
 * ("oss-ml-optimizer · .worktrees/fast-defaults"), wherever its clone is;
 * any other worktree is its path's last two segments ("scratch · hail-fix").
 * Any other key is the key without its kind. The full key goes in the hover.
 */
export function keyLabel(key: string): string {
  if (!key.startsWith('worktree:')) return keyWithoutKind(key);
  const rest = key.slice('worktree:'.length);
  const path = rest.slice(rest.indexOf(':') + 1).replace(/\/+$/, '');
  for (const dir of ['/.claude/worktrees/', '/.worktrees/']) {
    const at = path.indexOf(dir);
    if (at > 0) {
      const above = path.slice(0, at);
      const name = above.slice(above.lastIndexOf('/') + 1);
      return `${name} \u00b7 ${path.slice(at + 1)}`;
    }
  }
  return path.split('/').filter(Boolean).slice(-2).join(' \u00b7 ');
}

/**
 * allowedForKeys returns the intersection of allowed dispositions for every
 * key in the slice, derived from each key's kind prefix.  This is the correct
 * way to compute allowed for a selection: it works for keys on unrendered
 * pages (where no ItemView is available) as well as rendered ones.
 */
export function allowedForKeys(
  vocab: DecisionVocabView,
  keys: string[],
): string[] {
  if (keys.length === 0) return [];
  const kinds = [...new Set(keys.map(kindFromKey).filter(Boolean))];
  if (kinds.length === 0) return [];
  const sets = kinds.map((k) => new Set(allowedForKind(vocab, k)));
  const first = [...(sets[0] ?? new Set())];
  return first.filter((d) => sets.every((s) => s.has(d)));
}

// ---- pluralize helper ------------------------------------------------------

/**
 * pluralize returns "N singular" or "N plural" depending on n.
 * If plural is omitted, it defaults to singular + "s".
 *
 * pluralize(1, 'item')  → '1 item'
 * pluralize(2, 'item')  → '2 items'
 * pluralize(0, 'item')  → '0 items'
 */
export function pluralize(
  n: number,
  singular: string,
  plural?: string,
): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`;
}

// ---- history display helpers ------------------------------------------------

/**
 * stripOwnKey removes the item's own key from a history entry subject line,
 * in display only.
 * e.g. "decide pr:schuettc/hail#3 → close by schuettc"
 *   → "decide → close by schuettc"
 *
 * Only the exact key (and any immediately trailing space) is removed.
 * Entries that mention a different key are left unchanged.
 */
export function stripOwnKey(subject: string, key: string): string {
  if (!key) return subject;
  const withSpace = key + ' ';
  if (subject.includes(withSpace)) {
    return subject.replace(withSpace, '');
  }
  if (subject.includes(key)) {
    return subject.replace(key, '');
  }
  return subject;
}

// ---- the decide step ---------------------------------------------------------

/**
 * nextInView is the item to open after current is decided: the first key
 * after current in order (the view's rows as the page had them, every page
 * it loaded) that is still in the view, then the view's rows past the last
 * of those, then (wrapping) the view's first row. fresh is the view as serve
 * lists it after the decision, in its order, as far as it has been fetched;
 * complete says it holds the whole view. An item decided elsewhere meanwhile
 * is not in fresh and is passed over, never counted as a step. MORE when
 * the answer may be in a page of fresh not fetched yet; null when nothing is
 * left. When current is no longer in order, the search starts at order's
 * beginning.
 */
/** MORE is nextInView's answer when a page not fetched yet may hold it. */
export const MORE: unique symbol = Symbol('more');

export function nextInView(
  order: string[],
  current: string,
  fresh: string[],
  complete: boolean,
): string | null | typeof MORE {
  const live = fresh.filter((k) => k !== current);
  const inView = new Set(live);
  const pos = new Map(order.map((k, i) => [k, i]));
  // The furthest row of order fresh has reached: a row before it that isn't
  // in fresh has left the view; a row after it may be on a later page.
  let reached = -1;
  for (const k of live) reached = Math.max(reached, pos.get(k) ?? -1);
  const i = order.indexOf(current);
  for (const k of i >= 0 ? order.slice(i + 1) : order) {
    if (inView.has(k)) return k;
    if (!complete && (pos.get(k) ?? 0) > reached) return MORE;
  }
  // Past order's rows: the first row of fresh after the last one order holds.
  let last = -1;
  live.forEach((k, j) => {
    if (pos.has(k)) last = j;
  });
  const past = live.slice(last + 1).find((k) => !pos.has(k));
  if (past) return past;
  if (!complete) return MORE;
  return live[0] ?? null;
}

/** localDate is d's calendar date where the page runs, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * notNowUntil is the until condition a Not now form makes with value (what
 * the form asks for), or null while it is incomplete. A "days" form fills its
 * hole with today + the days serve sends; a fixed form (asks "") is complete
 * as it is; any other fills its hole with the trimmed value.
 */
export function notNowUntil(
  form: NotNowForm,
  value: string,
  now: Date,
): string | null {
  if (!form.asks) return form.template;
  let v = value.trim();
  if (form.asks === 'days') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + (form.days ?? 0));
    v = localDate(d);
  }
  if (!v) return null;
  return form.template.replace('%s', v);
}

/**
 * choicesForKeys is the cards a selection shares: the dispositions every
 * selected kind allows, in the first kind's order, each with serve's label
 * and sentence. When the kinds word a choice differently, their labels are
 * joined ("Leave it open / Keep it") and the first kind's sentence is kept.
 */
export function choicesForKeys(
  vocab: DecisionVocabView,
  keys: string[],
): ChoiceVocab[] {
  const kinds = [...new Set(keys.map(kindFromKey).filter(Boolean))];
  const lists = kinds.map(
    (k) => (vocab.kinds ?? []).find((v) => v.kind === k)?.choices ?? [],
  );
  if (lists.length === 0) return [];
  const out: ChoiceVocab[] = [];
  for (const first of lists[0]) {
    const same = lists.map((l) =>
      l.find((x) => x.disposition === first.disposition),
    );
    if (same.some((x) => !x)) continue;
    const labels = [...new Set(same.map((x) => x!.label))];
    out.push({
      ...first,
      label: labels.join(' / '),
      outward: same.some((x) => x!.outward),
    });
  }
  return out;
}

// The nouns the sheet counts a selection of one kind in.
const KIND_NOUN: Record<string, [string, string]> = {
  pr: ['pull request', 'pull requests'],
  issue: ['issue', 'issues'],
  branch: ['branch', 'branches'],
  worktree: ['worktree', 'worktrees'],
  repo: ['repository', 'repositories'],
};

/**
 * fillLabel is the decide sheet's fill button: the choice and how many it
 * covers, in the kind's noun when the selection is one kind
 * ("Close it · 4 issues"), else in items.
 */
export function fillLabel(label: string, keys: string[]): string {
  const kinds = [...new Set(keys.map(kindFromKey))];
  const noun = kinds.length === 1 ? KIND_NOUN[kinds[0]] : undefined;
  const count = noun
    ? pluralize(keys.length, noun[0], noun[1])
    : pluralize(keys.length, 'item');
  return `${label} \u00b7 ${count}`;
}

// ---- recommendations in the list --------------------------------------------

/**
 * agentFromSource is the name a proposal's source shows as: "pi:session-id"
 * → "pi", "rule:id" → "rule".
 */
export function agentFromSource(source: string): string {
  const i = source.indexOf(':');
  return i === -1 ? source : source.slice(0, i);
}

/**
 * choiceLabel is serve's label for disposition on key's kind ("Close it");
 * watch reads as Not now. The disposition itself before the vocabulary has
 * loaded, or when serve has no card for it.
 */
export function choiceLabel(
  vocab: DecisionVocabView | null,
  key: string,
  disposition: string,
): string {
  const d = disposition === 'watch' ? 'wait' : disposition;
  if (!vocab) return disposition;
  return (
    choicesForKeys(vocab, [key]).find((c) => c.disposition === d)?.label ??
    disposition
  );
}

/**
 * recommendLine is the line for an item's pending proposal, in serve's
 * words: who recommends (recommendsWho), then the choice ("agent recommends
 * Close it", "Stale questions recommends Close it").
 */
export function recommendLine(
  vocab: DecisionVocabView,
  key: string,
  source: string,
  disposition: string,
  ruleName = '',
): string {
  const who = recommendsWho(vocab, source, ruleName);
  return `${who} ${choiceLabel(vocab, key, disposition)}`;
}

/**
 * recommendsWho is who recommends, in serve's words: a rule by its name
 * (ruleName, else its id), an agent as "agent", never its session's name.
 */
export function recommendsWho(
  vocab: Pick<DecisionVocabView, 'recommends' | 'rule_recommends'>,
  source: string,
  ruleName = '',
): string {
  if (source.startsWith('rule:'))
    return vocab.rule_recommends.replaceAll(
      '{rule}',
      ruleName || source.slice(5),
    );
  return vocab.recommends;
}

/** CAME_BACK is the id of decide's "Came back" group (serve's). */
export const CAME_BACK = 'came-back';

/**
 * standsLine is a decide row's second line, where the item stands, the
 * first that applies: a session looking into it (agent); why it came back,
 * or its new activity (signal); its recommendation (muted). Grouped, the
 * head names the choice and the row gives its reason; flat, the row names
 * both ("delete it · landed"). A left-open row says when it was left open.
 */
export function standsLine(
  vocab: DecisionVocabView | null,
  it: ItemView,
  flat: boolean,
): { text: string; tone: Tone } {
  const looking = lookingLine(it.looking);
  if (looking) return { text: looking, tone: 'agent' };
  if (it.status === 'left-open')
    return { text: leftOpenMeta(it.decision?.decided_at), tone: 'muted' };
  const back =
    it.group === CAME_BACK
      ? it.due_reason || vocab?.came_back?.[it.status]
      : it.new_activity
        ? it.due_reason
        : '';
  if (back) return { text: back, tone: 'signal' };
  const p = it.proposal?.state === 'pending' ? it.proposal : undefined;
  if (!p) return { text: 'not recommended yet', tone: 'muted' };
  const label = choiceLabel(vocab, it.key, p.disposition);
  const text = flat
    ? [label, p.note].filter(Boolean).join(' \u00b7 ')
    : p.note || label;
  return { text, tone: 'muted' };
}

/**
 * decideSummary is the middle pane's summary with nothing open, one line
 * each (serve's words): how many to decide, how many came back, what each
 * rule (by its name) and agent recommends and for how many, and how many
 * are not recommended yet. A line with nothing to count is left out.
 */
export function decideSummary(
  groups: GroupView[],
  total: number,
  rules: RuleRow[],
  vocab: DecisionVocabView,
): string[] {
  const w = vocab.summary;
  const n = (t: string, k: number) => t.replaceAll('{n}', String(k));
  const lines = [n(w.to_decide, total)];
  const back = groups.find((g) => g.id === CAME_BACK);
  if (back?.total) lines.push(n(w.came_back, back.total));
  for (const g of groups) {
    if (!g.source || !g.total) continue;
    const rule = g.source.startsWith('rule:') ? g.source.slice(5) : '';
    const who = rule
      ? rules.find((r) => r.rule.id === rule)?.rule.name || rule
      : sessionName(g.by, g.source);
    lines.push(
      n(w.group, g.total)
        .replaceAll('{who}', who)
        .replaceAll('{decision}', g.label),
    );
  }
  const none = groups.find((g) => g.id === 'none');
  if (none?.total) lines.push(n(w.not_recommended, none.total));
  return lines;
}

// ---- the groups of decide's list --------------------------------------------

/**
 * countWord is the word for a group button's {n} (serve's count_words, the
 * rule serve's CountWord states): the ticked items when some of the group's
 * total are ticked ("3"), otherwise the whole group ("it", "both", "all
 * 27"). Ticking every item counts as the whole group.
 */
export function countWord(
  total: number,
  ticked: number,
  words: CountWords,
): string {
  if (ticked > 0 && ticked < total)
    return words.some.replaceAll('{n}', String(ticked));
  if (total === 1) return words.one;
  if (total === 2) return words.two;
  return words.all.replaceAll('{n}', String(total));
}

/**
 * lookIntoCard is the open item's "Look into it" card, in serve's words
 * (the vocabulary's look_into): its label, its sentence with the session
 * named, and the message it sends about key.
 */
export function lookIntoCard(
  words: LookIntoVocab,
  session: string,
  key: string,
): { label: string; says: string; message: string } {
  return {
    label: words.label,
    says: words.says.replaceAll('{session}', session),
    message: words.message.replaceAll('{key}', key),
  };
}

/**
 * discardConfirm is the confirm Discard opens for n recommendations in
 * view, in serve's words: discarding withdraws them, with no judgement;
 * the items go back to the agent.
 */
export function discardConfirm(
  vocab: Pick<
    DecisionVocabView,
    'discard_confirm' | 'discard_one' | 'discard_some'
  >,
  n: number,
  view: string,
): string {
  const count =
    n === 1
      ? vocab.discard_one
      : vocab.discard_some.replaceAll('{n}', String(n));
  return vocab.discard_confirm
    .replaceAll('{count}', count)
    .replaceAll('{view}', view);
}

// The kinds each Not now form that names something searches and accepts.
export const PICK_KINDS: Record<string, string[]> = {
  pr: ['pr'],
  'pr-or-issue': ['pr', 'issue'],
  repo: ['repo'],
};

const NAME = '[\\w.-]+';
const GH_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${NAME})/(${NAME})(?:/(pull|issues)/(\\d+))?(?:[/?#].*)?$`,
  'i',
);
const KIND_KEY = new RegExp(`^(pr|issue):(${NAME})/(${NAME})#(\\d+)$`, 'i');
const REPO_KEY = new RegExp(`^(?:repo:)?(${NAME})/(${NAME})$`, 'i');
const BARE_KEY = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);

/**
 * pastedKeys turns a pasted GitHub URL (…/pull/58, …/issues/58, a repo's
 * page) or a key (pr:owner/repo#58, owner/repo#58, repo:owner/repo,
 * owner/repo) into the keys it names that the form asks for (PICK_KINDS):
 * one, or two for owner/repo#58 under "pr-or-issue" (it may be either).
 * Owner and repo are lower-cased, as casebook's keys are. Anything else (a
 * title, a number, a URL of another kind) is null.
 */
export function pastedKeys(text: string, asks: string): string[] | null {
  const kinds = PICK_KINDS[asks] ?? [];
  const s = text.trim();
  const repo = (o: string, r: string): string =>
    `${o}/${r.replace(/\.git$/i, '')}`.toLowerCase();
  const num = (n: string): number | null => (Number(n) > 0 ? Number(n) : null);
  const url = GH_URL.exec(s);
  const kindKey = KIND_KEY.exec(s);
  const repoKey = REPO_KEY.exec(s);
  const bare = BARE_KEY.exec(s);
  let out: string[] = [];
  if (url) {
    const [, o, r, part, n] = url;
    if (!part) out = [`repo:${repo(o, r)}`];
    else if (num(n) !== null)
      out = [`${part === 'pull' ? 'pr' : 'issue'}:${repo(o, r)}#${num(n)}`];
  } else if (kindKey) {
    const [, k, o, r, n] = kindKey;
    if (num(n) !== null) out = [`${k.toLowerCase()}:${repo(o, r)}#${num(n)}`];
  } else if (repoKey) {
    out = [`repo:${repo(repoKey[1], repoKey[2])}`];
  } else if (bare) {
    const [, o, r, n] = bare;
    if (num(n) !== null)
      out = ['pr', 'issue'].map((k) => `${k}:${repo(o, r)}#${num(n)}`);
  }
  out = out.filter((k) => kinds.includes(kindFromKey(k)));
  return out.length ? out : null;
}

/** A LatestSearch runs a search per input, after a pause in typing. */
export interface LatestSearch {
  /** input is the field's text changing. */
  input(text: string): void;
  /** cancel drops any search under way or waiting. */
  cancel(): void;
}

/**
 * latestSearch searches with find delay ms after the last input and
 * publishes what it found for that text. Every input makes what was shown
 * stale at once (stale) and drops any answer still to come for older text,
 * so only the answer for the newest text is ever published.
 */
export function latestSearch<T>(
  find: (text: string) => Promise<T>,
  publish: (text: string, found: T) => void,
  delay: number,
  stale: () => void,
): LatestSearch {
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (my: number, text: string): Promise<void> => {
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
    },
  };
}

// ---- the left-open group -------------------------------------------------------

/**
 * leftOpenMeta is a left-open row's meta: "left open · Oct 6", the date it
 * was left open (with its year when that isn't now's).
 */
export function leftOpenMeta(
  decidedAt: string | undefined,
  now: Date = new Date(),
): string {
  if (!decidedAt) return 'left open';
  const d = new Date(decidedAt);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `left open \u00b7 ${d.toLocaleDateString('en-US', opts)}`;
}

// ---- « ‹ › »: the open item's place in the list ----------------------------

/** NavTargets is where the open item's « ‹ › » buttons go (pos 0: the item
 * is not in the list's rows). */
export interface NavTargets {
  prev?: string;
  next?: string;
  prevGroup?: string;
  nextGroup?: string;
  pos: number;
  total: number;
  label: string;
}

/**
 * navTargets is key's place in the list: the items before and after it in
 * order (the list's loaded rows in group order, a collapsed group's rows
 * included), the first items of the groups before and after its own, its
 * 1-based position in its group and the group's total and label (serve's,
 * every page).
 */
export function navTargets(
  order: { key: string; group: string }[],
  groups: GroupView[],
  key: string,
): NavTargets {
  const i = order.findIndex((r) => r.key === key);
  if (i < 0) return { pos: 0, total: 0, label: '' };
  const group = order[i].group;
  // The first row of each group, in order.
  const firsts: { group: string; at: number }[] = [];
  order.forEach((r, j) => {
    if (j === 0 || order[j - 1].group !== r.group)
      firsts.push({ group: r.group, at: j });
  });
  const g = firsts.findIndex((f) => f.group === group && f.at <= i);
  const start = firsts[g].at;
  const gv = groups.find((x) => x.id === group);
  const out: NavTargets = {
    pos: i - start + 1,
    total: gv?.total ?? order.filter((r) => r.group === group).length,
    label: gv?.label ?? '',
  };
  if (i > 0) out.prev = order[i - 1].key;
  if (i + 1 < order.length) out.next = order[i + 1].key;
  if (g > 0) out.prevGroup = order[firsts[g - 1].at].key;
  if (g + 1 < firsts.length) out.nextGroup = order[firsts[g + 1].at].key;
  return out;
}

/**
 * shortKey is a key as a nav button's tooltip names it: without its kind
 * and owner. "pr:o/nfl-dk#467" → "nfl-dk#467".
 */
export function shortKey(key: string): string {
  const k = keyWithoutKind(key);
  const i = k.indexOf('/');
  return i >= 0 ? k.slice(i + 1) : k;
}

/** The pending recommendation a decision button is pressed against. */
export interface PendingRec {
  id: number;
  disposition: string;
  until?: string;
}

/**
 * decideRoute is where a decision button posts: the recommended choice
 * (with the recommendation's until, for Not now) accepts the
 * recommendation; any other settles it as decided differently (change);
 * with no recommendation, a plain decide.
 */
export function decideRoute(
  pending: PendingRec | null,
  d: string,
  until?: string,
): { path: 'accept' | 'change'; id: number } | { path: 'decide' } {
  if (!pending) return { path: 'decide' };
  const same =
    pending.disposition === d && (until ?? '') === (pending.until ?? '');
  return { path: same ? 'accept' : 'change', id: pending.id };
}

/**
 * doneWords is what a decision did, in serve's words: one item's choice
 * (by its key's kind) says done ("Closed it"); a group's (by its label)
 * says done_many with the count word ("Deleted all 3").
 */
export function doneWords(
  vocab: Pick<DecisionVocabView, 'kinds' | 'count_words'>,
  d: string,
  of: { key: string } | { label: string; total: number; ticked: number },
): string {
  if ('key' in of) {
    const kind = kindFromKey(of.key);
    const c = (vocab.kinds ?? [])
      .find((k) => k.kind === kind)
      ?.choices?.find((c) => c.disposition === d);
    return c?.done ?? '';
  }
  for (const k of vocab.kinds ?? [])
    for (const c of k.choices ?? [])
      if (c.disposition === d && c.label === of.label)
        return c.done_many.replaceAll(
          '{n}',
          countWord(of.total, of.ticked, vocab.count_words),
        );
  return '';
}

/** A piece of the waiting strip: text, the link to apply, or undo. */
export type StripPart = string | { link: string } | { button: string };

/**
 * waitingStrip splits serve's strip sentence ("{done} · waiting in {apply}
 * · {undo}") into its text, the apply link and the undo button.
 */
export function waitingStrip(w: WaitingVocab, done: string): StripPart[] {
  const parts: StripPart[] = [];
  for (const piece of w.text.split(/(\{apply\}|\{undo\})/)) {
    if (piece === '{apply}') parts.push({ link: w.apply });
    else if (piece === '{undo}') parts.push({ button: w.undo });
    else if (piece) parts.push(piece.replaceAll('{done}', done));
  }
  return parts;
}

/**
 * applyGroupLink is the review group a decision of key went to:
 * "#/review?group=<disposition>|<kind>", serve's to-apply group id.
 */
export function applyGroupLink(disposition: string, key: string): string {
  const kind = key.slice(0, key.indexOf(':'));
  return `#/review?group=${encodeURIComponent(`${disposition}|${kind}`)}`;
}

// ---- ticked items -------------------------------------------------------------

/**
 * splitTicked splits ticked items for a decision: the pending
 * recommendations of exactly it are accepted (their ids), every other item
 * is decided (its key).
 */
export function splitTicked(
  items: ItemView[],
  disposition: string,
  until = '',
): { accept: number[]; decide: string[] } {
  const out = { accept: [] as number[], decide: [] as string[] };
  for (const it of items) {
    const p = it.proposal;
    if (
      p?.state === 'pending' &&
      p.disposition === disposition &&
      (p.until ?? '') === until
    )
      out.accept.push(p.id);
    else out.decide.push(it.key);
  }
  return out;
}

/**
 * tickedWords is the middle pane's lines for ticked items: where they are
 * ticked ("decide · 2 ticked in Landed branches"), what they are ("2
 * branches"; "3 items" of several kinds), and the recommendation they share
 * ("Landed branches recommends delete it for both"), if they share one.
 */
export function tickedWords(
  vocab: DecisionVocabView,
  items: ItemView[],
  groupLabel: string,
): { kick: string; title: string; ctx: string } {
  const n = items.length;
  const kinds = [...new Set(items.map((it) => kindFromKey(it.key)))];
  const kv =
    kinds.length === 1
      ? (vocab.kinds ?? []).find((k) => k.kind === kinds[0])
      : undefined;
  const title = kv?.nouns
    ? `${n} ${n === 1 ? kv.noun : kv.nouns}`
    : pluralize(n, 'item');
  const ps = items.map((it) =>
    it.proposal?.state === 'pending' ? it.proposal : undefined,
  );
  const first = ps[0];
  const shared =
    !!first &&
    ps.every(
      (p) => p?.disposition === first.disposition && p?.source === first.source,
    );
  let ctx = 'not recommended yet';
  if (shared && first) {
    const all = n === 1 ? 'it' : n === 2 ? 'both' : `all ${n}`;
    ctx = `${recommendsWho(vocab, first.source, groupLabel)} ${choiceLabel(vocab, items[0].key, first.disposition)} for ${all}`;
  } else if (ps.some(Boolean)) ctx = 'their recommendations differ';
  return {
    kick: `decide \u00b7 ${n} ticked in ${groupLabel}`,
    title,
    ctx,
  };
}
