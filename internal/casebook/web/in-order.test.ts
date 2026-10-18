// in-order.test.ts — the dock's "attached" reports reach serve in the order
// they were made (review 2026-10-18: a slow A, then B, could record A last).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestInOrder } from './in-order.ts';

test('a later value is sent only after the one in flight, and the last one wins', async () => {
  const sent: string[] = [];
  const pending: Array<() => void> = [];
  const send = latestInOrder((v: string) => {
    sent.push(`start ${v}`);
    return new Promise<void>((r) =>
      pending.push(() => {
        sent.push(`end ${v}`);
        r();
      }),
    );
  });
  send('A');
  send('B');
  send('');
  assert.deepEqual(sent, ['start A']);
  pending.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
  // B was superseded by "" before its turn: only the latest goes.
  assert.deepEqual(sent, ['start A', 'end A', 'start ']);
  pending.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ['start A', 'end A', 'start ', 'end ']);
});

test('a failed send does not stop the next', async () => {
  const sent: string[] = [];
  const send = latestInOrder((v: string) => {
    sent.push(v);
    return v === 'A' ? Promise.reject(new Error('down')) : Promise.resolve();
  });
  send('A');
  send('B');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ['A', 'B']);
});
