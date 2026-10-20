// list-pane-text.test.ts — the shared list pane's pure helpers.
//
// Run with: node --test list-pane-text.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paneQuery,
  paneParams,
  withPane,
  paneLines,
} from './list-pane-text.ts';

test('paneQuery reads filters and q', () =>
  assert.deepEqual(paneQuery('filters=incoming,quiet&q=ghmr&group=x'), {
    filters: ['incoming', 'quiet'],
    q: 'ghmr',
  }));

test('paneParams leaves empties out', () => {
  assert.deepEqual(paneParams({ filters: [], q: '' }), {});
  assert.deepEqual(paneParams({ filters: ['a', 'b'], q: 'x' }), {
    filters: 'a,b',
    q: 'x',
  });
});

test('withPane keeps other parameters', () =>
  assert.equal(
    withPane('group=delete|branch', { filters: ['a'], q: 'x' }),
    'group=delete|branch&filters=a&q=x',
  ));

test('withPane drops an empty search and filters', () =>
  assert.equal(
    withPane('filters=a&q=x&group=g', { filters: [], q: '' }),
    'group=g',
  ));

test('paneRowShowsTheTitleWhenThereIsOne', () => {
  assert.deepEqual(
    paneLines({
      id: 'pr:o/r#463',
      key: 'pr:o/r#463',
      title: 'chore(deps): bump constructs',
      stands: 'close it',
    }),
    {
      one: 'chore(deps): bump constructs',
      two: 'close it',
      hover: 'pr:o/r#463',
    },
  );
  assert.deepEqual(
    paneLines({
      id: 'branch:o/r@feat/x',
      key: 'branch:o/r@feat/x',
      stands: 'delete it',
    }),
    {
      one: 'branch \u00b7 o/r@feat/x',
      two: 'delete it',
      hover: 'branch:o/r@feat/x',
    },
  );
});

test('paneRowNamesAWorktreeByItsLabel', () =>
  assert.deepEqual(
    paneLines({
      id: 'worktree:work:/Users/c/GitHub/ext/oss-ml-optimizer/.worktrees/fast-defaults',
      key: 'worktree:work:/Users/c/GitHub/ext/oss-ml-optimizer/.worktrees/fast-defaults',
      title: 'fast-defaults',
      stands: 'remove it',
    }),
    {
      one: 'oss-ml-optimizer \u00b7 .worktrees/fast-defaults',
      two: 'remove it',
      hover:
        'worktree:work:/Users/c/GitHub/ext/oss-ml-optimizer/.worktrees/fast-defaults',
    },
  ));
