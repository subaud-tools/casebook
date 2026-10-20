// probe-apply.mjs — nothing runs without Court's click, and what runs is
// exactly what review showed: review's and run's probe scenarios, run by
// probe.mjs with its check helpers (t.check, t.checkList, t.until,
// t.eventually).
//
// Each scenario group starts its own serve (serve.mjs) with its own data:
// real clones under the serve's temp home with landed branches (seedClones:
// the casebook lane's git runs there and nowhere else), dormant repos and a
// bot's PR in the GitHub cache (seedRepos). serve's gh is the probe's fake
// (serve.mjs): nothing the probe starts reaches GitHub. The agent is the
// fake agent (agent.mjs) over serve's own routes: presence,
// casebook_job_step.
//
//   review previews and stores nothing: a group opened (twice, in two
//     tabs, or pressed twice), left, or ticked stores no plan
//   with no agent attached an outward group's button is off and "a" runs
//     nothing
//   the button stores and approves exactly the plan on screen, through the
//     attached agent; approving opens no batch card
//   a changed plan is drawn before it can run; "a" meanwhile approves
//     nothing
//   a step that can never be undone asks first; cancel stores nothing
//   on decide, "a" doesn't run the group open in review
//   running ticked items stays on the job in run
//   a verified item leaves review; a failed one stays

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServe, probeGit } from './serve.mjs';
import { createAgent } from './agent.mjs';

const SESSION = 'probe-t9-pi';
const LABEL = 'pi \u00b7 t9-apply';

const dormant = (name) => ({
  repo: `schuettc/${name}`,
  pushed_at: '2023-01-10T00:00:00Z',
  default_branch: 'main',
  prs: [],
  issues: [],
});
const T9_SEED = {
  seedClones: [{ name: 't9-local', branches: ['feat/l1', 'feat/l2'] }],
  seedRepos: [
    dormant('t9-dormant-a'),
    dormant('t9-dormant-b'),
    dormant('t9-dormant-c'),
    {
      repo: 'schuettc/t9-prs',
      pushed_at: '2026-09-20T00:00:00Z',
      default_branch: 'main',
      prs: [
        {
          repo: 'schuettc/t9-prs',
          number: 7,
          title: 'bump lodash from 4.17.20 to 4.17.21',
          author: 'dependabot[bot]',
          state: 'OPEN',
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
        },
      ],
      issues: [],
    },
  ],
};
const BR = (b) => `branch:schuettc/t9-local@${b}`;
const PR = 'pr:schuettc/t9-prs#7';
const REPO_A = 'repo:schuettc/t9-dormant-a';
const REPO_B = 'repo:schuettc/t9-dormant-b';
// Decided delete: a step that can never be undone, so its group asks first.
const REPO_C = 'repo:schuettc/t9-dormant-c';

const pressWithFocus = async (pg, k) => {
  await pg.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.body.dispatchEvent(new FocusEvent('focus'));
  });
  await pg.keyboard.press(k);
};

// copyPlan writes a second plan with the same steps as plan jobId straight
// into this serve's database: what an older casebook (before serve kept an
// item to one unfinished job) could have left behind. serve can't be asked
// for it; that is the point. It returns the copy's job id.
async function copyPlan(home, jobId) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = readdirSync(home, { recursive: true }).find(
    (f) => String(f).split('/').pop() === 'casebook.db',
  );
  if (!file) throw new Error(`no casebook.db under ${home}`);
  const db = new DatabaseSync(join(home, String(file)));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const r = db
      .prepare(
        `INSERT INTO jobs(plan_json, machine, session, state, created_at)
         SELECT plan_json, machine, '', 'planned', created_at FROM jobs WHERE id = ?`,
      )
      .run(jobId);
    const id = Number(r.lastInsertRowid);
    db.prepare(
      `INSERT INTO steps(job_id, pos, key, action, lane, command, precondition, posts, expected_tip, state, updated_at)
       SELECT ?, pos, key, action, lane, command, precondition, posts, expected_tip, 'pending', updated_at
       FROM steps WHERE job_id = ?`,
    ).run(id, jobId);
    db.exec('COMMIT');
    return id;
  } finally {
    db.close();
  }
}

// gitIn runs git in a probe clone (under the serve's temp home only),
// hermetically (serve.mjs probeGit).
function gitIn(home, clone, args) {
  try {
    return probeGit(join(home, 'clones', clone), args, home);
  } catch {
    return null;
  }
}

let serves = [];
/** stopAll stops every serve these scenarios started (probe.mjs cleanup). */
export function stopApplyServes() {
  for (const s of serves) s.stop();
  serves = [];
}

async function ownServe(opts) {
  const s = await startServe(opts);
  serves.push(s);
  return s;
}

export async function applyScenarios(shared, t) {
  const context = await shared.browser().newContext();
  try {
    await applyScenariosIn(context, t);
  } finally {
    await context.close();
  }
}

// PROBE_SCENARIO (with PROBE_ONLY=apply) runs only the scenario groups
// whose name has it: main, same, ticked, changed, holds, frame, stale.
const runs = (name) =>
  !process.env.PROBE_SCENARIO || name.includes(process.env.PROBE_SCENARIO);

async function applyScenariosIn(context, t) {
  const groups = [
    ['main', T9_SEED, applyScenariosOn],
    ['same', { seedRepos: [dormant('t10-same')] }, sameGroupScenario],
    ['ticked', TICKED_SEED, tickedRunScenario],
    ['changed', CHANGED_SEED, changedPlanScenario],
    ['holds', HOLDS_SEED, holdsScenario],
    ['frame', FRAME_SEED, frameScenario],
    ['stale', STALE_SEED, staleScenario],
  ];
  for (const [name, seed, run] of groups) {
    if (!runs(name)) continue;
    const s = await ownServe(seed);
    try {
      await run(context, t, s);
    } catch (err) {
      t.check(
        `apply ${name}: the scenario ran to its end — ${err.message}`,
        false,
      );
    } finally {
      s.stop();
      serves = serves.filter((x) => x !== s);
    }
  }
}

// A waiting group's checkbox (ticking it reviews the group), and the plan's
// one button.
const HEAD = (id) => `.cb-apply-part[data-part="${id}"] .cb-group-box`;
const RUN_BTN = '[data-testid="run-group"] .kit-btn';

// openedGroup waits for group id's ticks to be reviewed, its plan (job)
// shown.
function openedGroup(t, pg, id, jobId) {
  return t.until(
    pg,
    ([g, j]) =>
      location.hash.startsWith('#/review') &&
      document.querySelector('[data-testid="review-group"]')?.dataset.group ===
        g &&
      (j === null || !!document.querySelector('[data-testid="run-group"]')),
    [id, jobId ?? null],
  );
}

// clearTicks unticks every group in review: the overview shows.
async function clearTicks(t, pg) {
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll(
      '.cb-pane-review .cb-group-ticked:not([hidden]) .cb-group-untick',
    ))
      b.click();
  });
  await t.until(
    pg,
    () => !!document.querySelector('[data-testid="review-overview"]'),
  );
}

