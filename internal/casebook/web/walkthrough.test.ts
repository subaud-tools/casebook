// walkthrough.test.ts — the first-run walkthrough's steps and where its
// note goes.
//
// Run with: node --test walkthrough.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALKTHROUGH_SEEN,
  WALKTHROUGH_STEPS,
  placeNote,
} from './walkthrough.ts';

describe('WALKTHROUGH_STEPS', () => {
  test('in the order casebook is used, each with a note', () => {
    assert.deepEqual(
      WALKTHROUGH_STEPS.map((s) => s.id),
      ['decide', 'filters', 'rules', 'decision', 'review', 'agent'],
    );
    for (const s of WALKTHROUGH_STEPS) {
      assert.ok(s.note.trim().length > 0, `${s.id} has a note`);
      assert.ok(s.target.trim().length > 0, `${s.id} has a target`);
    }
  });
  test('the notes say "agent", never a session, and no decision words', () => {
    const agent = WALKTHROUGH_STEPS.find((s) => s.id === 'agent');
    assert.match(agent?.note ?? '', /\bagent\b/);
    for (const s of WALKTHROUGH_STEPS) {
      assert.doesNotMatch(s.note, /\b(accept|reject|session)\b/i, s.id);
    }
  });
  test('review says what runs it, and that run exists', () => {
    const review = WALKTHROUGH_STEPS.find((s) => s.id === 'review');
    assert.equal(review?.target, '.kit-ctl[data-id="review"]');
    assert.match(review?.note ?? '', /\brun\b/);
  });
  test('the flag is kept under casebook.walkthrough', () => {
    assert.equal(WALKTHROUGH_SEEN, 'casebook.walkthrough');
  });
});

const view = { width: 1600, height: 900 };
const card = { width: 320, height: 140 };
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe('placeNote', () => {
  test('below a control in the bar, inside the window', () => {
    const t = { x: 200, y: 10, width: 80, height: 30 };
    const p = placeNote(t, card, view);
    assert.ok(p.y >= t.y + t.height, 'below');
    assert.ok(!overlaps({ ...p, ...card }, t));
  });
  test('left of the full-height rail at the right edge', () => {
    const t = { x: 1240, y: 52, width: 360, height: 848 };
    const p = placeNote(t, card, view);
    assert.ok(p.x + card.width <= t.x, 'left of it');
    assert.ok(!overlaps({ ...p, ...card }, t));
  });
  test('above a control at the bottom', () => {
    const t = { x: 600, y: 820, width: 100, height: 30 };
    const p = placeNote(t, card, view);
    assert.ok(p.y + card.height <= t.y, 'above');
  });
  test('always inside the window', () => {
    for (const t of [
      { x: 0, y: 60, width: 40, height: 20 },
      { x: 1590, y: 60, width: 10, height: 20 },
      { x: 700, y: 400, width: 200, height: 100 },
    ]) {
      const p = placeNote(t, card, view);
      assert.ok(p.x >= 0 && p.x + card.width <= view.width, `x ${p.x}`);
      assert.ok(p.y >= 0 && p.y + card.height <= view.height, `y ${p.y}`);
      assert.ok(!overlaps({ ...p, ...card }, t), JSON.stringify(t));
    }
  });
});
