// list-pane-text.ts — the shared list pane's pure helpers (no browser or
// kit imports, safe under node --test): what a pane's filters and search
// put in a tab's address and in GET /api/items, and a row's two lines.

import { keyLabel } from './decide-math.ts';

/** Tone is a line's colour: the kit's ok, agent, signal, wait or muted. */
export type Tone = 'ok' | 'agent' | 'signal' | 'wait' | 'muted';

/** PaneQuery is what a pane narrows its list by: saved filters and search. */
export interface PaneQuery {
  filters: string[];
  q: string;
}

/** paneQuery reads a pane's filters (filters=a,b) and search (q=) from a hash query. */
export function paneQuery(query: string): PaneQuery {
  const p = new URLSearchParams(query);
  return {
    filters: (p.get('filters') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    q: p.get('q') ?? '',
  };
}

/** paneParams is q as GET /api/items takes it: filters joined, then q; empties left out. */
export function paneParams(q: PaneQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.filters.length) out['filters'] = q.filters.join(',');
  if (q.q) out['q'] = q.q;
  return out;
}

/**
 * withPane is a hash query with its filters= and q= replaced by q's, every
 * other parameter kept in its place (filters are joined with a raw comma, as
 * decide's address writes them).
 */
export function withPane(query: string, q: PaneQuery): string {
  const parts = query
    .split('&')
    .filter((x) => x && !/^(filters|q)(=|$)/.test(x));
  if (q.filters.length) parts.push(`filters=${q.filters.join(',')}`);
  if (q.q) parts.push(`q=${encodeURIComponent(q.q)}`);
  return parts.join('&');
}

/**
 * PaneRow is one row of a pane: its id (the selection's), its item key, its
 * title when it has one (a PR's, an issue's), and where it stands.
 */
export interface PaneRow {
  id: string;
  key: string;
  title?: string;
  stands: string;
  tone?: Tone;
  selectable?: boolean;
}

/**
 * paneLines is a row's two lines and its hover: a worktree's label
 * (keyLabel), else the title when it has one, else the key ("branch ·
 * o/r@feat/x"); then where it stands. The hover is always the full key.
 */
export function paneLines(r: PaneRow): {
  one: string;
  two: string;
  hover: string;
} {
  if (r.key.startsWith('worktree:'))
    return { one: keyLabel(r.key), two: r.stands, hover: r.key };
  const i = r.key.indexOf(':');
  const key =
    i < 0 ? r.key : `${r.key.slice(0, i)} \u00b7 ${r.key.slice(i + 1)}`;
  return { one: r.title || key, two: r.stands, hover: r.key };
}
