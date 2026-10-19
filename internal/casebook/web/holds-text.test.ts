// holds-text.test.ts — unit tests for the item page's "where it is" and
// the decision buttons' tags.
//
// Run with: node --test holds-text.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyRow, choiceTags } from './holds-text.ts';

test('copyRow: a Mac with the branch in a worktree', () => {
  assert.deepEqual(
    copyRow({
      machine: 'work',
      path: '/r',
      tip: 'e46d896707b95e80d20b6c0d0f7e92ad2853ed96',
      worktree: '/r/.worktrees/faqux',
    }),
    ['work', '/r \u00b7 at e46d896 \u00b7 in worktree /r/.worktrees/faqux'],
  );
});

test('copyRow: checked out in the clone', () => {
  assert.deepEqual(
    copyRow({ machine: 'work', path: '/r', tip: 'e46d896', head: true }),
    ['work', '/r \u00b7 at e46d896 \u00b7 checked out in the clone'],
  );
});

test('copyRow: GitHub, with how it landed', () => {
  assert.deepEqual(copyRow({ tip: 'e46d896', landed: 'merged #107' }), [
    'GitHub',
    'at e46d896 \u00b7 landed merged #107',
  ]);
});

test('copyRow: not there', () => {
  assert.deepEqual(copyRow({ machine: 'pro-2', absent: true }), [
    'pro-2',
    'not there',
  ]);
  assert.deepEqual(copyRow({ absent: true }), ['GitHub', 'not there']);
});

test('choiceTags', () => {
  assert.deepEqual(choiceTags('pr', 'merge'), ['permanent']);
  assert.deepEqual(choiceTags('repo', 'delete'), ['permanent']);
  assert.deepEqual(choiceTags('issue', 'close'), ['github-undo']);
  assert.deepEqual(choiceTags('pr', 'close'), ['github-undo']);
  assert.deepEqual(choiceTags('repo', 'archive'), ['github-undo']);
  assert.deepEqual(choiceTags('branch', 'delete'), []);
  assert.deepEqual(choiceTags('pr', 'keep'), []);
});
