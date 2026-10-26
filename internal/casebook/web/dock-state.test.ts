// dock-state.test.ts — when the agent pane is open and when it is a strip.
//
// Run with: node --test dock-state.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dockOpen, messageLine, pillState } from './dock-state.ts';

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

describe('pillState', () => {
  test("each of msgstate's states has a pill", () => {
    for (const st of [
      'sent',
      'with_agent',
      'working',
      'answered',
      'declined',
      'failed',
      'no_reply',
    ] as const)
      assert.equal(pillState(st), st);
  });
  test('a draft, a reply and a worked row have none', () => {
    assert.equal(pillState('draft'), null);
    assert.equal(pillState('reply'), null);
    assert.equal(pillState('worked'), null);
  });
});

describe('messageLine', () => {
  const MID = 'the agent is mid-turn; it reads this when the turn ends';
  const inflight = { id: 4, held: false };
  test("working shows the agent's line", () => {
    assert.equal(
      messageLine({ state: 'working', line: 'checking CI' }, true, null),
      'checking CI',
    );
  });
  test('sent, its session gone: no session has it', () => {
    assert.equal(
      messageLine({ state: 'sent', delivery_id: 4 }, false, inflight),
      'no session has it',
    );
    assert.equal(
      messageLine({ state: 'sent' }, false, null),
      'no session has it',
    );
  });
  test('sent in a held delivery: the agent is mid-turn', () => {
    assert.equal(
      messageLine({ state: 'sent', delivery_id: 4 }, true, {
        id: 4,
        held: true,
      }),
      MID,
    );
  });
  test('sent behind the delivery in flight: the agent is mid-turn', () => {
    assert.equal(messageLine({ state: 'sent' }, true, inflight), MID);
  });
  test('sent in a delivery not held, or with nothing in flight: no line', () => {
    assert.equal(
      messageLine({ state: 'sent', delivery_id: 4 }, true, inflight),
      '',
    );
    assert.equal(messageLine({ state: 'sent' }, true, null), '');
  });
  test('answered with attached items counts them', () => {
    assert.equal(
      messageLine(
        { state: 'answered', attached: { keys: ['a', 'b'] } },
        true,
        null,
      ),
      '2 items',
    );
    assert.equal(
      messageLine({ state: 'answered', attached: {} }, true, null),
      '',
    );
  });
  test('the other states have no line', () => {
    for (const st of ['with_agent', 'declined', 'failed', 'no_reply'] as const)
      assert.equal(messageLine({ state: st, line: 'x' }, true, inflight), '');
  });
});
