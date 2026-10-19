// decide.ts — the decision vocabulary, and the middle pane for ticked items.
//
// The server is the single source of truth for the decision vocabulary
// (which dispositions are valid per kind, which need an `until` condition,
// and the supported `until` forms).  GET /api/decisions/vocabulary is fetched
// once and cached.
//
// Exported pure functions (no server calls):
//   kindFromKey(key)               — "pr:owner/repo#1" → "pr"
//   allowedForKind(vocab, kind)    — allowed dispositions for one kind
//   allowedForKeys(vocab, keys)    — intersection for a mixed-kind selection
//
// renderTicked draws ticked items in the middle pane with the decision
// buttons for all of them.

import { h } from '/_kit/kit.js';
import type { DecisionVocabView, ItemView } from './wire.d.ts';
import type { Ctx } from './app.ts';
import { kindFromKey, allowedForKind, allowedForKeys } from './decide-math.ts';
import { renderChoices } from './choices.ts';
import { midHead, midRows } from './mid.ts';

// Re-export the pure functions so callers only need one import.
export { kindFromKey, allowedForKind, allowedForKeys };

// ---- module-level vocab cache -----------------------------------------------

let _vocab: DecisionVocabView | null = null;

/** getVocab fetches and caches the decision vocabulary from the server.
 *  Call it from any module that needs the vocab (cached after first call). */
export async function getVocab(ctx: Ctx): Promise<DecisionVocabView> {
  if (_vocab !== null) return _vocab;
  _vocab = await ctx.api.get<DecisionVocabView>('/decisions/vocabulary');
  return _vocab;
}

// Dispositions that are destructive (rendered with danger styling by Rules
// and To apply). The decide step's cards draw only delete in danger.
export const DANGER_DISPS = new Set(['close', 'delete', 'archive']);

// ---- renderTicked -------------------------------------------------------------

/**
 * renderTicked is the middle pane for ticked items: its fixed lines (where
 * they are ticked, what they are, the recommendation they share), the
 * decision buttons for all of them (the shared recommendation chosen),
 * then extra (ask, discard), and a row for each item. Nothing is decided
 * until a button is pressed: onDecide.
 */
export function renderTicked(
  ctx: Ctx,
  items: ItemView[],
  words: { kick: string; title: string; ctx: string },
  onDecide: (d: string, until?: string) => Promise<void>,
  extra: HTMLElement[],
): HTMLElement {
  const keys = items.map((it) => it.key);
  const kinds = [...new Set(keys.map(kindFromKey))];
  const recs = items.map((it) =>
    it.proposal?.state === 'pending' ? it.proposal.disposition : '',
  );
  const common = recs.every((r) => r && r === recs[0]) ? recs[0] : undefined;
  const choices = renderChoices(ctx, kinds[0] ?? '', {
    keys,
    recommended: common,
    chosen: common,
    onPick(d, until) {
      void onDecide(d, until);
    },
  });
  // The buttons sit on the buttons' line; Not now's picker and an error
  // stay under it.
  const grid = choices.querySelector<HTMLElement>('.cb-choices');
  const shown = items.slice(0, TICKED_ROWS);
  return h(
    'div',
    { class: 'kit-doc' },
    h(
      'article',
      { class: 'cb-apply-doc cb-ticked', 'data-testid': 'ticked' },
      ...midHead({
        ...words,
        acts: [...(grid ? [grid] : []), ...extra],
      }),
      choices,
      midRows(
        shown.map((it) => {
          const p = it.proposal?.state === 'pending' ? it.proposal : undefined;
          return {
            key: it.key,
            stands: p?.note || 'not recommended yet',
            tone: 'muted' as const,
          };
        }),
        items.length - shown.length,
      ),
    ),
  );
}

// TICKED_ROWS is how many ticked items the middle pane lists by name.
const TICKED_ROWS = 20;
