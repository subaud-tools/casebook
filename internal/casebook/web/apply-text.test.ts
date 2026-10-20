// apply-text.test.ts — unit tests for the To apply section's words.
//
// Run with: node --test apply-text.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionTitle,
  groupSteps,
  jobLanes,
  jobTitle,
  laneLabel,
  makeSeq,
  needsLine,
  needsSession,
  nextSteps,
  openCardsByJob,
  planSummary,
  progress,
  stepMark,
  runOrder,
  runsThrough,
  applyLabel,
  startedKeys,
  ageText,
  observations,
  heldOutside,
  planTitle,
  actionTags,
  stepTags,
  tagText,
  publicLine,
  runsNow,
  reviewKick,
  reviewLine,
  untickHidden,
  stepLine,
  waitBlocks,
  heldText,
  otherHalf,
  ranLine,
  runBulk,
  tickedRunWords,
  standsStep,
  aroundSteps,
  actionVerb,
} from './apply-text.ts';
import type { ItemView, Job, JobStep, NeedsYou, Plan, Step } from './wire.d.ts';

let ids = 1;
function step(
  action: string,
  lane: string,
  state = 'pending',
  extra: Partial<JobStep> = {},
): JobStep {
  return {
    id: ids++,
    job_id: 1,
    key: `k${ids}`,
    action,
    lane,
    command: `cmd ${ids}`,
    state,
    ...extra,
  };
}
function job(state: string, steps: JobStep[]): Job {
  return {
    id: 3,
    machine: 'm',
    session: '',
    state,
    paused: false,
    created_at: '2026-09-27T00:00:00Z',
    steps,
  };
}

describe('the order', () => {
  test('approved, running and paused jobs run; done and failed are done; plans and discarded plans are not listed', () => {
    const js = [
      'planned',
      'approved',
      'running',
      'paused',
      'done',
      'failed',
      'cancelled',
    ].map((s, i) => ({ ...job(s, []), id: i + 1 }));
    const o = runOrder(js);
    assert.deepEqual(
      o.running.map((j) => j.state),
      ['paused', 'running', 'approved'],
    );
    assert.deepEqual(
      o.done.map((j) => j.state),
      ['failed', 'done'],
    );
  });
  test('each part is newest first', () => {
    const js = [1, 3, 2].map((id) => ({ ...job('running', []), id }));
    assert.deepEqual(
      runOrder(js).running.map((j) => j.id),
      [3, 2, 1],
    );
  });
});

describe('a waiting group', () => {
  test("is named by the choice's many, counting in the kind's nouns", () => {
    assert.equal(
      applyLabel('Delete {n}', 'branch', 'branches', 30),
      'Delete 30 branches',
    );
    assert.equal(
      applyLabel('Delete {n}', 'branch', 'branches', 1),
      'Delete 1 branch',
    );
    assert.equal(applyLabel('Close {n}', 'PR', 'PRs', 5), 'Close 5 PRs');
  });
});

describe('names', () => {
  test('lanes read as the mock writes them', () => {
    assert.equal(laneLabel('casebook', 'pi'), 'casebook · local');
    assert.equal(laneLabel('agent', 'pi'), 'pi · outward');
    assert.equal(laneLabel('agent', ''), 'agent · outward');
  });
  test('a group is named by its action', () => {
    assert.equal(actionTitle('branch-delete-local'), 'delete local branches');
    assert.equal(actionTitle('pr-close'), 'close PRs');
    assert.equal(actionTitle('something-new'), 'something-new');
  });
  test("a job's title is its groups, and its lanes casebook's first", () => {
    const j = job('running', [
      step('repo-archive', 'agent'),
      step('branch-delete-local', 'casebook'),
      step('repo-archive', 'agent'),
    ]);
    assert.equal(jobTitle(j), 'archive repos, delete local branches');
    assert.deepEqual(jobLanes(j), ['casebook', 'agent']);
    assert.equal(jobTitle(job('planned', [])), 'job #3');
  });
});