// sameCmds says job runs exactly the commands drawn (the page draws them
// part by part, serve lists them item by item).
const sameCmds = (job, drawn) => {
  const ran = (job?.steps ?? []).map((x) => x.command).sort();
  return ran.length > 0 && ran.join('\n') === [...drawn].sort().join('\n');
};

// The open group's commands and its button, read in one go (a step's
// command, not what waits or is held).
const readGroup = (pg) =>
  pg.evaluate(() => {
    const doc = document.querySelector('[data-testid="review-group"]');
    return {
      cmds: [
        ...(doc?.querySelectorAll(
          '.cb-plan-group[data-action] .cb-plan-step .cb-cmd',
        ) ?? []),
      ].map((e) => e.dataset.cmd ?? e.textContent),
      btns: [
        ...(doc?.querySelectorAll('[data-testid="run-group"] .kit-btn') ?? []),
      ].map((b) => (b.disabled ? 'off' : 'on')),
    };
  });

async function applyScenariosOn(context, t, serveHandle) {
  const { check, checkList, until, eventually } = t;
  console.log('\nscenario: review and run — nothing runs without a click');
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const job = (id) => agent.api('GET', `/api/job?id=${id}`);
  const jobsNow = async () => (await agent.api('GET', '/api/jobs')).jobs ?? [];
  const toApply = async () =>
    ((await agent.api('GET', '/api/items?view=to-apply')).items ?? []).map(
      (i) => i.key,
    );
  const holds = async (key) =>
    (await jobsNow()).some((j) => (j.steps ?? []).some((x) => x.key === key));
  const stepsOf = (v) =>
    (v.job?.steps ?? []).map((x) => `${x.key} ${x.command}`).join('\n');
  const home = serveHandle.home;

  // Court's decisions: the landed branches deleted, two dormant repos
  // archived and one deleted, the bot's PR closed with a comment.
  await agent.api('POST', '/api/decide', {
    keys: [BR('feat/l1'), BR('feat/l2')],
    disposition: 'delete',
  });
  await agent.api('POST', '/api/decide', {
    keys: [REPO_A, REPO_B],
    disposition: 'archive',
  });
  await agent.api('POST', '/api/decide', {
    keys: [REPO_C],
    disposition: 'delete',
  });
  await agent.api('POST', '/api/decide', {
    keys: [PR],
    disposition: 'close',
    note: 'superseded by #9',
  });

  // openGroup ticks group id in review, nothing else ticked; its plan's
  // reply.
  const openGroup = async (pg, id) => {
    await pg.evaluate(() => {
      if (!location.hash.startsWith('#/review')) location.hash = '#/review';
    });
    await until(pg, (b) => !!document.querySelector(b), HEAD(id));
    await clearTicks(t, pg);
    const resp = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') && r.request().method() === 'POST',
    );
    await pg.click(HEAD(id));
    const body = await (await resp).json();
    await openedGroup(t, pg, id, body.job?.id);
    return body;
  };
  // runOpen presses the open group's button (or "a"): the page stores the
  // plan (POST /api/apply/plan, no preview) and approves it; serve's job.
  const runOpen = async (pg, how = 'click', press = true) => {
    const store = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') &&
        r.request().method() === 'POST' &&
        !r.request().postDataJSON()?.preview,
    );
    const resp = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/approve') &&
        r.request().method() === 'POST',
    );
    if (press) {
      if (how === 'key') await pressWithFocus(pg, 'a');
      else await pg.click(`${RUN_BTN}.fill`);
    }
    const st = await store;
    const r = await resp;
    return {
      storeSent: st.request().postDataJSON(),
      stored: await st.json(),
      sent: r.request().postDataJSON(),
      body: await r.json(),
    };
  };
  const inRun = (pg, id) =>
    until(
      pg,
      (j) =>
        location.hash === `#/run/${j}` &&
        document.querySelector('.cb-job')?.dataset.job === String(j) &&
        document.querySelector('.kit-ctl.on')?.dataset.id === 'run',
      id,
      8000,
    );

  const pg = await context.newPage();
  let keep = null;
  try {
    await pg.goto(serveHandle.url + '#/review', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // ---- review previews and stores nothing -----------------------------
    const served = await agent.api('GET', '/api/items?view=to-apply');
    await until(
      pg,
      (n) => document.querySelectorAll('.cb-apply-part').length === n,
      served.groups.length,
    );
    for (const g of served.groups)
      await pg.click(`.cb-apply-part[data-part="${g.id}"] .cb-group-caret`);
    await until(
      pg,
      (k) =>
        !!document.querySelector(`.cb-apply-list .kit-row[data-key="${k}"]`),
      REPO_B,
    );
    await pg.click(`.cb-apply-list .kit-row[data-key="${REPO_B}"] .kit-box`);
    check(
      'ticking an item opens its group in review for it',
      await until(
        pg,
        () =>
          document.querySelector('[data-testid="review-group"]')?.dataset
            .group === 'archive|repo' &&
          !!document.querySelector('[data-testid="run-group"]'),
      ),
    );
    check(
      `the ticked review only previews: serve stores no plan (${(await jobsNow()).length} jobs)`,
      (await jobsNow()).length === 0,
    );
    await pg.click(`.cb-apply-list .kit-row[data-key="${REPO_B}"] .kit-box`);
    await until(
      pg,
      () => !!document.querySelector('[data-testid="review-overview"]'),
    );

    const planPosts = [];
    const onPlanPost = (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/apply/plan'))
        planPosts.push(r.url());
    };
    pg.on('request', onPlanPost);
    const branchResp = pg.waitForResponse((r) =>
      r.url().includes('/api/apply/plan'),
    );
    await pg.click(HEAD('delete|branch'));
    const branchPlan = await (await branchResp).json();
    await openedGroup(t, pg, 'delete|branch', branchPlan.job.id);
    // An item unticked and ticked again at once: the same items, no new ask.
    await pg.click(
      `.cb-apply-list .kit-row[data-key="${BR('feat/l1')}"] .kit-box`,
      { clickCount: 2 },
    );
    // Kept: the check is that the second press posts nothing; a window for
    // a second POST to go out.
    await pg.waitForTimeout(500);
    pg.off('request', onPlanPost);
    check(
      `ticking a group asks serve once for the same ticks, a preview that stores nothing (${planPosts.length} POST /api/apply/plan)`,
      planPosts.length === 1 && (await jobsNow()).length === 0,
    );
    const shown = await readGroup(pg);
    checkList(
      "the open group shows serve's commands for its items, verbatim",
      shown.cmds,
      branchPlan.groups.flatMap((g) => g.steps.map((s) => s.command)),
    );
    await clearTicks(t, pg);
    check(
      'unticking it runs nothing: serve stores nothing',
      !!(await pg.$('[data-testid="review-overview"]')) &&
        (await jobsNow()).length === 0,
    );
    const again = await openGroup(pg, 'delete|branch');
    check(
      `opening it again previews the same steps, and stores nothing (${(await jobsNow()).length} jobs)`,
      stepsOf(again) === stepsOf(branchPlan) && (await jobsNow()).length === 0,
    );

    // ---- outward steps with no agent ----------------------------------
    await pg.evaluate(() => {
      location.hash = '#/review';
    });
    await openGroup(pg, 'archive|repo');
    check(
      `with no agent attached an outward group's button is off (${(await readGroup(pg)).btns.join(', ')})`,
      (await readGroup(pg)).btns.join(',') === 'off',
    );
    await pressWithFocus(pg, 'a');
    await pg.waitForTimeout(400); // kept: "a" must run nothing; a window for it
    check(
      '"a" with no agent runs nothing (serve stores no plan)',
      (await jobsNow()).length === 0,
    );

    // ---- a local group runs exactly what was shown ----------------------
    await pg.evaluate(() => {
      location.hash = '#/review';
    });
    const branch = await openGroup(pg, 'delete|branch');
    const drawn = (await readGroup(pg)).cmds;
    // Two stored plans holding the group, as an older casebook could have
    // left them: storing it to run cancels both and stores one fresh.
    const old = await agent.api('POST', '/api/apply/plan', {
      keys: [BR('feat/l1'), BR('feat/l2')],
    });
    const twin = await copyPlan(home, old.job.id);
    const ran = await runOpen(pg);
    const branchJob = ran.body.job?.id;
    check(
      `pressing it stores the plan on screen (no preview) and approves exactly it: plan #${ran.stored.job?.id}, the commands drawn (${JSON.stringify(ran.storeSent)} ${JSON.stringify(ran.sent)})`,
      !ran.storeSent.preview &&
        stepsOf(ran.stored) === stepsOf(branch) &&
        sameCmds(ran.body.job, drawn) &&
        branchJob === ran.stored.job?.id &&
        ran.sent.plan_id === branchJob &&
        ran.sent.session === '',
    );
    const states = Object.fromEntries(
      (await jobsNow()).map((j) => [j.id, j.state]),
    );
    check(
      `two older plans holding the group are cancelled, and the one it runs is fresh (#${old.job.id} ${states[old.job.id]}, #${twin} ${states[twin]}, #${branchJob} ${states[branchJob]})`,
      states[old.job.id] === 'cancelled' &&
        states[twin] === 'cancelled' &&
        branchJob !== old.job.id &&
        branchJob !== twin &&
        !['planned', 'cancelled'].includes(states[branchJob]),
    );
    check(
      `the job opens in run (#/run/${branchJob})`,
      await inRun(pg, branchJob),
    );
    check(
      'the casebook lane deleted feat/l1 in the probe clone (git, in the temp home)',
      await eventually(
        async () =>
          gitIn(home, 't9-local', 'rev-parse --verify refs/heads/feat/l1') ===
            null &&
          gitIn(home, 't9-local', 'rev-parse --verify refs/heads/main') !==
            null,
        10000,
      ),
    );
    check(
      'verified, the branches leave review: serve lists them no more, and the bar counts 4 waiting',
      (await eventually(async () => {
        const left = await toApply();
        return !left.includes(BR('feat/l1')) && !left.includes(BR('feat/l2'));
      }, 10000)) &&
        (await until(
          pg,
          () =>
            document.querySelector('.kit-ctl[data-id="review"] .kit-n')
              ?.textContent === '4',
          undefined,
          10000,
        )),
    );

    // ---- an outward group runs through the agent attached --------------
    await agent.presence(SESSION, LABEL, '/home/court/t9', 'pi');
    keep = setInterval(() => {
      void agent.presence(SESSION, LABEL, '/home/court/t9', 'pi');
    }, 1000);
    await pg.evaluate(() => {
      location.hash = '#/review';
    });
    await openGroup(pg, 'close|pr');
    await until(
      pg,
      (b) => !!document.querySelector(b) && !document.querySelector(b).disabled,
      `${RUN_BTN}.fill`,
      8000,
    );
    // Run from the keyboard: "a" runs the open group.
    const prDrawn = (await readGroup(pg)).cmds;
    const prRan = await runOpen(pg, 'key');
    const jobId = prRan.body.job?.id;
    check(
      `"a" runs the plan on screen through the attached agent: serve has job ${jobId} approved for ${SESSION}`,
      jobId === prRan.stored.job?.id &&
        prRan.sent.plan_id === jobId &&
        prRan.sent.session === SESSION &&
        sameCmds(prRan.body.job, prDrawn) &&
        (await eventually(async () => {
          const j = (await job(jobId)).job;
          return j.state !== 'planned' && j.session === SESSION;
        })),
    );
    check(
      'approving was the go: the job opens in run with its steps, and no batch card, on the page or in serve',
      (await inRun(pg, jobId)) &&
        (await until(
          pg,
          () => !!document.querySelector('.cb-steps .cb-step'),
        )) &&
        !(await pg.$('.cb-needs-card[data-kind="batch"]')) &&
        ((await job(jobId)).needs_you ?? []).every((c) => c.kind !== 'batch'),
    );
    // A failed step stays in review.
    const prStep = (await job(jobId)).job.steps.find((x) => x.key === PR);
    for (const state of ['started', 'failed'])
      await agent.api('POST', '/api/agent/job-step', {
        session: SESSION,
        job: jobId,
        step: prStep.id,
        state,
        ...(state === 'failed' ? { detail: 'gh: HTTP 502' } : {}),
      });
    check(
      'a failed step stays in review: its step failed in serve, and the PR still waits there',
      (await eventually(
        async () =>
          (await job(jobId)).job.steps.find((x) => x.id === prStep.id)
            ?.state === 'failed',
      )) && (await toApply()).includes(PR),
    );

    // ---- a step that can never be undone ------------------------------
    await pg.evaluate(() => {
      location.hash = '#/review';
    });
    await openGroup(pg, 'delete|repo');
    await until(
      pg,
      (b) => !!document.querySelector(b) && !document.querySelector(b).disabled,
      `${RUN_BTN}.fill`,
      8000,
    );
    await pg.click(`${RUN_BTN}.fill`);
    check(
      'pressing it asks first, naming the item, and stores nothing yet',
      (await until(
        pg,
        () =>
          [...document.querySelectorAll('.kit-sheet .cb-confirm-list li')]
            .map((e) => e.textContent)
            .join(',') === 'schuettc/t9-dormant-c',
      )) && !(await holds(REPO_C)),
    );
    await pg.click('.kit-sheet .kit-btn:has-text("cancel")');
    check(
      'cancel runs nothing: the sheet goes, serve stores no plan for it, review stays',
      (await until(pg, () => !document.querySelector('.kit-sheet'))) &&
        !(await holds(REPO_C)) &&
        (await pg.evaluate(() => location.hash)).startsWith('#/review'),
    );
    await pg.click(`${RUN_BTN}.fill`);
    await until(pg, () => !!document.querySelector('.kit-sheet'));
    const delRun = runOpen(pg, 'click', false);
    await pg.click('.kit-sheet .kit-btn.fill');
    const delRan = await delRun;
    const delJob = delRan.body.job?.id;
    check(
      `confirmed, it is stored and runs, and opens in run (job ${delJob})`,
      !!delJob && delRan.stored.job?.id === delJob && (await inRun(pg, delJob)),
    );

    // ---- on decide, "a" runs nothing -----------------------------------
    await pg.evaluate(() => {
      location.hash = '#/review';
    });
    await openGroup(pg, 'archive|repo');
    await until(
      pg,
      (b) => !!document.querySelector(b) && !document.querySelector(b).disabled,
      `${RUN_BTN}.fill`,
      8000,
    );
    await pg.evaluate(() => {
      location.hash = '#/decide';
    });
    await until(
      pg,
      () =>
        document
          .querySelector('.kit-ctl[data-id="decide"]')
          ?.classList.contains('on') ?? false,
    );
    await pressWithFocus(pg, 'a');
    await pg.waitForTimeout(600); // kept: "a" must run nothing; a window for it
    check(
      'on decide, "a" does not run the group open in review (no plan stored for it)',
      !(await holds(REPO_A)),
    );
  } finally {
    if (keep) clearInterval(keep);
    await pg.close();
  }
}

