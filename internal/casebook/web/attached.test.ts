// attached.test.ts — unit tests for the composer's attached line helpers.
//
// Run with: node --test attached.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachedLabel,
  attachedText,
  parseAttached,
  isEmpty,
  sameAttached,
} from './attached.ts';

describe('attachedLabel', () => {
  test('several keys of one kind count as that kind', () => {
    assert.equal(
      attachedLabel({
        keys: ['pr:o/r#1', 'pr:o/r#2', 'pr:o/r#3', 'pr:o/r#4'],
      }),
      '4 prs selected',
    );
  });
  test('branch pluralises as branches', () => {
    assert.equal(
      attachedLabel({ keys: ['branch:o/r@a', 'branch:o/r@b'] }),
      '2 branches selected',
    );
  });
  test('mixed kinds count as items', () => {
    assert.equal(
      attachedLabel({ keys: ['pr:o/r#1', 'issue:o/r#2'] }),
      '2 items selected',
    );
  });
  test('one key shows the key without its kind', () => {
    assert.equal(attachedLabel({ keys: ['issue:o/hail#4'] }), 'o/hail#4');
  });
  test('the open item shows without its kind', () => {
    assert.equal(attachedLabel({ open: 'pr:o/hail#4' }), 'o/hail#4');
  });
  test('rule and job', () => {
    assert.equal(
      attachedLabel({ rule: 'landed-branches' }),
      'rule landed-branches',
    );
    assert.equal(attachedLabel({ job: '3' }), 'job #3');
    assert.equal(
      attachedLabel({ job: '3' }, 'Close stale PRs'),
      'job #3 \u00b7 close stale prs',
    );
  });
  test('the narrowed list reads "list · 2 filters · rule x · search foo"', () => {
    assert.equal(
      attachedLabel({ list: { filters: ['a', 'b'], rule: 'x', q: 'foo' } }),
      'list \u00b7 2 filters \u00b7 rule x \u00b7 search foo',
    );
    assert.equal(
      attachedLabel({ list: { filters: ['a'] } }),
      'list \u00b7 1 filter',
    );
    assert.equal(
      attachedLabel({ list: { group: 'none' } }),
      'list \u00b7 group none',
    );
    assert.equal(attachedLabel({ list: {} }), 'list', 'the whole list');
    assert.ok(!isEmpty({ list: {} }));
  });
  test('nothing attached is empty', () => {
    assert.equal(attachedLabel({}), '');
    assert.ok(isEmpty({}));
    assert.ok(!isEmpty({ job: '3' }));
  });
});

describe('attachedText and parseAttached', () => {
  const cases = [
    { keys: ['pr:o/r#1', 'pr:o/r#2'] },
    { open: 'pr:o/r#4' },
    { rule: 'landed-branches' },
    { job: '3' },
    { list: { filters: ['a', 'b'], rule: 'x', q: 'foo' } },
    { list: { q: 'two words', group: 'none' } },
    { list: {} },
    {
      rule: 'x',
      list: { match: '[{"field":"kind","op":"is","value":"issue"}]', q: 'a b' },
    },
    { keys: ['pr:o/r#1', 'pr:o/r#2'], open: 'issue:o/r#9', rule: 'x' },
    {},
  ];
  for (const c of cases) {
    test(`round-trips ${JSON.stringify(c)}`, () => {
      assert.deepEqual(parseAttached(attachedText(c)), c);
    });
  }
  test('an edit that drops a key drops it from what is sent', () => {
    assert.deepEqual(parseAttached('pr:o/r#1'), { keys: ['pr:o/r#1'] });
  });
  test('job accepts a leading #', () => {
    assert.deepEqual(parseAttached('job #7'), { job: '7' });
  });
  test('words that are not keys are dropped', () => {
    assert.deepEqual(parseAttached('these pr:o/r#1, please'), {
      keys: ['pr:o/r#1'],
    });
  });
  test('an emptied line attaches nothing', () => {
    assert.deepEqual(parseAttached('   '), {});
  });
  test('sameAttached compares content', () => {
    assert.ok(sameAttached({ keys: ['a:1'] }, { keys: ['a:1'] }));
    assert.ok(!sameAttached({ keys: ['a:1'] }, { open: 'a:1' }));
  });
});

// Review 2026-10-17: a draft previewing is what the list shows, so it is
// what goes with a message.
test('a draft list reads "list · draft"', () => {
  assert.equal(
    attachedLabel({ list: { match: '[]', q: 'foo' } }),
    'list \u00b7 draft \u00b7 search foo',
  );
});