describe('groupSteps', () => {
  test("groups by action and lane in first-seen order, as serve's Plan.Groups", () => {
    const a = step('branch-delete-local', 'casebook');
    const b = step('pr-close', 'agent');
    const c = step('branch-delete-local', 'casebook');
    const d = step('branch-delete-remote', 'casebook');
    const g = groupSteps([a, b, c, d]);
    assert.deepEqual(
      g.map((x) => [x.action, x.lane, x.steps.map((s) => s.id)]),
      [
        ['branch-delete-local', 'casebook', [a.id, c.id]],
        ['pr-close', 'agent', [b.id]],
        ['branch-delete-remote', 'casebook', [d.id]],
      ],
    );
  });
});

describe('progress', () => {
  test('finished counts every step no lane will move again, per lane', () => {
    const p = progress(
      job('running', [
        step('a', 'casebook', 'verified'),
        step('a', 'casebook', 'skipped'),
        step('b', 'agent', 'reported'),
        step('b', 'agent', 'paused'),
        step('b', 'agent', 'pending'),
        step('b', 'agent', 'failed'),
      ]),
    );
    assert.equal(p.total, 6);
    assert.equal(p.finished, 4);
    assert.deepEqual(p.byLane, { casebook: 2, agent: 2 });
    assert.equal(p.verified, 1);
    assert.equal(p.paused, 1);
    assert.equal(p.started, true);
  });
  test('an approved job with nothing moved has not started (queued)', () => {
    assert.equal(
      progress(job('approved', [step('a', 'casebook')])).started,
      false,
    );
  });
});

describe('needs you', () => {
  test('the signal line', () => {
    assert.equal(needsLine(1, 1), '1 needs you · 1 paused');
    assert.equal(needsLine(2, 0), '2 need you');
    assert.equal(needsLine(0, 3), '3 paused');
    assert.equal(needsLine(0, 0), '');
  });
  test('open cards by job', () => {
    const c = (job_id: number, state: string): NeedsYou => ({
      id: ids++,
      job_id,
      step_id: 0,
      kind: 'text',
      question: '',
      text: '',
      state,
      answer: '',
      created_at: '',
    });
    const m = openCardsByJob([
      c(1, 'open'),
      c(1, 'open'),
      c(2, 'answered'),
      c(3, 'open'),
    ]);
    assert.equal(m.get(1), 2);
    assert.equal(m.get(2), undefined);
    assert.equal(m.get(3), 1);
  });
});

describe('the steps table', () => {
  test('✓ verified, ‖ paused, · next and queued', () => {
    assert.deepEqual(stepMark(step('pr-close', 'agent', 'verified'), false), {
      glyph: '✓',
      text: 'closed · verified',
      tone: 'ok',
    });
    assert.deepEqual(
      stepMark(
        step('pr-close', 'agent', 'paused', { detail: 'new comment' }),
        false,
      ),
      { glyph: '‖', text: 'paused', why: 'new comment', tone: 'agent' },
    );
    assert.equal(
      stepMark(step('pr-close', 'agent', 'paused'), false).glyph,
      '‖',
    );
    assert.deepEqual(stepMark(step('pr-close', 'agent'), true), {
      glyph: '·',
      text: 'next',
      tone: 'wait',
    });
    assert.equal(stepMark(step('pr-close', 'agent'), false).text, 'queued');
    assert.equal(
      stepMark(step('branch-delete-remote', 'casebook', 'verified'), false)
        .text,
      'deleted on the remote · verified',
    );
    assert.equal(
      stepMark(
        step('branch-delete-local', 'casebook', 'verified', { undone_at: 'x' }),
        false,
      ).text,
      'undone',
    );
  });
  test('the next step is the first pending one of each lane', () => {
    const a = step('x', 'casebook', 'verified');
    const b = step('x', 'casebook');
    const c = step('x', 'casebook');
    const d = step('y', 'agent', 'running');
    const e = step('y', 'agent');
    assert.deepEqual([...nextSteps([a, b, c, d, e])], [b.id, e.id]);
  });
});