// sameGroupScenario: two tabs open the same group: each previews it and
// serve stores nothing (a plan is stored only when Court runs it). Three
// tabs share one live connection (web/shared-stream.ts).
async function sameGroupScenario(context, t, serveHandle) {
  const { check, checkList, until } = t;
  console.log('\nscenario: review — two tabs open the same group: one plan');
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const ITEM = 'repo:schuettc/t10-same';
  await agent.api('POST', '/api/decide', {
    keys: [ITEM],
    disposition: 'archive',
  });
  const events = [];
  const onEvents = (r) => {
    if (new URL(r.url()).pathname === '/api/events') events.push(r.url());
  };
  context.on('request', onEvents);
  const pg = await context.newPage();
  const pg2 = await context.newPage();
  const pg3 = await context.newPage();
  const planOf = async (p) => {
    await p.goto(serveHandle.url + '#/review', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await p.waitForSelector(HEAD('archive|repo'), { timeout: 8000 });
    const resp = p.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') && r.request().method() === 'POST',
    );
    await p.click(HEAD('archive|repo'));
    const r = await resp;
    return { status: r.status(), body: await r.json().catch(() => ({})) };
  };
  try {
    const a = await planOf(pg);
    const b = await planOf(pg2);
    const stepsOf = (v) =>
      (v.job?.steps ?? []).map((x) => `${x.key} ${x.command}`).join('\n');
    check(
      `the first tab's group is serve's preview (${a.status}, ${(a.body.job?.steps ?? []).length} step)`,
      a.status === 200 && (a.body.job?.steps ?? []).length === 1,
    );
    check(
      `the second tab's preview has the same steps (${b.status})`,
      b.status === 200 && stepsOf(b.body) === stepsOf(a.body),
    );
    const jobs = (await agent.api('GET', '/api/jobs')).jobs ?? [];
    checkList(
      'previewing stores no plan: serve has no job',
      jobs.map((j) => `#${j.id} ${j.state}`),
      [],
    );
    check(
      'both tabs show it in review with its one button',
      (await openedGroup(t, pg, 'archive|repo', 0)) &&
        (await openedGroup(t, pg2, 'archive|repo', 0)),
    );
    await pg3.goto(serveHandle.url + '#/decide', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const live = async (p) =>
      until(
        p,
        () => document.querySelector('.kit-live')?.dataset.state === 'live',
      );
    const allLive = (await live(pg)) && (await live(pg2)) && (await live(pg3));
    // Kept: a window for a second connection to go out.
    await pg.waitForTimeout(1000);
    check(
      `three tabs share one live connection: one GET /api/events in the browser (${events.length}), every tab live (${allLive})`,
      allLive && events.length === 1,
    );
  } finally {
    context.off('request', onEvents);
    await pg.close();
    await pg2.close();
    await pg3.close();
  }
}

// ---- running ticked items stays on the job ---------------------------------
// Court 2026-10-18: after running one ticked PR, the page went to run and,
// 200ms later, jumped back to review showing every PR left in the group.
const TPR = (n) => `pr:schuettc/tk-prs#${n}`;
const TICKED_SEED = {
  seedRepos: [
    {
      repo: 'schuettc/tk-prs',
      pushed_at: '2026-09-20T00:00:00Z',
      default_branch: 'main',
      prs: [1, 2, 3].map((number) => ({
        repo: 'schuettc/tk-prs',
        number,
        title: `bump dep ${number}`,
        author: 'dependabot[bot]',
        state: 'OPEN',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      })),
      issues: [],
    },
  ],
};
async function tickedRunScenario(context, t, s) {
  const { check, until } = t;
  console.log('\nscenario: run ticked items — the page stays on the job');
  const agent = createAgent(s.base, s.token);
  const S = 'probe-ticked-pi';
  const here = () => agent.presence(S, 'pi \u00b7 tk', '/home/court/tk', 'pi');
  await here();
  const keep = setInterval(() => void here(), 1000);
  const pg = await context.newPage();
  try {
    await agent.api('POST', '/api/decide', {
      keys: [1, 2, 3].map(TPR),
      disposition: 'close',
    });
    await pg.goto(`${s.url}&session=${S}#/review`, {
      waitUntil: 'domcontentloaded',
    });
    await pg.waitForSelector('.cb-apply-part[data-part="close|pr"]');
    await pg.click('.cb-apply-part[data-part="close|pr"] .cb-group-caret');
    const planKeys = (k) =>
      until(
        pg,
        (want) =>
          [
            ...new Set(
              [
                ...document.querySelectorAll(
                  '[data-testid="review-group"] .cb-plan-step',
                ),
              ].map((e) => e.dataset.key),
            ),
          ]
            .sort()
            .join(',') === want,
        k,
      );
    for (const n of [1, 3])
      await pg.click(`.cb-apply-list .kit-row[data-key="${TPR(n)}"] .kit-box`);
    await planKeys([TPR(1), TPR(3)].sort().join(','));
    // Unticking an item turns the run button off at once: the plan drawn
    // still holds it, and a click before the new plan is in would run it.
    await until(
      pg,
      () =>
        !!document.querySelector(
          '[data-testid="run-group"] .kit-btn:not([disabled])',
        ),
    );
    const offAtOnce = await pg.evaluate((k) => {
      document
        .querySelector(`.cb-apply-list .kit-row[data-key="${k}"] .kit-box`)
        .click();
      return [
        ...document.querySelectorAll('.cb-apply-read .cb-ticked button'),
        ...document.querySelectorAll('[data-testid="run-group"] .kit-btn'),
      ].every((b) => b.disabled);
    }, TPR(3));
    check(
      'review: unticking an item turns the run button off at once, before the new plan is in',
      offAtOnce,
    );
    await planKeys(TPR(1));
    await pg.click(`.cb-apply-list .kit-row[data-key="${TPR(3)}"] .kit-box`);
    await planKeys([TPR(1), TPR(3)].sort().join(','));
    // A filter serve refuses lists nothing: the ticks and the plan go too.
    t.expectError('status of 400');
    await pg.evaluate(() => (location.hash = '#/review?filters=tk-no-such'));
    check(
      'review: a filter serve refuses clears the ticks and the plan, and nothing can run',
      await until(
        pg,
        () =>
          !document.querySelector('[data-testid="run-group"]') &&
          !!document.querySelector('[data-testid="review-overview"]') &&
          [
            ...document.querySelectorAll('.cb-pane-review .cb-group-ticked'),
          ].every((e) => e.hidden),
      ),
    );
    await pg.evaluate(() => (location.hash = '#/review'));
    await pg.waitForSelector(
      `.cb-apply-list .kit-row[data-key="${TPR(3)}"] .kit-box`,
    );
    for (const n of [1, 3])
      await pg.click(`.cb-apply-list .kit-row[data-key="${TPR(n)}"] .kit-box`);
    await planKeys([TPR(1), TPR(3)].sort().join(','));
    // A saved filter that hides #3: the plan is what is shown and ticked.
    await agent.api('POST', '/api/filters/save?create=1', {
      id: 'tk-not-3',
      name: 'Not dep 3',
      match: [{ field: 'title', op: 'matches', value: 'dep [12]' }],
    });
    const chip = '.cb-pane-review .cb-filter[data-id="tk-not-3"]';
    await pg.waitForSelector(chip, { timeout: 8000 });
    await pg.click(chip);
    check(
      'review: a filter narrows the plan to what is shown and ticked',
      (await planKeys(TPR(1))) &&
        (await pg.evaluate(
          (k) =>
            !document.querySelector(
              `.cb-pane-review .kit-row[data-key="${k}"]`,
            ),
          TPR(3),
        )),
    );
    await until(
      pg,
      () =>
        !!document.querySelector(
          '[data-testid="run-group"] .kit-btn:not([disabled])',
        ),
    );
    const approved = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/approve') &&
        r.request().method() === 'POST',
    );
    await pg.click('[data-testid="run-group"] .kit-btn');
    const ran = (await (await approved).json()).job ?? {};
    check(
      `running the ticked PR runs it alone (${(ran.steps ?? []).map((x) => x.key).join(', ')})`,
      (ran.steps ?? []).length > 0 &&
        (ran.steps ?? []).every((x) => x.key === TPR(1)),
    );
    await until(pg, () => location.hash.startsWith('#/run/'));
    const at = await pg.evaluate(() => location.hash);
    // The run list loads and a live event about the job redraws it: the
    // reloads that sent the page back to review.
    await agent.api('POST', '/api/agent/job-step', {
      session: S,
      job: ran.id,
      step: ran.steps[0].id,
      state: 'started',
    });
    const redrawn = await until(
      pg,
      ([id, step]) =>
        !!document.querySelector(
          `.cb-pane-run .cb-run-job[data-job="${id}"]`,
        ) &&
        document.querySelector(`.cb-step[data-step="${step}"]`)?.dataset
          .state === 'running',
      [ran.id, ran.steps[0].id],
      8000,
    );
    const after = await pg.evaluate(() => location.hash);
    check(
      `after running one ticked PR the page stays on its job in run through its reloads (${at} then ${after}; redrawn ${redrawn}), not back on review with the rest`,
      redrawn && after === at && at === `#/run/${ran.id}`,
    );
  } finally {
    clearInterval(keep);
    await pg.close();
  }
}

