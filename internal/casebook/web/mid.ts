// mid.ts — the middle pane's fixed lines for what is ticked (and review's
// plan, and a run item): the small line, the title, the context line and
// the buttons, each one line at one height, then the rows, two lines each
// (the key, then where it stands). Anything longer ends in "…", whole on
// hover.

import { h } from '/_kit/kit.js';
import { keyWithoutKind } from './decide-math.ts';
import type { Tone } from './list-pane-text.ts';

export function midHead(o: {
  kick: string;
  title: string;
  ctx: string;
  acts: HTMLElement[];
}): HTMLElement[] {
  return [
    h('p', { class: 'cb-mid-kick', title: o.kick }, o.kick),
    h('h1', { class: 'cb-mid-title', title: o.title }, o.title),
    h('p', { class: 'cb-mid-ctx', title: o.ctx }, o.ctx),
    h('div', { class: 'cb-mid-acts' }, ...o.acts),
  ];
}

export function midRows(
  rows: { key: string; stands: string; tone?: Tone }[],
  more: number,
): HTMLElement {
  return h(
    'div',
    { class: 'cb-mid-rows' },
    ...rows.map((r) =>
      h(
        'div',
        { class: 'cb-mid-row', 'data-key': r.key },
        h('div', { class: 'cb-mid-k', title: r.key }, keyWithoutKind(r.key)),
        h(
          'div',
          { class: `cb-mid-st cb-tone-${r.tone ?? 'muted'}`, title: r.stands },
          r.stands,
        ),
      ),
    ),
    more > 0
      ? h('div', { class: 'cb-mid-row cb-mid-more' }, `\u2026 ${more} more`)
      : null,
  );
}