describe('plans', () => {
  test('the summary and whether approving needs a session', () => {
    const local = step('branch-delete-local', 'casebook');
    const out = step('pr-close', 'agent');
    assert.equal(
      planSummary([local, local, out]),
      '3 steps · 2 local · 1 outward',
    );
    assert.equal(planSummary([local]), '1 step · 1 local');
    assert.equal(needsSession([local]), false);
    assert.equal(needsSession([local, out]), true);
  });
});

describe('ordering', () => {
  test('only the latest request may draw', () => {
    const s = makeSeq();
    const first = s.next();
    const second = s.next();
    assert.equal(s.isLatest(first), false);
    assert.equal(s.isLatest(second), true);
  });
});

describe('startedKeys', () => {
  const j = (id: number, state: string, keys: string[]): Job =>
    ({
      id,
      state,
      machine: 'm',
      created_at: '2026-09-27T00:00:00Z',
      paused: false,
      steps: keys.map((k) => step('pr-close', 'agent', 'pending', { key: k })),
    }) as unknown as Job;
  const jobs = [
    j(1, 'planned', ['pr:o/r#1', 'pr:o/r#2']),
    j(2, 'running', ['pr:o/r#3']),
    j(3, 'cancelled', ['pr:o/r#4']),
    j(5, 'approved', ['pr:o/r#5']),
    j(6, 'paused', ['pr:o/r#6']),
    j(7, 'done', ['pr:o/r#7']),
    j(8, 'failed', ['pr:o/r#8']),
    j(9, 'planned', ['pr:o/r#3']),
  ];
  test('a job approved, running or paused holds its keys; a plan holds nothing (its items still wait in review)', () => {
    const m = startedKeys(jobs);
    assert.deepEqual([...m.entries()].map(([k, id]) => `${k} #${id}`).sort(), [
      'pr:o/r#3 #2',
      'pr:o/r#5 #5',
      'pr:o/r#6 #6',
    ]);
  });
});

describe('runsThrough', () => {
  const local = step('branch-delete-local', 'casebook');
  const out = step('pr-close', 'agent');
  test('an all-local plan needs no agent', () => {
    assert.deepEqual(runsThrough([local], null), { text: '', can: true });
  });
  test('outward steps run through the attached agent', () => {
    assert.deepEqual(runsThrough([local, out], 'pi'), {
      text: 'runs through pi',
      can: true,
    });
  });
  test('with no agent attached, outward steps cannot run', () => {
    assert.deepEqual(runsThrough([out], null), {
      text: 'Open casebook from an agent to run this.',
      can: false,
    });
  });
});

describe('observations', () => {
  const t0 = Date.parse('2026-09-27T12:00:00Z');
  test('fresh within one sync interval, then its age', () => {
    assert.deepEqual(observations(t0, 30 * 60e3, t0 + 29 * 60e3), {
      text: 'observations fresh',
      stale: false,
    });
    assert.deepEqual(observations(t0, 30 * 60e3, t0 + 34 * 60e3), {
      text: 'observations 34m old',
      stale: true,
    });
    assert.equal(observations(t0, 2000, t0 + 5000).text, 'observations 5s old');
  });
  test('ageText', () => {
    assert.equal(ageText(40e3), '40s');
    assert.equal(ageText(3 * 3600e3), '3h');
    assert.equal(ageText(50 * 3600e3), '2d');
  });
});

