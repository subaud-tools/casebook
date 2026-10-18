// proposals.ts — discarding recommendations. (A recommendation is accepted
// or decided differently by the item's decision buttons: decide-list.ts.)
//
// Exported:
//   agentFromSource(source)            — "pi:session-id" → "pi"
//   openDiscardSheet(ctx, vocab, n, view, body, onDone) — confirm + POST /proposals/withdraw

import { sheet, h } from '/_kit/kit.js';
import type { DecisionVocabView, WithdrawResult } from './wire.d.ts';
import type { Ctx } from './app.ts';
import { agentFromSource, discardConfirm } from './decide-math.ts';

// agentFromSource ("pi:session-id" → "pi") lives with the pure helpers.
export { agentFromSource };

// ---- discard recommendations ------------------------------------------------

/**
 * openDiscardSheet confirms discarding n agent recommendations in view (the
 * kit's sheet in serve's words: "Discard n recommendations in ‹view›? …",
 * discard and cancel); discard POSTs body ({ids}, or the view and its filters, with a
 * group or without) to /proposals/withdraw and calls onDone with how many
 * were withdrawn. It decides and rejects nothing: the items go back to the
 * agent.
 */
export function openDiscardSheet(
  ctx: Ctx,
  vocab: DecisionVocabView,
  n: number,
  view: string,
  body: Record<string, unknown>,
  onDone: (withdrawn: number) => void,
): void {
  let submitting = false;
  let sh: ReturnType<typeof sheet> | null = null;
  const errEl = h('p', { class: 'cb-sheet-err' });
  errEl.hidden = true;
  async function doDiscard(): Promise<void> {
    if (submitting) return;
    submitting = true;
    errEl.hidden = true;
    try {
      const r = await ctx.api.post<WithdrawResult>('/proposals/withdraw', body);
      sh?.close();
      onDone(r.withdrawn);
    } catch (err) {
      errEl.textContent =
        err instanceof Error ? err.message : 'discard failed, try again';
      errEl.hidden = false;
      submitting = false;
    }
  }

  sh = sheet({
    title: vocab.discard_title,
    body: h(
      'div',
      { class: 'cb-sheet-body cb-discard-confirm' },
      h('p', { class: 'cb-discard-says' }, discardConfirm(vocab, n, view)),
      errEl,
    ),
    actions: [
      {
        label: vocab.discard_button,
        fill: true,
        run() {
          void doDiscard();
        },
      },
      {
        label: vocab.discard_cancel,
        run() {
          sh?.close();
        },
      },
    ],
    onClose() {
      sh = null;
    },
  });
}