// ---- a plan that changed since it was shown --------------------------------
// Review 2026-10-18: a press whose stored plan differed from the one shown
// swapped the plan in without drawing it, so the next press ran commands
// Court had never seen. Running only ever acts on the plan on the page.
const CPR = 'pr:schuettc/ch-prs#1';
const CHANGED_SEED = {
  seedRepos: [
    {
      repo: 'schuettc/ch-prs',
      pushed_at: '2026-09-20T00:00:00Z',
      default_branch: 'main',
      prs: [
        {
          repo: 'schuettc/ch-prs',
          number: 1,
          title: 'bump dep 1',
          author: 'dependabot[bot]',
          state: 'OPEN',
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
        },
      ],
      issues: [],
    },
  ],
};
async function changedPlanScenario(context, t, s) {
  const { check, until } = t;
  console.log('\nscenario: review — the plan changed since it was shown');
  const agent = createAgent(s.base, s.token);
  const S = 'probe-changed-pi';
  const here = () => agent.presence(S, 'pi \u00b7 ch', '/home/court/ch', 'pi');
  await here();
  const keep = setInterval(() => void here(), 1000);
  const pg = await context.newPage();
  const approves = [];
  pg.on('request', (r) => {
    if (r.url().includes('/api/apply/approve') && r.method() === 'POST')
      approves.push(r.postDataJSON());
  });
  const cmds = () =>
    pg.evaluate(() =>
      [...document.querySelectorAll('.cb-plan-step .cb-cmd')].map(
        (e) => e.textContent,
      ),
    );
  try {
    await agent.api('POST', '/api/decide', {
      keys: [CPR],
      disposition: 'close',
      note: 'first note',
    });
    await pg.setViewportSize({ width: 1600, height: 900 });
    await pg.goto(`${s.url}&session=${S}#/review`, {
      waitUntil: 'domcontentloaded',
    });
    await until(pg, (b) => !!document.querySelector(b), HEAD('close|pr'));
    await pg.click(HEAD('close|pr'));
    await until(
      pg,
      () =>
        !!document.querySelector(
          '[data-testid="run-group"] .kit-btn:not([disabled])',
        ) &&
        [...document.querySelectorAll('.cb-plan-step .cb-cmd')].some((e) =>
          e.textContent.includes('first note'),
        ),
    );
    // A step with a public comment is a 44px row like the rest, its
    // comment on a fixed line of its own under it, there before it runs.
    const pub = await pg.evaluate(() => {
      const rows = [...document.querySelectorAll('.cb-plan .cb-plan-step')];
      const lines = [...document.querySelectorAll('.cb-plan .cb-plan-pub')];
      const h = (e) => Math.round(e.getBoundingClientRect().height);
      return {
        rows: rows.map(h),
        lines: lines.map(h),
        text: lines.map((e) => e.textContent).join(' | '),
      };
    });
    check(
      `review: a step with a comment is a 44px row, its comment whole on a fixed 44px line under it (rows ${pub.rows.join('/')}, lines ${pub.lines.join('/')}: ${pub.text})`,
      pub.rows.length > 0 &&
        pub.rows.every((x) => x === 44) &&
        pub.lines.length === 1 &&
        pub.lines.every((x) => x === 44) &&
        pub.text.includes('first note'),
    );
    // Another tab re-decides it with a new closing comment: the command
    // changes, and this page still shows the first. The list reloads on
    // the event (its buttons off until it is in); the press waits for it.
    const reloaded = pg.waitForResponse(
      (r) => r.url().includes('/api/items') && r.url().includes('to-apply'),
    );
    await agent.api('POST', '/api/decide', {
      keys: [CPR],
      disposition: 'close',
      note: 'second note',
    });
    await reloaded;
    await until(
      pg,
      () =>
        !!document.querySelector(
          '[data-testid="run-group"] .kit-btn:not([disabled])',
        ),
    );
    await pg.waitForTimeout(300); // kept: a window for the event's reloads to settle
    // The press stores the plan; its reply is held while "a" is pressed.
    let release;
    const held = new Promise((r) => (release = r));
    await pg.route('**/api/apply/plan', async (route) => {
      if (route.request().postDataJSON()?.preview) return route.continue();
      await held;
      await route.continue();
    });
    const stored = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') &&
        r.request().method() === 'POST' &&
        !r.request().postDataJSON()?.preview,
    );
    await pg.click(RUN_BTN);
    await pressWithFocus(pg, 'a');
    release();
    await stored;
    const shown = await until(
      pg,
      () =>
        [...document.querySelectorAll('.cb-plan-step .cb-cmd')].some((e) =>
          e.textContent.includes('second note'),
        ) &&
        (
          document.querySelector('[data-testid="review-group"] .cb-apply-note')
            ?.textContent ?? ''
        ).includes('changed since you looked'),
    );
    const now = await cmds();
    check(
      `a press on a plan that changed shows the new commands with the note (${now.join(' | ')})`,
      shown && now.some((c) => c.includes('second note')),
    );
    check(
      `nothing was approved: not by the press, not by "a" pressed while it was stored (${approves.length})`,
      approves.length === 0,
    );
    await pg.unroute('**/api/apply/plan');
    // "a" now runs what is drawn, and only that.
    const drawn = await cmds();
    const approved = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/approve') &&
        r.request().method() === 'POST',
    );
    await pressWithFocus(pg, 'a');
    const job = (await (await approved).json()).job ?? {};
    const ran = (job.steps ?? []).map((x) => x.command);
    check(
      `"a" then runs exactly the plan on the page (${ran.join(' | ')})`,
      ran.length > 0 && ran.join('\n') === drawn.join('\n'),
    );
  } finally {
    clearInterval(keep);
    await pg.close();
  }
}