// Review 2026-10-17: a held item not on the list's loaded pages counts once,
// however many steps its job has for it (a branch: local and remote).
describe('heldOutside', () => {
  const job = (state: string, steps: Array<[string, string]>): Job =>
    ({
      id: 1,
      state,
      steps: steps.map(([key, action], i) => ({ id: i + 1, key, action })),
    }) as unknown as Job;
  const B = 'branch:o/r@x';
  test('a branch with two steps counts once', () => {
    const jobs = [
      job('running', [
        [B, 'branch-delete-local'],
        [B, 'branch-delete-remote'],
      ]),
    ];
    assert.equal(heldOutside(jobs, 'delete|branch', new Set()), 1);
  });
  test('a loaded item, a finished job and a plan count nothing', () => {
    const jobs = [
      job('running', [[B, 'branch-delete-local']]),
      job('done', [['branch:o/r@y', 'branch-delete-local']]),
      job('planned', [['branch:o/r@z', 'branch-delete-local']]),
    ];
    assert.equal(heldOutside(jobs, 'delete|branch', new Set([B])), 0);
  });
  test("only the group the step's item is in", () => {
    const jobs = [job('running', [['repo:o/r', 'repo-archive']])];
    assert.equal(heldOutside(jobs, 'delete|branch', new Set()), 0);
    assert.equal(heldOutside(jobs, 'archive|repo', new Set()), 1);
  });
});

// Court 2026-10-17: a plan says how many it acts on, "Delete 7 repos".
describe('planTitle', () => {
  const job = (steps: Array<[string, string]>): Job =>
    ({
      id: 3,
      state: 'planned',
      steps: steps.map(([key, action], i) => ({
        id: i + 1,
        key,
        action,
        lane: 'agent',
      })),
    }) as unknown as Job;
  const nouns = (kind: string): [string, string] =>
    kind === 'branch' ? ['branch', 'branches'] : [kind, kind + 's'];
  test('one action: its count', () => {
    assert.equal(
      planTitle(
        job([
          ['repo:o/a', 'repo-delete'],
          ['repo:o/b', 'repo-delete'],
        ]),
        nouns,
      ),
      'delete 2 repos',
    );
  });
  test('one item reads singular', () => {
    assert.equal(
      planTitle(job([['pr:o/a#1', 'pr-merge']]), nouns),
      'merge 1 pr',
    );
  });
  test('a branch counts once across its local and remote steps', () => {
    assert.equal(
      planTitle(
        job([
          ['branch:o/r@x', 'branch-delete-local'],
          ['branch:o/r@x', 'branch-delete-remote'],
          ['pr:o/r#2', 'pr-close'],
        ]),
        nouns,
      ),
      'delete 1 local branch, delete 1 remote branch, close 1 pr',
    );
  });
});

