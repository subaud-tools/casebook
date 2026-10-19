// status-text.test.ts — the bar's push status (Court, 2026-10-18: it said
// "offline" while a big accept's decisions only waited for the push).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushStatus } from './status-text.ts';

test('waiting to be pushed is "saving", quiet', () => {
  assert.deepEqual(pushStatus({ queued: 33, offline: false, error: '' }), {
    text: 'saving 33',
    tone: 'muted',
  });
});
test('a push that could not reach the remote is "offline"', () => {
  assert.deepEqual(pushStatus({ queued: 3, offline: true, error: '' }), {
    text: 'offline \u00b7 3 queued',
    tone: 'danger',
  });
});
test('a push the remote refused is "push failed"', () => {
  assert.deepEqual(
    pushStatus({ queued: 3, offline: false, error: 'refused' }),
    {
      text: 'push failed \u00b7 3 queued',
      tone: 'danger',
    },
  );
});
test('nothing queued says nothing', () => {
  assert.equal(pushStatus({ queued: 0, offline: true, error: '' }), null);
});
