// holds-text.ts — the item page's words for where a branch is and what a
// decision can't undo, as pure functions (no kit or browser imports, so
// node --test can load it).

import type { Copy } from './wire.d.ts';
import type { TagKind } from './apply-text.ts';

/** copyRow is one line of "where it is": a Mac with its clone, commit and
 * worktree, or GitHub with its commit and how it landed, or "not there". */
export function copyRow(c: Copy): [label: string, text: string] {
  const label = c.machine || 'GitHub';
  if (c.absent) return [label, 'not there'];
  const parts: string[] = [];
  if (c.path) parts.push(c.path);
  if (c.tip) parts.push(`at ${c.tip.slice(0, 7)}`);
  if (c.worktree) parts.push(`in worktree ${c.worktree}`);
  if (c.head) parts.push('checked out in the clone');
  if (!c.machine && c.landed) parts.push(`landed ${c.landed}`);
  return [label, parts.join(' \u00b7 ')];
}

/** choiceTags: the tags a decision button carries: a deleted repo or a
 * merge can't be undone; a close or an archive is undone on GitHub. */
export function choiceTags(kind: string, disposition: string): TagKind[] {
  if (
    (kind === 'repo' && disposition === 'delete') ||
    (kind === 'pr' && disposition === 'merge')
  )
    return ['permanent'];
  if (
    ((kind === 'pr' || kind === 'issue') && disposition === 'close') ||
    (kind === 'repo' && disposition === 'archive')
  )
    return ['github-undo'];
  return [];
}