describe('review tags and lines', () => {
  const st = (action: string, extra: Partial<Step> = {}): Step => ({
    key: 'pr:o/r#1',
    action,
    lane:
      action.startsWith('branch') || action === 'worktree-remove'
        ? 'casebook'
        : 'agent',
    command: 'c',
    ...extra,
  });
  test('actionTags', () => {
    assert.deepEqual(actionTags('repo-delete'), ['permanent']);
    assert.deepEqual(actionTags('pr-merge'), ['permanent']);
    assert.deepEqual(actionTags('pr-close'), ['github-undo']);
    assert.deepEqual(actionTags('issue-close'), ['github-undo']);
    assert.deepEqual(actionTags('repo-archive'), ['github-undo']);
    assert.deepEqual(actionTags('branch-delete-local'), []);
  });
  test('stepTags counts each kind', () => {
    const steps = [
      st('pr-merge'),
      st('pr-merge'),
      st('pr-close', { posts: true }),
      st('pr-close', { posts: true }),
      st('pr-close'),
      st('repo-delete'),
    ];
    assert.deepEqual(stepTags(steps), [
      { kind: 'permanent', n: 3 },
      { kind: 'posts', n: 2 },
      { kind: 'github-undo', n: 3 },
    ]);
    assert.deepEqual(stepTags([st('branch-delete-local')]), []);
  });
  test('tagText', () => {
    assert.equal(tagText({ kind: 'permanent', n: 2 }, 2), "can't be undone");
    assert.equal(tagText({ kind: 'permanent', n: 3 }, 0), "3 can't be undone");
    assert.equal(
      tagText({ kind: 'posts', n: 2 }, 3),
      '2 post a public comment',
    );
    assert.equal(
      tagText({ kind: 'posts', n: 1 }, 3),
      '1 posts a public comment',
    );
    assert.equal(tagText({ kind: 'posts', n: 1 }, 1), 'posts a public comment');
    assert.equal(tagText({ kind: 'github-undo', n: 3 }, 0), '3 undo on GitHub');
    assert.equal(tagText({ kind: 'github-undo', n: 3 }, 3), 'undo on GitHub');
  });
  test('publicLine', () => {
    assert.equal(
      publicLine(
        st('pr-close', {
          posts: true,
          comment: 'Closing as stale',
          public: true,
        }),
      ),
      'posts publicly on a public repo: \u201cClosing as stale\u201d',
    );
    assert.equal(
      publicLine(st('pr-close', { posts: true, comment: 'Superseded' })),
      'posts publicly: \u201cSuperseded\u201d',
    );
  });
  test('runsNow', () => {
    const plan: Plan = {
      built_at: '',
      steps: [
        st('worktree-remove'),
        st('worktree-remove'),
        st('branch-delete-remote'),
        st('branch-delete-remote'),
        st('branch-delete-remote'),
        st('branch-delete-local'),
      ],
      waiting: [1, 2, 3, 4].map((n) => ({
        key: `branch:o/r@b${n}`,
        machine: 'pro-2',
      })),
      held_back: [{ key: 'branch:o/r@dev', holds: [] }],
    };
    assert.equal(
      runsNow(plan),
      'runs now: 2 worktrees removed first, 3 deleted on GitHub, 1 deleted here.\nWaits for pro-2: 4 local copies. Held: 1.',
    );
    assert.equal(
      runsNow({
        built_at: '',
        steps: [st('pr-merge'), st('pr-close'), st('repo-delete')],
      }),
      '3 steps \u00b7 all on GitHub, through the agent.',
    );
    assert.equal(
      runsNow({
        built_at: '',
        steps: [st('branch-delete-local'), st('repo-archive')],
      }),
      'runs now: 1 deleted here, 1 on GitHub, through the agent.',
    );
    assert.equal(
      runsNow({
        built_at: '',
        steps: [],
        held_back: [{ key: 'pr:o/r#3', holds: [] }],
      }),
      'nothing runs now.\nHeld: 1.',
    );
    assert.equal(
      runsNow({
        built_at: '',
        steps: Array.from({ length: 1240 }, () => st('branch-delete-remote')),
      }),
      'runs now: 1,240 deleted on GitHub.',
    );
  });
  test('reviewKick', () => {
    assert.equal(
      reviewKick(10, ['branches']),
      'review \u00b7 10 ticked in branches',
    );
    assert.equal(
      reviewKick(3, ['branches', 'PRs']),
      'review \u00b7 3 ticked in 2 groups',
    );
  });
});

