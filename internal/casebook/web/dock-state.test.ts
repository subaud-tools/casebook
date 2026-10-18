// dock-state.test.ts — when the agent pane is open and when it is a strip.
//
// Run with: node --test dock-state.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dockOpen } from './dock-state.ts';

describe('dockOpen', () => {
  test('no conversation, nothing asked: a strip', () => {
    assert.equal(dockOpen(false, false, null), false);
  });
  test('a conversation opens it', () => {
    assert.equal(dockOpen(true, false, null), true);
  });
  test('a click wins over the conversation, either way', () => {
    assert.equal(dockOpen(true, false, false), false);
    assert.equal(dockOpen(false, false, true), true);
  });
  test('a focused composer is never hidden', () => {
    assert.equal(dockOpen(false, true, false), true);
  });
});