// ---- what stands in the way ------------------------------------------------
// Court 2026-10-18: two PR closes failed because their repos are archived;
// review didn't say so. A held item shows in review under Held, with why.
const T11_PR = 'pr:schuettc/t11-archived#3';
const T11_REPO = 'repo:schuettc/t11-dormant';
const HOLDS_SEED = {
  seedRepos: [
    dormant('t11-dormant'),
    {
      repo: 'schuettc/t11-archived',
      archived: true,
      pushed_at: '2024-01-10T00:00:00Z',
      default_branch: 'main',
      prs: [
        {
          repo: 'schuettc/t11-archived',
          number: 3,
          title: 'old fix',
          author: 'bob',
          state: 'OPEN',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      issues: [],
    },
  ],
};
async function holdsScenario(context, t, s) {
  const { check, until } = t;
  console.log('\nscenario: review and the item page say what holds an item');
  const agent = createAgent(s.base, s.token);
  await agent.api('POST', '/api/decide', {
    keys: [T11_REPO],
    disposition: 'archive',
  });
  await agent.api('POST', '/api/decide', {
    keys: [T11_PR],
    disposition: 'close',
    note: 'stale',
  });
  const pg = await context.newPage();
  try {
    await pg.goto(s.url + '#/review', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await pg.waitForSelector(HEAD('close|pr'), { timeout: 8000 });
    await pg.click(HEAD('close|pr'));
    const held = await until(
      pg,
      () => {
        const doc = document.querySelector('[data-testid="review-group"]');
        return (
          !!doc &&
          doc.querySelector('.cb-held-h')?.textContent === 'held \u00b7 1' &&
          (doc.textContent ?? '').includes(
            'schuettc/t11-archived is archived: GitHub refuses any change to it',
          )
        );
      },
      null,
      8000,
    );
    check(
      "review shows an archived repo's PR under held with its reason",
      held,
    );

    // Tick an item in each group: one review of both (ticking close|pr
    // unfolded it; archive|repo starts folded).
    await clearTicks(t, pg);
    await pg.click('.cb-apply-part[data-part="archive|repo"] .cb-group-caret');
    for (const k of [T11_PR, T11_REPO]) {
      await until(
        pg,
        (key) =>
          !!document.querySelector(
            `.cb-apply-list .kit-row[data-key="${key}"]`,
          ),
        k,
      );
      await pg.click(`.cb-apply-list .kit-row[data-key="${k}"] .kit-box`);
    }
    const combined = await until(
      pg,
      () => {
        const doc = document.querySelector('[data-testid="review-group"]');
        return (
          doc?.querySelector('.cb-mid-kick')?.textContent ===
            'review \u00b7 2 ticked in 2 groups' &&
          !!doc.querySelector('.cb-tags-line .cb-tag-github-undo') &&
          !!doc.querySelector('.cb-held-row')
        );
      },
      null,
      8000,
    );
    check(
      'ticking two groups makes one review: "review \u00b7 2 ticked in 2 groups", an "undo on GitHub" tag in its summary',
      combined,
    );

    await pg.goto(s.url + '#/decide/' + T11_PR, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const inTheWay = await until(
      pg,
      () =>
        document.querySelector('.cb-hold-who')?.textContent === 'in the way' &&
        (document.querySelector('.cb-hold-line')?.textContent ?? '').includes(
          'is archived',
        ),
      null,
      8000,
    );
    check('the item page says what is in the way', inTheWay);
  } finally {
    await pg.close();
  }
}

// ---- one frame: every tab's lines at the same place and height -------------
// Spec one-frame (Court, 2026-10-19): decide, review and run share one list
// pane, its top block 178px, a group's head 32px, a row 44px; ticked items
// show in the middle with every line at a fixed place; labels lower case.
// Four landed branches (the starter rule recommends deleting them): one
// run (done), one waiting in review, two left to decide.
const FR = (b) => `branch:schuettc/fr-local@${b}`;
const FRAME_SEED = {
  seedClones: [
    { name: 'fr-local', branches: ['feat/a', 'feat/b', 'feat/c', 'feat/d'] },
  ],
};
async function frameScenario(context, t, s) {
  const { check, until, eventually } = t;
  console.log('\nscenario: one frame — decide, review and run line up');
  const agent = createAgent(s.base, s.token);
  const api = (m, p, b) => agent.api(m, p, b);
  await api('POST', '/api/decide', {
    keys: [FR('feat/a'), FR('feat/b'), FR('feat/d')],
    disposition: 'delete',
  });
  // feat/d runs beside feat/a: "its job" shows it as a neighbour.
  const plan = await api('POST', '/api/apply/plan', {
    keys: [FR('feat/a'), FR('feat/d')],
  });
  await api('POST', '/api/apply/approve', {
    plan_id: plan.job.id,
    session: '',
  });
  await eventually(async () => {
    const v = await api('GET', '/api/items?view=run');
    return (v.items ?? []).some(
      (it) => it.key === FR('feat/a') && it.group === 'done',
    );
  }, 15000);
  const pg = await context.newPage();
  await pg.setViewportSize({ width: 1280, height: 800 });
  try {
    await pg.goto(`${s.url}#/decide`, { waitUntil: 'domcontentloaded' });
    const tabs = ['decide', 'review', 'run'];
    const go = async (tab) => {
      await pg.evaluate((h) => {
        location.hash = h;
      }, `#/${tab}`);
      await until(
        pg,
        (tb) =>
          document.querySelector('.kit-ctl.on')?.dataset.id === tb &&
          !!document.querySelector(`.cb-pane-${tb} .cb-group`) &&
          !!document.querySelector(`.cb-pane-${tb}`)?.offsetParent,
        tab,
        8000,
      );
    };
    // The visible pane's geometry: its top block, first group, heads, rows.
    const geo = (tab) =>
      pg.evaluate((tb) => {
        const pane = document.querySelector(`.cb-pane-${tb}`);
        const r = (e) => e.getBoundingClientRect();
        return {
          top: r(pane.querySelector('.kit-lh')).height,
          first: r(pane.querySelector('.cb-group')).top,
          heads: [...pane.querySelectorAll('.cb-group-top')].map(
            (e) => r(e).height,
          ),
          rows: [...pane.querySelectorAll('.kit-rows > .kit-row')].map(
            (e) => r(e).height,
          ),
        };
      }, tab);
    // Open one group per tab: decide's rule group, review's waiting group,
    // run's done.
    const openGroup = async (tab, sel) => {
      const caret = `.cb-pane-${tab} ${sel} .cb-group-caret`;
      await pg.waitForSelector(caret, { timeout: 8000 });
      if (
        (await pg.$eval(caret, (e) => e.getAttribute('aria-expanded'))) !==
        'true'
      )
        await pg.click(caret);
      await until(
        pg,
        (q) => !!document.querySelector(q),
        `.cb-pane-${tab} .kit-rows > .kit-row`,
        8000,
      );
    };
    const groupOf = {
      decide: '.cb-group[data-rule="landed-branches"]',
      review: '.cb-group[data-group="delete|branch"]',
      run: '.cb-group[data-group="done"]',
    };
    const g = {};
    for (const tab of tabs) {
      await go(tab);
      await openGroup(tab, groupOf[tab]);
      g[tab] = await geo(tab);
    }
    check(
      `frame: the top block is 178px on decide, review and run (${tabs.map((x) => g[x].top).join(', ')})`,
      tabs.every((x) => g[x].top === 178),
    );
    check(
      `frame: the first group starts at the same y on all three tabs (${tabs.map((x) => g[x].first).join(', ')})`,
      Math.max(...tabs.map((x) => g[x].first)) -
        Math.min(...tabs.map((x) => g[x].first)) <
        1,
    );
    check(
      `frame: every group head is the same height on all three tabs (${tabs.map((x) => g[x].heads.join('/')).join(', ')})`,
      tabs.every(
        (x) => g[x].heads.length > 0 && g[x].heads.every((h) => h === 32),
      ),
    );
    check(
      `frame: every row is 44px on all three tabs (${tabs.map((x) => [...new Set(g[x].rows)].join('/')).join(', ')})`,
      tabs.every(
        (x) => g[x].rows.length > 0 && g[x].rows.every((h) => h === 44),
      ),
    );

    // One item ticked per tab: the middle's lines sit at one place.
    const tickKey = {
      decide: FR('feat/c'),
      review: FR('feat/b'),
      run: FR('feat/a'),
    };
    const mid = {};
    for (const tab of tabs) {
      await go(tab);
      await pg.click(
        `.cb-pane-${tab} .kit-row[data-key="${tickKey[tab]}"] .kit-box`,
      );
      await until(
        pg,
        () =>
          [
            '.cb-mid-kick',
            '.cb-mid-title',
            '.cb-mid-ctx',
            '.cb-mid-acts',
          ].every(
            (q) => !!document.querySelector(`.kit-read:not([hidden]) ${q}`),
          ) &&
          (document.querySelector('.kit-read:not([hidden]) .cb-mid-acts')
            ?.children.length ?? 0) > 0,
        undefined,
        8000,
      );
      mid[tab] = await pg.evaluate(() =>
        ['.cb-mid-kick', '.cb-mid-title', '.cb-mid-ctx', '.cb-mid-acts'].map(
          (q) => {
            const b = document
              .querySelector(`.kit-read:not([hidden]) ${q}`)
              .getBoundingClientRect();
            return [Math.round(b.top), Math.round(b.height)];
          },
        ),
      );
    }
    const same = tabs.every(
      (x) => JSON.stringify(mid[x]) === JSON.stringify(mid.decide),
    );
    check(
      `frame: ticked lines sit at the same y on decide, review and run (${tabs.map((x) => JSON.stringify(mid[x])).join(' ')})`,
      same && mid.decide.map((m) => m[1]).join(',') === '16,30,20,60',
    );

    await go('decide');
    const head = `.cb-pane-decide ${groupOf.decide}`;
    // Leaving a tab cleared its ticks: they covered what it showed.
    check(
      'frame: coming back to decide, its ticks were cleared when it was left',
      await until(
        pg,
        (hd) =>
          !!document.querySelector(hd) &&
          !document.querySelector(
            '.cb-pane-decide .kit-row .kit-box[aria-checked="true"]',
          ) &&
          !!document.querySelector(`${hd} .cb-group-ticked`)?.hidden,
        head,
      ),
    );
    await pg.click(
      `.cb-pane-decide .kit-row[data-key="${tickKey.decide}"] .kit-box`,
    );
    await until(
      pg,
      (hd) => !document.querySelector(`${hd} .cb-group-ticked`)?.hidden,
      head,
    );
    check(
      "frame: decide's group head shows only its ticks",
      (await pg.$$(`${head} .kit-btn`)).length === 0 &&
        (await pg.$eval(`${head} .cb-group-ticked`, (e) => e.textContent)) ===
          '1 ticked \u00b7 untick',
    );

    await go('run');
    const row = `.cb-pane-run .kit-row[data-key="${FR('feat/a')}"]`;
    const said = await pg.$eval(
      `${row} .kit-title`,
      (e) => e.textContent ?? '',
    );
    await pg.click(`${row} .kit-kicker`);
    check(
      `frame: run lists the item that ran, with its job ("${said}"), and opening it shows what ran and its job`,
      / \u00b7 job #\d+$/.test(said) &&
        (await until(
          pg,
          () =>
            !!document.querySelector('[data-testid="what-ran"] .cb-step') &&
            !!document.querySelector('[data-testid="its-job"] .cb-here'),
          undefined,
          8000,
        )),
    );
    const ranHead = await pg.evaluate(() =>
      ['.cb-mid-kick', '.cb-mid-title', '.cb-mid-ctx'].map((q) =>
        Math.round(
          document.querySelector(`.cb-ran ${q}`)?.getBoundingClientRect()
            .height ?? -1,
        ),
      ),
    );
    check(
      `frame: the run item's head is the fixed lines, 16, 30 and 20px (${ranHead.join(', ')})`,
      ranHead.join(',') === '16,30,20',
    );
    const neighbours = await pg.evaluate(() => {
      const rows = [
        ...document.querySelectorAll(
          '[data-testid="its-job"] .cb-step:not(.cb-here)',
        ),
      ];
      return {
        rows: rows.length,
        buttons: rows.reduce(
          (n, r) => n + r.querySelectorAll('button').length,
          0,
        ),
      };
    });
    check(
      `frame: "its job" shows its other items' steps read-only, no buttons (${neighbours.rows} rows, ${neighbours.buttons} buttons)`,
      neighbours.rows > 0 && neighbours.buttons === 0,
    );

    const lower = [];
    for (const tab of tabs) {
      await go(tab);
      lower.push(
        await pg.evaluate(() => {
          const el = document.createElement('p');
          el.className = 'kit-label';
          el.textContent = 'what ran';
          document.querySelector('.kit-read:not([hidden])')?.append(el);
          const tt = getComputedStyle(el).textTransform;
          el.remove();
          return tt;
        }),
      );
    }
    check(
      `frame: headings are lower case (${lower.join(', ')})`,
      lower.every((x) => x === 'none'),
    );

    // The foot: "show N more" has its own place, at the foot's right end,
    // apart from the observations' line, the same on every tab.
    const foot = {};
    for (const tab of tabs) {
      await go(tab);
      foot[tab] = await pg.evaluate((tb) => {
        const f = document.querySelector(`.cb-pane-${tb} .cb-pane-foot`);
        const more = f.querySelector('.cb-foot-more');
        const obs = f.querySelector('.cb-apply-obs');
        more.hidden = false;
        more.textContent = 'show 200 more';
        obs.hidden = false;
        const r = (e) => e.getBoundingClientRect();
        const out = {
          right: Math.round(r(f).right - r(more).right),
          gap: Math.round(r(more).left - r(obs).right),
          top: Math.round(r(more).top),
        };
        more.hidden = true;
        return out;
      }, tab);
    }
    check(
      `frame: "show N more" sits at the foot's right end, apart from the observations, at one place on every tab (${tabs.map((x) => JSON.stringify(foot[x])).join(' ')})`,
      tabs.every(
        (x) =>
          foot[x].right === 0 &&
          foot[x].gap >= 16 &&
          foot[x].top === foot.decide.top,
      ),
    );

    // At Court's width (1352px) every button of a ticked document is
    // whole: the buttons' block wraps onto its fixed second line.
    await pg.setViewportSize({ width: 1352, height: 900 });
    // With a session attached: decide's line holds "ask agent" too.
    const FS = 'probe-frame-pi';
    await agent.presence(FS, 'pi \u00b7 frame', '/home/court/frame', 'pi');
    const keepFS = setInterval(
      () =>
        void agent.presence(FS, 'pi \u00b7 frame', '/home/court/frame', 'pi'),
      1000,
    );
    const cut = {};
    for (const tab of tabs) {
      await go(tab);
      await openGroup(tab, groupOf[tab]);
      const box = `.cb-pane-${tab} .kit-row[data-key="${tickKey[tab]}"] .kit-box`;
      await pg.waitForSelector(box, { timeout: 8000 });
      if (
        (await pg.$eval(box, (e) => e.getAttribute('aria-checked'))) !== 'true'
      )
        await pg.click(box);
      await until(
        pg,
        () =>
          (document
            .querySelector('.kit-read:not([hidden]) .cb-mid-acts')
            ?.querySelectorAll('button').length ?? 0) > 0,
        undefined,
        8000,
      );
      cut[tab] = await pg.evaluate(() => {
        const acts = document.querySelector(
          '.kit-read:not([hidden]) .cb-mid-acts',
        );
        const read = document.querySelector('.kit-read:not([hidden])');
        const a = acts.getBoundingClientRect();
        const rd = read.getBoundingClientRect();
        const bad = [...acts.querySelectorAll('button')]
          .filter((b) => b.offsetParent)
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return (
              r.left < a.left - 0.5 ||
              r.right > a.right + 0.5 ||
              r.top < a.top - 0.5 ||
              r.bottom > a.bottom + 0.5 ||
              r.right > rd.right + 0.5
            );
          })
          .map((b) => b.textContent.trim());
        return { bad, h: Math.round(a.height) };
      });
    }
    check(
      `frame: at 1352x900 every button of the ticked document is whole, the buttons' block one height on every tab (${tabs.map((x) => `${x} ${cut[x].h}px cut [${cut[x].bad.join(', ')}]`).join('; ')})`,
      tabs.every((x) => cut[x].bad.length === 0 && cut[x].h === cut.decide.h),
    );
    clearInterval(keepFS);
    await pg.setViewportSize({ width: 1280, height: 800 });
  } finally {
    await pg.close();
  }
}

// ---- review follows the ticks it has ---------------------------------------
// Court 2026-10-20: a search hid the ticked items and the middle pane kept
// the old plan, its button off; a refused run said nothing that stayed.
const STALE_SEED = {
  seedClones: [{ name: 'st-local', branches: ['feat/a', 'feat/b'] }],
};
const ST = (b) => `branch:schuettc/st-local@${b}`;
async function staleScenario(context, t, s) {
  const { check, until } = t;
  console.log('\nscenario: review — the middle follows the ticks it has');
  const agent = createAgent(s.base, s.token);
  await agent.api('POST', '/api/decide', {
    keys: [ST('feat/a'), ST('feat/b')],
    disposition: 'delete',
  });
  const SEARCH = '.cb-pane-review input[placeholder="search by key or title"]';
  const RUN_ON = `${RUN_BTN}:not([disabled])`;
  const pg = await context.newPage();
  await pg.setViewportSize({ width: 1600, height: 900 });
  try {
    await pg.goto(`${s.url}#/review`, { waitUntil: 'domcontentloaded' });
    await until(pg, (b) => !!document.querySelector(b), HEAD('delete|branch'));
    await pg.click(HEAD('delete|branch'));
    await until(pg, (b) => !!document.querySelector(b), RUN_ON, 8000);

    // A run serve refuses says why, the words stay once the page has
    // settled (the stored plan's events reload the list), and the button
    // is on again for the next press.
    const WORDS = 'probe: serve refused this run';
    await pg.route('**/api/apply/approve', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: WORDS }),
      }),
    );
    t.expectError('status of 409');
    const refused = pg.waitForResponse((r) =>
      r.url().includes('/api/apply/approve'),
    );
    await pg.click(`${RUN_BTN}.fill`);
    await refused;
    await pg.waitForTimeout(1500); // kept: a window for the stored plan's events and reloads to settle
    const after = await pg.evaluate(
      ([w, b]) => {
        const el = [
          ...document.querySelectorAll(
            '[data-testid="review-group"] .cb-apply-note',
          ),
        ].find((e) => e.textContent.includes(w));
        return {
          seen: !!el && !!el.offsetParent,
          on: !!document.querySelector(b),
        };
      },
      [WORDS, RUN_ON],
    );
    check(
      'review: a refused run says why, and it is still on the page once it settles',
      after.seen,
    );
    check(
      'review: after a refused run its button is on again for the next press',
      after.on,
    );
    await pg.unroute('**/api/apply/approve');

    // Then a search that hides the ticked items: the ticks go, and the
    // middle shows review's summary, not the old plan or its button.
    await pg.fill(SEARCH, 'zz-matches-nothing');
    const settled = await until(
      pg,
      () =>
        !document.querySelector('.cb-pane-review .kit-row[data-key]') &&
        !!document.querySelector('[data-testid="review-overview"]') &&
        !document.querySelector('[data-testid="review-group"]') &&
        !document.querySelector('[data-testid="run-group"]'),
      undefined,
      8000,
    );
    check(
      'review: a search that hides the ticked items shows the summary, not the old plan or its run button',
      settled,
    );
    await pg.fill(SEARCH, '');
  } finally {
    await pg.close();
  }
}