describe('review rows', () => {
  const branchWith = (over: Partial<ItemView>): ItemView =>
    ({
      key: 'branch:o/r@feat/x',
      kind: 'branch',
      decision: { disposition: 'delete' },
      ...over,
    }) as unknown as ItemView;
  const prClose = (): ItemView =>
    ({
      key: 'pr:o/r#3',
      kind: 'pr',
      decision: { disposition: 'close' },
    }) as unknown as ItemView;
  test('reviewLine says what holds it first', () =>
    assert.deepEqual(
      reviewLine(
        branchWith({
          holds: [
            {
              kind: 'no-access',
              text: "you can't change branches on GitHub",
              stops: ['delete'],
            },
          ],
        }),
        'Deleted it',
      ),
      { text: "held: you can't change branches on GitHub", tone: 'agent' },
    ));
  test('a hold that stops another decision is not this one', () =>
    assert.equal(
      reviewLine(
        branchWith({
          holds: [{ kind: 'x', text: 'no merging', stops: ['merge'] }],
          copies: [{ machine: '' }],
        }),
        'Deleted it',
      ).text,
      'deleted on GitHub',
    ));
  test('reviewLine names where a branch is deleted', () => {
    assert.equal(
      reviewLine(
        branchWith({ copies: [{ machine: 'work' }, { machine: '' }] }),
        'Deleted it',
      ).text,
      'deleted on GitHub and here',
    );
    assert.equal(
      reviewLine(
        branchWith({
          copies: [{ machine: 'work' }, { machine: '', absent: true }],
        }),
        'Deleted it',
      ).text,
      'deleted here',
    );
  });
  // Court, 2026-10-20: ghmr-bench's ten branches read "held" while their
  // GitHub deletes were in the plan; only their local copies waited.
  test('a local copy on another Mac waits; the GitHub delete still runs', () =>
    assert.deepEqual(
      reviewLine(
        branchWith({
          holds: [
            {
              kind: 'other-mac',
              text: 'its local copy is only on pro-2',
              stops: ['delete'],
              local: true,
              machine: 'pro-2',
            },
          ],
          copies: [
            { machine: 'pro-2' },
            { machine: 'work', absent: true },
            { machine: '' },
          ],
        }),
        'Deleted it',
      ),
      {
        text: 'deleted on GitHub \u00b7 local copy waits for pro-2',
        tone: 'muted',
      },
    ));
  test('a hold on one half names that half; the other half runs', () => {
    assert.deepEqual(
      reviewLine(
        branchWith({
          holds: [
            {
              kind: 'worktree',
              text: 'in use by worktree ops on work, which has uncommitted changes',
              stops: ['delete'],
              local: true,
              machine: 'work',
            },
          ],
          copies: [{ machine: 'work' }, { machine: '' }],
        }),
        'Deleted it',
      ),
      {
        text: 'deleted on GitHub \u00b7 local copy held: in use by worktree ops on work, which has uncommitted changes',
        tone: 'agent',
      },
    );
    assert.deepEqual(
      reviewLine(
        branchWith({
          holds: [
            {
              kind: 'no-access',
              text: "you can't change branches in o/r on GitHub (your access: read)",
              stops: ['delete'],
              remote: true,
            },
          ],
          copies: [{ machine: 'work' }, { machine: '' }],
        }),
        'Deleted it',
      ),
      {
        text: "deleted here \u00b7 GitHub copy held: you can't change branches in o/r on GitHub (your access: read)",
        tone: 'agent',
      },
    );
  });
  test('reviewLine falls back to the done word, lower case', () =>
    assert.deepEqual(reviewLine(prClose(), 'Closed it'), {
      text: 'closed it',
      tone: 'muted',
    }));
  test('TestReviewUntickHidden: a filter unticks what it hides', () =>
    assert.deepEqual(untickHidden(['a', 'b'], new Set(['a'])), ['b']));
});

describe('waits and held wording', () => {
  const plan = (key: string, action: string): Step => ({
    key,
    action,
    lane: 'casebook',
    command: 'c',
  });
  const a = { key: 'branch:o/r@a', machine: 'pro-2', path: '/p' };
  const b = { key: 'branch:o/r@b', machine: 'pro-2', path: '/p' };
  const w = {
    key: 'worktree:pro-2:/p/.worktrees/x',
    machine: 'pro-2',
    path: '/p',
  };
  test('a waiting branch whose GitHub delete runs here says so', () => {
    assert.deepEqual(waitBlocks([a], [plan(a.key, 'branch-delete-remote')]), [
      {
        text: 'Their local copies are only on pro-2; their GitHub copies are deleted above. They run from review the next time casebook runs there.',
        waits: [a],
      },
    ]);
  });
  test('a waiting branch with no GitHub delete here drops that clause', () => {
    assert.deepEqual(waitBlocks([b], [plan(a.key, 'branch-delete-remote')]), [
      {
        text: 'Their local copies are only on pro-2. They run from review the next time casebook runs there.',
        waits: [b],
      },
    ]);
  });
  test('a waiting worktree is removed from review there; mixed rows split', () => {
    const got = waitBlocks([a, w, b], [plan(a.key, 'branch-delete-remote')]);
    assert.deepEqual(
      got.map((x) => [x.text, x.waits.map((y) => y.key)]),
      [
        [
          'Their local copies are only on pro-2; their GitHub copies are deleted above. They run from review the next time casebook runs there.',
          [a.key],
        ],
        [
          'They are only on pro-2. They are removed from review the next time casebook runs there.',
          [w.key],
        ],
        [
          'Their local copies are only on pro-2. They run from review the next time casebook runs there.',
          [b.key],
        ],
      ],
    );
  });
  test('held text and the other half', () => {
    assert.equal(
      heldText,
      'Not run here. Each says what holds it; settle that and it joins the next run.',
    );
    const steps = [plan(a.key, 'branch-delete-local')];
    assert.equal(otherHalf(a.key, steps), ' \u00b7 its other half runs above');
    assert.equal(otherHalf(b.key, steps), '');
  });
});

describe('run rows', () => {
  const mk = (over: Partial<JobStep>): JobStep =>
    step(over.action ?? 'pr-close', over.lane ?? 'casebook', over.state, over);
  // Court, 2026-10-20: a half-done item says what waits.
  test('ranLine says when the local copy waits for another Mac', () =>
    assert.equal(
      ranLine(
        {
          job: 35,
          group: 'done',
          steps: [mk({ action: 'branch-delete-remote', state: 'verified' })],
        },
        [
          {
            kind: 'other-mac',
            text: 'its local copy is only on pro-2',
            stops: ['delete'],
            local: true,
            machine: 'pro-2',
          },
        ],
      ).text,
      'deleted on the remote \u00b7 verified \u00b7 job #35 \u00b7 local copy waits for pro-2',
    ));
  test('ranLine names what failed and the job', () =>
    assert.deepEqual(
      ranLine({
        job: 33,
        group: 'needs-you',
        steps: [mk({ action: 'branch-delete-remote', state: 'failed' })],
      }),
      { text: 'GitHub delete failed \u00b7 job #33', tone: 'signal' },
    ));
  test('ranLine on a verified step', () =>
    assert.equal(
      ranLine({
        job: 28,
        group: 'done',
        steps: [mk({ action: 'branch-delete-local', state: 'verified' })],
      }).text,
      'deleted \u00b7 verified \u00b7 job #28',
    ));
  test('actionVerb names where a branch is deleted', () => {
    assert.equal(actionVerb('branch-delete-remote'), 'GitHub delete');
    assert.equal(actionVerb('branch-delete-local'), 'local delete');
    assert.equal(actionVerb('worktree-remove'), 'worktree remove');
    assert.equal(actionVerb('pr-merge'), 'merge');
  });
  test('standsStep: what needs you, else what has not finished, else the last', () => {
    const v = mk({ state: 'verified' });
    const f = mk({ state: 'failed' });
    const p = mk({ state: 'pending' });
    assert.equal(standsStep({ job: 1, group: '', steps: [v, p, f] }), f);
    assert.equal(standsStep({ job: 1, group: '', steps: [v, p] }), p);
    assert.equal(
      standsStep({ job: 1, group: '', steps: [v, mk({ state: 'skipped' })] })
        .state,
      'skipped',
    );
  });
  test('aroundSteps keeps the steps around the item in a large job', () => {
    const r = aroundSteps(
      Array.from({ length: 215 }, (_, i) => mk({ key: `k${i}` })),
      'k100',
      3,
    );
    assert.deepEqual(
      r.steps.map((s) => s.key),
      ['k97', 'k98', 'k99', 'k100', 'k101', 'k102', 'k103'],
    );
    assert.equal(r.hidden, 208);
  });
  test('aroundSteps at the start of a job, and a small job whole', () => {
    const steps = Array.from({ length: 5 }, (_, i) => mk({ key: `k${i}` }));
    assert.deepEqual(
      aroundSteps(steps, 'k0', 3).steps.map((s) => s.key),
      ['k0', 'k1', 'k2', 'k3'],
    );
    assert.equal(aroundSteps(steps, 'k0', 3).hidden, 1);
  });
});

describe('ticked run items', () => {
  const failed = (id: number): JobStep => ({
    id,
    job_id: 33,
    key: `k${id}`,
    action: 'branch-delete-remote',
    lane: 'casebook',
    command: '',
    state: 'failed',
  });
  const verifiedUndoable = (id: number): JobStep => ({
    id,
    job_id: 28,
    key: `k${id}`,
    action: 'branch-delete-local',
    lane: 'casebook',
    command: '',
    state: 'verified',
    undoable: true,
  });
  const card = (step: number, kind: string): NeedsYou => ({
    id: 100 + step,
    job_id: 33,
    step_id: step,
    kind,
    question: '',
    text: '',
    state: 'open',
    answer: '',
    created_at: '',
  });
  const failedMark = (job: number) => ({
    job,
    group: 'needs-you',
    steps: [failed(job * 10 + 1)],
  });
  const mark = (job: number, steps: JobStep[], finished = false) => ({
    job,
    group: 'needs-you',
    finished,
    steps,
  });
  const ids = (xs: JobStep[]) => xs.map((x) => x.id);
  test('runBulk on an item with two failed steps skips both', () => {
    const b = runBulk(
      [mark(33, [failed(1), failed(2)])],
      [card(1, 'failed'), card(2, 'failed')],
    );
    assert.deepEqual(
      [ids(b.skip), ids(b.hand), ids(b.undo)],
      [[1, 2], [1, 2], []],
    );
  });
  test('runBulk shows nothing for a failed item and a done one together', () => {
    const b = runBulk(
      [mark(33, [failed(1)]), mark(28, [verifiedUndoable(2)], true)],
      [card(1, 'failed')],
    );
    assert.deepEqual([ids(b.skip), ids(b.hand), ids(b.undo)], [[], [], []]);
  });
  test('runBulk undoes every undoable step of each item', () => {
    const b = runBulk(
      [
        mark(28, [verifiedUndoable(1), verifiedUndoable(2)], true),
        mark(28, [verifiedUndoable(3)], true),
      ],
      [],
    );
    assert.deepEqual(
      [ids(b.skip), ids(b.hand), ids(b.undo)],
      [[], [], [1, 2, 3]],
    );
  });
  test('runBulk skips nothing in a job that has finished', () => {
    const b = runBulk([mark(33, [failed(1)], true)], [card(1, 'failed')]);
    assert.deepEqual(ids(b.skip), []);
  });
  test('tickedRunWords', () =>
    assert.deepEqual(
      tickedRunWords([failedMark(33), failedMark(33)], 'needs you'),
      {
        kick: 'run \u00b7 2 ticked in needs you',
        title: '2 failed steps',
        ctx: 'job #33',
      },
    ));
});

// Court, 2026-10-20: "this is also not an intelligible command".
describe('stepLine', () => {
  test('a GitHub delete reads as what it does; the key line above names the branch', () =>
    assert.equal(
      stepLine({
        action: 'branch-delete-remote',
        key: 'branch:schuettc/ghmr-bench@feat/boot-trace',
        command: "gh api graphql -f query='mutation(...)' -f r='R_1'",
        expected_tip: '14da80f3d9aecd97e5321bcf6be172a500fbaa3e',
      }),
      'delete on GitHub \u00b7 if still at 14da80f',
    ));
  test('a local delete and a worktree removal read the same way', () => {
    assert.equal(
      stepLine({
        action: 'branch-delete-local',
        key: 'branch:o/r@feat/x',
        command: "git -C '/r' update-ref -d 'refs/heads/feat/x' abc1234def",
        expected_tip: 'abc1234def',
      }),
      'delete here \u00b7 if still at abc1234',
    );
    assert.equal(
      stepLine({
        action: 'worktree-remove',
        key: 'worktree:work:/r/.worktrees/ops',
        command: "git -C '/r' worktree remove '/r/.worktrees/ops'",
      }),
      'remove the worktree',
    );
  });
  test('a gh command that already reads is shown as it is', () =>
    assert.equal(
      stepLine({
        action: 'pr-merge',
        key: 'pr:o/r#7',
        command: "gh pr merge 7 -R 'o/r' --squash",
      }),
      "gh pr merge 7 -R 'o/r' --squash",
    ));
});
