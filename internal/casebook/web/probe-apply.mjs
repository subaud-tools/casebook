// probe-apply.mjs — apply's probe scenarios (Task 9), run by
// probe.mjs with its check helpers (t.check, t.checkList, t.until,
// t.eventually).
//
// Each scenario group starts its own serve (serve.mjs) with its own data:
// real clones under the serve's temp home with landed branches (seedClones:
// the casebook lane's git runs there and nowhere else), dormant repos and a
// bot's PR in the GitHub cache (seedRepos). serve's gh is the probe's fake
// (serve.mjs): nothing the probe starts reaches GitHub, and every gh call
// serve makes is checked. The agent is the fake agent (agent.mjs) over
// serve's own routes: presence, casebook_job_step, casebook_job_ask.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServe, probeGit } from './serve.mjs';
import { createAgent } from './agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hashOf = (f) =>
  createHash('sha256').update(readFileSync(f)).digest('hex');

const SESSION = 'probe-t9-pi';
const LABEL = 'pi \u00b7 t9-apply';
const OTHER = 'probe-t9-other';
const OTHER_LABEL = 'claude \u00b7 elsewhere';

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
// Decided only once the first job holds the other five: an item in an
// unfinished job can't be planned again, so the second plan is of this.
const REPO_C = 'repo:schuettc/t9-dormant-c';

// The page's state, read in one place.
const read = {
  primary: (pg) =>
    pg.$eval('.kit-primary', (e) => (e.hidden ? '' : e.textContent.trim())),
  attached: (pg) =>
    pg.$eval('[data-testid="composer-attached"]', (e) => e.textContent),
  cards: (pg) =>
    pg.$$eval('.cb-job .cb-needs-card', (els) =>
      els.map((e) => e.dataset.kind),
    ),
  step: (pg, id) =>
    pg
      .$eval(`.cb-steps .cb-step[data-step="${id}"]`, (e) => ({
        state: e.dataset.state,
        glyph: e.querySelector('.cb-step-g').textContent,
        text: e.querySelector('.cb-step-t').textContent,
        undo: !!e.querySelector('.cb-undo'),
      }))
      .catch(() => null),
};

// evalNow finds an element and reads it in one go, in the page. Playwright's
// $eval finds it and reads it in two calls, so a live redraw between them
// (the running job redraws on every step event) hands the read a detached
// element: no computed colours, no size, no focus. The selector must be
// CSS, and the read takes no argument.
function evalNow(pg, selector, read) {
  const sel = JSON.stringify(selector);
  return pg.evaluate(`(() => {
    const e = document.querySelector(${sel});
    if (!e) throw new Error('no element matches ' + ${JSON.stringify(sel)});
    return (${read.toString()})(e);
  })()`);
}

// cssColor resolves a CSS colour expression to its computed rgb() string.
function cssColor(pg, expr) {
  return pg.evaluate((e) => {
    const d = document.createElement('div');
    d.style.color = e;
    document.body.append(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  }, expr);
}

const pressWithFocus = async (pg, k) => {
  await pg.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.body.dispatchEvent(new FocusEvent('focus'));
  });
  await pg.keyboard.press(k);
};

// inThemes shows the page light and dark (or only the themes named),
// asserting the theme took and that nothing is focused (a focused control's
// ring is the probe's click, not the page).
async function inThemes(t, pg, name, themes = ['light', 'dark']) {
  const bgs = { light: 'rgb(244, 245, 248)', dark: 'rgb(20, 22, 29)' };
  for (const theme of themes) {
    for (let i = 0; i < 3; i++) {
      const th = await pg.evaluate(
        () => document.documentElement.dataset.theme,
      );
      if (th === theme) break;
      await pg.click('button.kit-ctl:has-text("theme")');
    }
    const got = await pg.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    await pg.evaluate(() => document.activeElement?.blur());
    const focused = await pg.evaluate(
      () => document.activeElement === document.body,
    );
    t.check(
      `the ${name} view is ${theme} (theme ${got.theme}, body ${got.bg}), nothing focused`,
      got.theme === theme && got.bg === bgs[theme] && focused,
    );
  }
  for (let i = 0; i < 3; i++) {
    const th = await pg.evaluate(() => document.documentElement.dataset.theme);
    if (th === 'light') break;
    await pg.click('button.kit-ctl:has-text("theme")');
  }
}

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
  // A browser context of their own: another scenario's fake clock (a
  // context's clock is shared by its pages) must not age these pages'
  // observations, and the foot reads the real, advancing time.
  const context = await shared.browser().newContext();
  try {
    await applyScenariosIn(context, t);
  } finally {
    await context.close();
  }
}

// PROBE_SCENARIO (with PROBE_ONLY=apply) runs only the scenario groups
// whose name has it: main, stale, list, nothing.
const runs = (name) =>
  !process.env.PROBE_SCENARIO || name.includes(process.env.PROBE_SCENARIO);

async function applyScenariosIn(context, t) {
  const groups = [
    ['main', T9_SEED, applyScenariosOn],
    [
      'stale',
      { seedRepos: [dormant('t9-stale')], syncInterval: '2s' },
      staleScenario,
    ],
    ['list', T11_SEED, listScenario],
    ['nothing', { seedRepos: [dormant('t10-nothing')] }, nothingToPlanScenario],
  ];
  for (const [name, seed, run] of groups) {
    if (!runs(name)) continue;
    const s = await ownServe(seed);
    try {
      await run(context, t, s);
    } finally {
      s.stop();
      serves = serves.filter((x) => x !== s);
    }
  }
}

// nothingToPlanScenario: a tab still offers a group's plan when another
// has just planned it (it hasn't heard yet: its live wire is cut here, so
// the race is certain). Its press makes no plan: serve refuses, naming the
// plan that holds the item, and the tab says so in serve's words without
// offering "sync first" (a sync wouldn't help) and stops offering the
// group.
async function nothingToPlanScenario(context, t, serveHandle) {
  const { check, checkList, until } = t;
  console.log(
    '\nscenario: apply — a group another tab planned first makes no plan',
  );
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const ITEM = 'repo:schuettc/t10-nothing';
  await agent.api('POST', '/api/decide', {
    keys: [ITEM],
    disposition: 'archive',
  });
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  const BUTTON = '.cb-apply-part[data-part="archive|repo"] .cb-group-plan';
  try {
    // The tab hears nothing live: the stream and the poll both fail.
    await pg.route(/\/api\/(events|state)/, (r) => r.abort());
    await pg.setViewportSize({ width: 1600, height: 900 });
    await pg.goto(serveHandle.url + '#/apply', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    check(
      'the tab offers the group\'s plan ("Archive 1 repo\u2026")',
      await until(
        pg,
        (b) =>
          document.querySelector(b)?.textContent === 'Archive 1 repo\u2026',
        BUTTON,
      ),
    );
    // Another tab plans it first.
    const other = await agent.api('POST', '/api/apply/plan', { all: true });
    checkList(
      'another tab plans it first',
      (other?.job?.steps ?? []).map((st) => st.key),
      [ITEM],
    );
    const resp = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') && r.request().method() === 'POST',
    );
    await pg.click(BUTTON);
    const r = await resp;
    const body = await r.json().catch(() => ({}));
    check(
      `serve refuses it, naming the plan that holds it (${r.status()}: ${body.error ?? ''})`,
      r.status() === 409 &&
        (body.error ?? '').startsWith(
          `${ITEM} is already in plan #${other.job.id}`,
        ),
    );
    const jobs = (await agent.api('GET', '/api/jobs')).jobs ?? [];
    checkList(
      'it makes no plan: serve has only the first',
      jobs.map((j) => `#${j.id} ${j.state} ${(j.steps ?? []).length}`),
      [`#${other.job.id} planned 1`],
    );
    const said =
      !!body.error &&
      (await until(
        pg,
        (w) =>
          document.querySelector('[data-testid="plan-nothing"]')
            ?.textContent === w,
        body.error,
      ));
    check(`the tab shows serve's words ("${body.error}")`, said);
    const state = await pg.evaluate(() => ({
      refusal: !!document.querySelector('[data-testid="refusal"]'),
      primary: (() => {
        const p = document.querySelector('.kit-primary');
        return p && !p.hidden ? p.textContent : '';
      })(),
      hash: location.hash,
    }));
    check(
      `no "sync first" (a sync wouldn't help), no plan opened (${state.hash})`,
      !state.refusal &&
        state.primary !== 'Sync first' &&
        state.hash === '#/apply',
    );
    check(
      'and the group is no longer offered: its item is in a plan, a row of its own',
      await until(
        pg,
        ([b, id]) =>
          !document.querySelector(b) &&
          !!document.querySelector(`.cb-apply-list .kit-row[data-job="${id}"]`),
        [BUTTON, other.job.id],
      ),
    );
    check(`no page errors (${errors.join(' | ')})`, errors.length === 0);
  } finally {
    await pg.close();
  }
}

// listScenario: apply is one list. No view chips: running jobs on top, each
// with a progress bar that moves as the agent reports, then the decided
// items waiting, grouped by what will happen under a button that opens the
// group's plan ("Delete 3 branches\u2026"), then Done, collapsed, last. Nothing
// runs from the list. A decision made in another tab raises a group's count
// live, and the waiting strip's "apply" opens the group it joined.
const T11 = 't11-local';
const T11_SEED = {
  seedClones: [{ name: T11, branches: ['feat/a', 'feat/b', 'feat/c'] }],
  seedRepos: [
    dormant('t11-x'),
    dormant('t11-y'),
    {
      repo: 'schuettc/t11-prs',
      pushed_at: '2026-09-20T00:00:00Z',
      default_branch: 'main',
      prs: [3, 4].map((number) => ({
        repo: 'schuettc/t11-prs',
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
async function listScenario(context, t, serveHandle) {
  const { check, checkList, until, eventually } = t;
  console.log(
    '\nscenario: apply — one list: running, the waiting groups, Done',
  );
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const job = (id) => agent.api('GET', `/api/job?id=${id}`);
  const B = (b) => `branch:schuettc/${T11}@${b}`;
  const X = 'repo:schuettc/t11-x';
  const Y = 'repo:schuettc/t11-y';
  const S = 'probe-t11-pi';
  const here = () =>
    agent.presence(S, 'pi \u00b7 t11', '/home/court/t11', 'pi');
  await here();
  const keep = setInterval(() => void here(), 1000);
  const pg = await context.newPage();
  const pg2 = await context.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg2.on('pageerror', (e) => errors.push(`tab 2: ${e}`));
  try {
    // A finished job: feat/c deleted (the casebook lane runs it at once).
    await agent.api('POST', '/api/decide', {
      keys: [B('feat/c')],
      disposition: 'delete',
    });
    const doneJob = await agent.api('POST', '/api/apply/plan', {
      keys: [B('feat/c')],
    });
    await agent.api('POST', '/api/apply/approve', {
      plan_id: doneJob.job.id,
      session: '',
    });
    await eventually(
      async () => (await job(doneJob.job.id)).job.state === 'done',
      10000,
    );
    // A running job: both PRs closed, waiting on the agent.
    const PRS = ['pr:schuettc/t11-prs#3', 'pr:schuettc/t11-prs#4'];
    await agent.api('POST', '/api/decide', { keys: PRS, disposition: 'close' });
    const runJob = await agent.api('POST', '/api/apply/plan', { keys: PRS });
    await agent.api('POST', '/api/apply/approve', {
      plan_id: runJob.job.id,
      session: S,
    });
    // Waiting: the other two branches. (feat/c is in the group too: an
    // applied item waits until a sync observes it gone.)
    await agent.api('POST', '/api/decide', {
      keys: [B('feat/a'), B('feat/b')],
      disposition: 'delete',
    });

    await pg.setViewportSize({ width: 1600, height: 900 });
    await pg.goto(serveHandle.url + '#/apply', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const parts = () =>
      pg.$$eval('.cb-apply-list .cb-apply-part', (els) =>
        els.map(
          (e) =>
            `${e.dataset.part} ${(e.querySelector('.cb-group-label') ?? e.querySelector('.cb-group-plan'))?.textContent} ${e.querySelector('.cb-group-n').textContent}${e.classList.contains('collapsed') ? ' collapsed' : ''}${e.querySelector('.cb-group-plan') && e.querySelector('.cb-group-label') ? ' [label and button]' : ''}`,
        ),
      );
    const want = [
      'running Running 1',
      'delete|branch Delete 3 branches\u2026 3',
      'done Done 1 collapsed',
    ];
    await until(
      pg,
      (n) => document.querySelectorAll('.cb-apply-part').length === n,
      want.length,
    );
    checkList(
      'one list: Running, the waiting group whose header is its button, Done collapsed and last',
      await parts(),
      want,
    );
    const top = await pg.evaluate(() => ({
      chips: document.querySelectorAll('.cb-apply-list .kit-chip').length,
      text: document.body.innerText,
      approve: [...document.querySelectorAll('.cb-apply-list button')]
        .map((b) => b.textContent)
        .filter((t) => /approve|run/i.test(t)),
      primary: (() => {
        const p = document.querySelector('.kit-primary');
        return p && !p.hidden ? p.textContent : '';
      })(),
      runRow: document
        .querySelector('.cb-apply-list .kit-row[data-job]')
        ?.getBoundingClientRect().top,
      heads: [...document.querySelectorAll('.cb-apply-part')]
        .filter((e) => e.dataset.part !== 'running')
        .map((e) => e.getBoundingClientRect().top),
    }));
    check(`apply has no view chips (${top.chips})`, top.chips === 0);
    check(
      'nothing on the page says "To apply" or "ready"',
      !/to apply|\bready\b/i.test(top.text),
    );
    check(
      `the running job's row is above every group (${top.runRow}; ${top.heads.join(', ')})`,
      top.runRow !== undefined && top.heads.every((y) => y > top.runRow),
    );
    check(
      `nothing runs from the list: no approve or run there, no primary (${top.approve.join(', ') || 'none'}; "${top.primary}")`,
      top.approve.length === 0 && top.primary === '',
    );
    // The running job's bar moves as the agent reports its steps.
    const bar = () =>
      pg.evaluate(
        (id) =>
          document
            .querySelector(`.cb-apply-list .kit-row[data-job="${id}"] .cb-pb`)
            ?.getAttribute('aria-valuenow') ?? '',
        runJob.job.id,
      );
    const bar0 = await bar();
    const step0 = runJob.job.steps[0];
    for (const state of ['started', 'reported'])
      await agent.api('POST', '/api/agent/job-step', {
        session: S,
        job: runJob.job.id,
        step: step0.id,
        state,
      });
    check(
      `the running job's progress bar rises live as a step is reported (aria-valuenow ${bar0} → 1)`,
      bar0 === '0' &&
        (await until(
          pg,
          (id) =>
            document
              .querySelector(`.cb-apply-list .kit-row[data-job="${id}"] .cb-pb`)
              ?.getAttribute('aria-valuenow') === '1',
          runJob.job.id,
        )),
    );
    // Ticking names the ticked: "Delete 1 branch\u2026".
    await pg.click(
      `.cb-apply-list .kit-row[data-key="${B('feat/a')}"] .kit-box`,
    );
    check(
      'ticking one item names it on the group button ("Delete 1 branch\u2026")',
      await until(
        pg,
        () =>
          document.querySelector(
            '.cb-apply-part[data-part="delete|branch"] .cb-group-plan',
          )?.textContent === 'Delete 1 branch\u2026' &&
          document
            .querySelector(
              '.cb-apply-part[data-part="delete|branch"] .cb-group-box',
            )
            ?.getAttribute('aria-checked') === 'mixed',
      ),
    );
    await pg.click(
      `.cb-apply-list .kit-row[data-key="${B('feat/a')}"] .kit-box`,
    );
    await until(
      pg,
      () =>
        document.querySelector(
          '.cb-apply-part[data-part="delete|branch"] .cb-group-plan',
        )?.textContent === 'Delete 3 branches\u2026',
    );
    await inThemes(t, pg, 'apply list');

    // The group's button opens its plan: each item's command and undo,
    // where it runs, approve and run.
    const planResp = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/plan') && r.request().method() === 'POST',
    );
    await pg.click('.cb-apply-part[data-part="delete|branch"] .cb-group-plan');
    const planBody = await (await planResp).json();
    const planId = planBody.job?.id;
    const opened = await until(
      pg,
      (id) =>
        location.hash === `#/apply/${id}` &&
        document.querySelector('.cb-plan')?.dataset.job === String(id),
      planId,
    );
    const plan = await pg.evaluate(() => ({
      keys: [
        ...new Set(
          [...document.querySelectorAll('.cb-plan-step')].map(
            (e) => e.dataset.key,
          ),
        ),
      ].sort(),
      cmds: [...document.querySelectorAll('.cb-plan-step .cb-cmd')].map(
        (e) => e.textContent,
      ),
      undo: [...document.querySelectorAll('[data-testid="plan-undo"]')].map(
        (e) => e.textContent.trim(),
      ),
      where: [...document.querySelectorAll('[data-testid="plan-where"]')].map(
        (e) => e.textContent,
      ),
      approve: [...document.querySelectorAll('.cb-approve .kit-btn')].map(
        (b) => b.textContent,
      ),
    }));
    checkList(
      "the group's button plans its items",
      plan.keys,
      [B('feat/a'), B('feat/b'), B('feat/c')].sort(),
    );
    check(
      `the plan opens in the middle pane with each item's exact command, serve's (${plan.cmds.length})`,
      opened &&
        plan.cmds.length > 0 &&
        plan.cmds.join('\n') ===
          planBody.groups
            .flatMap((g) => g.steps.map((s) => s.command))
            .join('\n'),
    );
    checkList(
      "each group says where it runs and whether it can be undone, in serve's words",
      plan.undo,
      planBody.groups.map((g) => g.undo),
    );
    check(
      `a local group runs here and can be undone (${plan.where.join(' | ')})`,
      plan.where.length > 0 &&
        plan.where.every(
          (w) => w.startsWith('Runs here, on ') && w.includes('Can be undone'),
        ),
    );
    checkList('the plan offers approve and run', plan.approve, [
      'approve and run',
      'discard',
    ]);
    checkList(
      "the plan's items leave their group: the plan is its own row",
      await parts(),
      [
        'running Running 1',
        'plans Plans to approve 1',
        'done Done 1 collapsed',
      ],
    );
    check(
      'the plan is not approved from the list (serve still has it planned)',
      (await job(planId)).job.state === 'planned',
    );
    await pg.click('.cb-approve .kit-btn:has-text("discard")');
    check(
      'discarding it brings the group back',
      await until(
        pg,
        () =>
          location.hash === '#/apply' &&
          document.querySelector(
            '.cb-apply-part[data-part="delete|branch"] .cb-group-plan',
          )?.textContent === 'Delete 3 branches\u2026',
      ),
    );

    // A decision in a second tab raises a group's count without a reload,
    // and its strip's apply opens that group.
    await pg.evaluate(() => {
      window.__sameLoad = true;
    });
    await pg2.setViewportSize({ width: 1600, height: 900 });
    await pg2.goto(`${serveHandle.url}#/item/${encodeURIComponent(X)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await pg2.click('.cb-decide-row .cb-choice[data-d="archive"]');
    check(
      'a decision in a second tab shows as a group here, live ("Archive 1 repo\u2026")',
      await until(
        pg,
        () =>
          window.__sameLoad === true &&
          document.querySelector(
            '.cb-apply-part[data-part="archive|repo"] .cb-group-plan',
          )?.textContent === 'Archive 1 repo\u2026',
      ),
    );
    await agent.api('POST', '/api/decide', {
      keys: [Y],
      disposition: 'archive',
    });
    check(
      "another raises the group's count, still without a reload",
      await until(
        pg,
        () =>
          window.__sameLoad === true &&
          document.querySelector(
            '.cb-apply-part[data-part="archive|repo"] .cb-group-n',
          )?.textContent === '2',
      ),
    );
    const href = await pg2
      .locator('.cb-strip a')
      .getAttribute('href')
      .catch(() => null);
    await pg2.click('.cb-strip a').catch(() => {});
    check(
      `the strip's apply opens the group it joined (${href})`,
      href === '#/apply?group=archive%7Crepo' &&
        (await until(
          pg2,
          () =>
            document.querySelector('.cb-apply-part.cb-focus')?.dataset.part ===
            'archive|repo',
        )),
    );
    // Done opens when asked.
    await pg.click('.cb-apply-part[data-part="done"] .cb-group-caret');
    check(
      'Done opens to its finished job',
      await until(
        pg,
        (id) =>
          !!document.querySelector(
            `.cb-apply-list .kit-row[data-job="${id}"]`,
          ) &&
          !document
            .querySelector('.cb-apply-part[data-part="done"]')
            ?.classList.contains('collapsed'),
        doneJob.job.id,
      ),
    );
    check(`no page errors (${errors.join(' | ')})`, errors.length === 0);
  } finally {
    clearInterval(keep);
    await pg.close();
    await pg2.close();
  }
}

async function applyScenariosOn(context, t, serveHandle) {
  const { check, checkList, until, eventually } = t;
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const job = (id) => agent.api('GET', `/api/job?id=${id}`);
  const stepFor = (jv, key, action) =>
    jv.job.steps.find((s) => s.key === key && (!action || s.action === action));
  const home = serveHandle.home;

  // Court's decisions: the landed branches deleted, a dormant repo
  // archived, the bot's PR closed with a comment; one more dormant repo
  // stays decided but unplanned (for the keys check).
  await agent.api('POST', '/api/decide', {
    keys: [BR('feat/l1'), BR('feat/l2')],
    disposition: 'delete',
  });
  await agent.api('POST', '/api/decide', {
    keys: [REPO_A, REPO_B],
    disposition: 'archive',
  });
  await agent.api('POST', '/api/decide', {
    keys: [PR],
    disposition: 'close',
    note: 'superseded by #9',
  });

  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  try {
    await pg.setViewportSize({ width: 1600, height: 900 });
    await pg.goto(serveHandle.url + '#/apply', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // ---- the waiting groups and a plan -----------------------------------
    console.log('\nscenario: apply — the waiting groups and a plan');
    check(
      'the bar counts the decided items waiting to be applied ("apply 5")',
      await until(
        pg,
        () =>
          document.querySelector('.kit-ctl[data-id="apply"] .kit-n')
            ?.textContent === '5',
      ),
    );
    await until(
      pg,
      () => document.querySelectorAll('.cb-apply-list .kit-row').length === 5,
    );
    const readyKeys = await pg.$$eval('.cb-apply-list .kit-row', (els) =>
      els.map((e) => e.dataset.key),
    );
    const served = await agent.api('GET', '/api/items?view=to-apply');
    checkList(
      "the list holds serve's to-apply items, group by group in its order",
      readyKeys,
      served.items.map((i) => i.key),
    );
    const groupButtons = () =>
      pg.$$eval('.cb-apply-part', (els) =>
        els.map(
          (e) =>
            `${e.dataset.part} ${e.querySelector('.cb-group-plan')?.textContent ?? ''}`,
        ),
      );
    checkList(
      "the groups are serve's, each under its button, named for what will happen",
      await groupButtons(),
      [
        'archive|repo Archive 2 repos\u2026',
        'close|pr Close 1 PR\u2026',
        'delete|branch Delete 2 branches\u2026',
      ],
    );
    check(
      'nothing runs from the list: no primary',
      (await read.primary(pg)) === '',
    );
    // Tick two rows: their groups' buttons name the ticked.
    await pg.click(`.cb-apply-list .kit-row[data-key="${REPO_B}"] .kit-box`);
    await pg.click(`.cb-apply-list .kit-row[data-key="${PR}"] .kit-box`);
    check(
      'ticked, a group button names the ticked items ("Archive 1 repo\u2026")',
      await until(
        pg,
        () =>
          document.querySelector(
            '.cb-apply-part[data-part="archive|repo"] .cb-group-plan',
          )?.textContent === 'Archive 1 repo\u2026' &&
          document
            .querySelector('.cb-apply-part[data-part="close|pr"] .cb-group-box')
            ?.getAttribute('aria-checked') === 'true',
      ),
    );
    const signalC = await cssColor(pg, 'var(--kit-signal)');
    const boxC = await pg.$eval(
      '.cb-apply-part[data-part="close|pr"] .cb-group-box',
      (e) => getComputedStyle(e).backgroundColor,
    );
    check(
      `a ticked group's box is in signal, the selection's colour (${boxC})`,
      boxC === signalC,
    );
    await pg.click(`.cb-apply-list .kit-row[data-key="${REPO_B}"] .kit-box`);
    await pg.click(`.cb-apply-list .kit-row[data-key="${PR}"] .kit-box`);

    // A group's button, pressed twice fast: one plan, of that group.
    const planPosts = [];
    const onPlanPost = (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/apply/plan'))
        planPosts.push(r.url());
    };
    pg.on('request', onPlanPost);
    const branchResp = pg.waitForResponse((r) =>
      r.url().includes('/api/apply/plan'),
    );
    await pg.click('.cb-apply-part[data-part="delete|branch"] .cb-group-plan', {
      clickCount: 2,
    });
    const branchPlan = await (await branchResp).json();
    // Kept: the check is that the second press posts nothing; a window for
    // a second POST to go out.
    await pg.waitForTimeout(500);
    pg.off('request', onPlanPost);
    check(
      `a double press of a group's button asks serve once (${planPosts.length} POST /api/apply/plan)`,
      planPosts.length === 1 &&
        ((await agent.api('GET', '/api/jobs')).jobs ?? []).length === 1,
    );
    checkList(
      "it plans the group's items",
      [...new Set(branchPlan.job.steps.map((s) => s.key))].sort(),
      [BR('feat/l1'), BR('feat/l2')],
    );
    check(
      `the plan opens as #/apply/${branchPlan.job.id}, local, "approve and run"`,
      (await until(
        pg,
        (id) =>
          location.hash === `#/apply/${id}` &&
          document.querySelector('.cb-plan')?.dataset.job === String(id),
        branchPlan.job.id,
      )) &&
        (await pg.$$eval('.cb-approve .kit-btn', (bs) =>
          bs.map((b) => b.textContent).join(','),
        )) === 'approve and run,discard' &&
        (await read.primary(pg)) === 'Approve and run',
    );
    await pg.click('.cb-approve .kit-btn:has-text("discard")');
    await until(
      pg,
      () =>
        document.querySelector(
          '.cb-apply-part[data-part="delete|branch"] .cb-group-plan',
        )?.textContent === 'Delete 2 branches\u2026',
    );

    // One plan of every group (serve's plan all), opened by its address:
    // the rest of this scenario runs it.
    const planView = await agent.api('POST', '/api/apply/plan', { all: true });
    const jobId = planView.job.id;
    await pg.evaluate((id) => {
      location.hash = `#/apply/${id}`;
    }, jobId);
    check(
      `the plan opens as #/apply/${jobId}`,
      await until(
        pg,
        (id) =>
          location.hash === `#/apply/${id}` &&
          document.querySelector('.cb-plan')?.dataset.job === String(id),
        jobId,
      ),
    );
    check(
      'its items leave their groups: the plan is a row under "Plans to approve", no group waits',
      await until(
        pg,
        (id) =>
          [...document.querySelectorAll('.cb-apply-part')]
            .map((e) => e.dataset.part)
            .join(',') === 'plans' &&
          !!document.querySelector(`.cb-apply-list .kit-row[data-job="${id}"]`),
        jobId,
      ),
    );
    checkList(
      "each group of the plan says whether it can be undone, in serve's words",
      await pg.$$eval('[data-testid="plan-undo"]', (els) =>
        els.map((e) => e.textContent.trim()),
      ),
      planView.groups.map((g) => g.undo),
    );
    // Every step shows serve's exact command, grouped as serve groups them.
    const shown = await pg.$$eval('.cb-plan-group', (gs) =>
      gs.map((g) => ({
        action: g.dataset.action,
        lane: g.dataset.lane,
        steps: [...g.querySelectorAll('.cb-plan-step')].map((s) => ({
          key: s.dataset.key,
          command: s.querySelector('.cb-cmd').textContent,
        })),
      })),
    );
    const want = planView.groups.map((g) => ({
      action: g.action,
      lane: g.lane,
      steps: g.steps.map((s) => ({ key: s.key, command: s.command })),
    }));
    checkList(
      "the plan's groups are serve's, in its order",
      shown.map((g) => `${g.lane} ${g.action} ${g.steps.length}`),
      want.map((g) => `${g.lane} ${g.action} ${g.steps.length}`),
    );
    checkList(
      "building a plan shows exact commands: every step's command is serve's, verbatim",
      shown.flatMap((g) => g.steps.map((s) => `${s.key} :: ${s.command}`)),
      want.flatMap((g) => g.steps.map((s) => `${s.key} :: ${s.command}`)),
    );
    const cmds = shown.flatMap((g) => g.steps.map((s) => s.command));
    check(
      `the commands are git's and gh's own (${cmds.length} steps: update-ref -d, push, gh pr close, gh repo archive)`,
      cmds.length === 7 &&
        cmds.some(
          (c) => c.startsWith('git -C ') && c.includes(' update-ref -d '),
        ) &&
        cmds.some((c) => c.startsWith('git -C ') && c.includes(' push ')) &&
        cmds.some((c) =>
          c.startsWith(
            "gh pr close 7 -R 'schuettc/t9-prs' --comment 'superseded by #9'",
          ),
        ) &&
        cmds.some((c) =>
          c.startsWith("gh repo archive 'schuettc/t9-dormant-a'"),
        ),
    );
    const laneColours = await pg.$$eval('.cb-group-label .cb-lanename', (els) =>
      els.map((e) => `${e.textContent}=${getComputedStyle(e).color}`),
    );
    const signal = await cssColor(pg, 'var(--kit-signal)');
    const agentC = await cssColor(pg, 'var(--kit-agent)');
    check(
      `lane labels keep their colours: casebook · local signal, pi · outward agent (${laneColours.join(', ')})`,
      laneColours.length === 4 &&
        laneColours.every((c) =>
          c.startsWith('casebook \u00b7 local=')
            ? c.endsWith(`=${signal}`)
            : c.endsWith(`=${agentC}`),
        ),
    );
    // No session is here: approving is impossible on the page.
    check(
      'with outward steps and no session here there is no approve: the page says so, and no primary',
      (await until(
        pg,
        () => !!document.querySelector('[data-testid="no-session"]'),
      )) &&
        !(await pg.$('.cb-approve .kit-btn.fill')) &&
        (await read.primary(pg)) === '',
    );
    const noSession = await pg.$eval(
      '[data-testid="no-session"]',
      (e) => e.textContent,
    );
    check(
      `its verb agrees with the count ("${noSession}")`,
      noSession.startsWith(
        'The 3 outward steps go to an agent session, and none is here.',
      ),
    );
    await pressWithFocus(pg, 'a');
    await pg.waitForTimeout(400); // kept: "a" must approve nothing; a window for it
    check(
      '"a" with no session approves nothing (serve still has a plan)',
      (await job(jobId)).job.state === 'planned',
    );

    // Two sessions attach: the picker lists them; Court picks pi's.
    await agent.presence(SESSION, LABEL, '/home/court/t9', 'pi');
    await agent.presence(OTHER, OTHER_LABEL, '/home/court/else', 'claude');
    const keep = setInterval(() => {
      void agent.presence(SESSION, LABEL, '/home/court/t9', 'pi');
      void agent.presence(OTHER, OTHER_LABEL, '/home/court/else', 'claude');
    }, 1000);
    try {
      check(
        'the session picker lists the present sessions',
        await until(
          pg,
          ([a, b]) => {
            const ls = [
              ...document.querySelectorAll(
                '[data-testid="session-picker"] .cb-session',
              ),
            ].map((e) => e.textContent);
            return ls.length === 2 && ls.includes(a) && ls.includes(b);
          },
          // Named by folder (they have no pi name), as the dock names them.
          ['t9', 'else'],
          8000,
        ),
      );
      const picker = await pg.evaluate(() => ({
        checked: [
          ...document.querySelectorAll(
            '.cb-session[aria-checked="true"], .cb-session.on',
          ),
        ].length,
        approve: [...document.querySelectorAll('.cb-approve .kit-btn')].map(
          (b) => b.textContent,
        ),
        pick: document.querySelector('[data-testid="pick-session"]')
          ?.textContent,
        what: document.querySelector('.cb-approve-what')?.textContent,
      }));
      check(
        `with two sessions here none is chosen for Court: no session marked, no approve, only discard (${picker.approve.join(',')}; "${picker.pick}")`,
        picker.checked === 0 &&
          picker.approve.join(',') === 'discard' &&
          picker.pick === '2 sessions are here and none is chosen yet.' &&
          (await read.primary(pg)) === '',
      );
      check(
        `the sentence's verb agrees ("${picker.what}")`,
        picker.what ===
          '7 steps \u00b7 4 local \u00b7 3 outward. The 3 outward steps go to:',
      );
      await pressWithFocus(pg, 'a');
      check(
        '"a" with no session chosen is refused: the page says why, serve still has a plan',
        (await until(
          pg,
          () =>
            document.querySelector('.cb-approve .cb-apply-note')
              ?.textContent ===
            'not approved: no session is chosen for the outward steps',
        )) && (await job(jobId)).job.state === 'planned',
      );
      await pg.click(`.cb-session[data-session="${SESSION}"]`);
      check(
        'choosing a session marks it, and the primary is "Approve and run"',
        await until(
          pg,
          (id) =>
            document
              .querySelector(`.cb-session[data-session="${id}"]`)
              ?.getAttribute('aria-checked') === 'true' &&
            document.querySelector('.kit-primary')?.textContent ===
              'Approve and run',
          SESSION,
        ),
      );
      checkList(
        "the outward groups name the chosen session's agent",
        await pg.$$eval('.cb-group-label .cb-lanename-agent', (els) =>
          els.map((e) => e.textContent),
        ),
        ['pi \u00b7 outward', 'pi \u00b7 outward'],
      );
      check(
        'with a session chosen the plan offers approve and discard',
        (await pg.$$eval('.cb-approve .kit-btn', (bs) =>
          bs.map((b) => b.textContent).join(','),
        )) === 'approve and run,discard',
      );
      const planTitle = await pg.$eval(
        '.cb-plan .kit-h1',
        (e) => e.textContent,
      );
      check(
        `the plan is attached to the composer with its title ("${await read.attached(pg)}")`,
        (await read.attached(pg)) ===
          `job #${jobId} \u00b7 ${planTitle.toLowerCase()}`,
      );
      // The screenshot: the plan's groups and commands, and approve with
      // its session picker.
      await pg.$eval('[data-testid="approve"]', (e) =>
        e.scrollIntoView({ block: 'end' }),
      );
      await inThemes(t, pg, 'plan');

      // Approve from the keyboard: "a" is To apply's approve here (Attention
      // and Rules bind "a" too).
      await pressWithFocus(pg, 'a');
      check(
        `approving starts a job: serve has job ${jobId} approved for ${SESSION}`,
        await eventually(async () => {
          const j = (await job(jobId)).job;
          return j.state !== 'planned' && j.session === SESSION;
        }),
      );
      check(
        'the job opens, listed under Running on top, its primary "Pause job"',
        await until(
          pg,
          (id) =>
            document.querySelector('.cb-job')?.dataset.job === String(id) &&
            document.querySelector('.cb-apply-part')?.dataset.part ===
              'running' &&
            document.querySelector('.cb-apply-list .kit-row')?.dataset.job ===
              String(id) &&
            document.querySelector('.kit-primary')?.textContent === 'Pause job',
          jobId,
          8000,
        ),
      );

      // The section fills the list and reading columns, as Rules does.
      const geo = await pg.evaluate(() => {
        const r = (sel) => {
          const b = document.querySelector(sel).getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        };
        return {
          list: r('.cb-apply-list'),
          read: r('.cb-apply-read'),
          doc: r('.cb-apply-read .kit-doc'),
          rail: r('.kit-rail'),
          bar: r('.kit-bar'),
          others: [...document.querySelectorAll('.kit-app > .kit-list')]
            .filter((e) => !e.classList.contains('cb-apply-list'))
            .map((e) => getComputedStyle(e).display),
        };
      });
      check(
        `the list is the 400 px list column, bar to bottom; the job the reading column; the document 640 px, centred (${JSON.stringify(geo.list)} ${JSON.stringify(geo.read)} ${geo.doc.w})`,
        geo.list.x === 0 &&
          geo.list.w === 400 &&
          geo.list.y === geo.bar.h &&
          geo.list.y + geo.list.h === 900 &&
          geo.read.x === 400 &&
          geo.read.x + geo.read.w === geo.rail.x &&
          geo.doc.w === 640 &&
          Math.abs(geo.doc.x - (geo.read.x + (geo.read.w - 640) / 2)) <= 1,
      );
      check(
        `decide's list is not displayed (${geo.others.join(',')})`,
        geo.others.length === 1 && geo.others.every((d) => d === 'none'),
      );

      // The casebook lane runs, for real, in the probe's clone.
      let jv = await job(jobId);
      const l1 = stepFor(jv, BR('feat/l1'), 'branch-delete-local');
      const l1r = stepFor(jv, BR('feat/l1'), 'branch-delete-remote');
      const prStep = stepFor(jv, PR);
      const repoA = stepFor(jv, REPO_A);
      check(
        'the local steps verify live: ✓ "deleted · verified" in the steps table',
        await until(
          pg,
          (id) =>
            document.querySelector(`.cb-step[data-step="${id}"]`)?.dataset
              .state === 'verified',
          l1.id,
          10000,
        ),
      );
      const l1Row = await read.step(pg, l1.id);
      check(
        `the verified local step reads ✓ deleted · verified (${l1Row?.glyph} ${l1Row?.text})`,
        l1Row?.glyph === '\u2713' && l1Row?.text === 'deleted \u00b7 verified',
      );
      // Live step events redraw the table, so a row looked up and then read in
      // separate round trips can be detached by then (its computed colour is
      // ''). Look it up and read it in one evaluate, until a connected row reads.
      const tones = await pg
        .waitForFunction(
          (id) => {
            const e = document.querySelector(`.cb-step[data-step="${id}"]`);
            const g = e?.querySelector('.cb-step-g');
            const t = e?.querySelector('.cb-step-t');
            if (!g?.isConnected || !t?.isConnected) return null;
            return {
              glyph: getComputedStyle(g).color,
              text: getComputedStyle(t).color,
            };
          },
          l1.id,
          { timeout: 5000 },
        )
        .then((h) => h.jsonValue())
        .catch(() => ({ glyph: '', text: '' }));
      const okC = await cssColor(pg, 'var(--kit-ok)');
      const mutedC = await cssColor(pg, 'var(--kit-muted)');
      check(
        `only the glyph carries the step's tone: ✓ in ok (${tones.glyph}), its text muted (${tones.text})`,
        tones.glyph === okC && tones.text === mutedC && okC !== mutedC,
      );
      check(
        'the casebook lane deleted feat/l1 in the probe clone (git, in the temp home)',
        gitIn(home, 't9-local', 'rev-parse --verify refs/heads/feat/l1') ===
          null &&
          gitIn(home, 't9-local', 'rev-parse --verify refs/heads/main') !==
            null,
      );
      check(
        'the pending agent steps read · next and · queued',
        await until(
          pg,
          ([a, b]) => {
            const t = (id) =>
              document.querySelector(`.cb-step[data-step="${id}"] .cb-step-t`)
                ?.textContent;
            return t(a) === 'next' && t(b) === 'queued';
          },
          [prStep.id, repoA.id],
        ),
      );

      // The list row: its lanes, the bar, n/total, what needs Court. Steps
      // keep finishing while this reads, so read the row and serve's job until
      // both are from the same moment (the row's n/total equals serve's count).
      const readRow = () =>
        evalNow(pg, `.cb-apply-list .kit-row[data-job="${jobId}"]`, (e) => ({
          lanes: [...e.querySelectorAll('.cb-lanename')].map(
            (l) => `${l.textContent}=${getComputedStyle(l).color}`,
          ),
          bar: [...e.querySelectorAll('.cb-pb > span')].map(
            (s) => `${s.className}=${getComputedStyle(s).backgroundColor}`,
          ),
          barH: e.querySelector('.cb-pb')?.getBoundingClientRect().height,
          meta: e.querySelector('.kit-meta')?.textContent,
          sub: e.querySelector('.kit-sub')?.textContent,
          subColour: e.querySelector('.kit-sub')
            ? getComputedStyle(e.querySelector('.kit-sub')).color
            : '',
        }));
      const finishedOf = (v) =>
        v.job.steps.filter((s) =>
          ['verified', 'reported', 'skipped', 'failed'].includes(s.state),
        ).length;
      let row;
      let finished;
      for (let i = 0; i < 50; i++) {
        row = await readRow();
        jv = await job(jobId);
        finished = finishedOf(jv);
        if (row.meta === `${finished}/${jv.job.steps.length}`) break;
        await pg.waitForTimeout(100); // kept: the poll's interval (it breaks when they agree)
      }
      checkList('the row names its lanes in their colours', row.lanes, [
        `casebook \u00b7 local=${signal}`,
        `pi \u00b7 outward=${agentC}`,
      ]);
      check(
        `the row has a thin bar, the casebook lane's part in signal (${row.bar.join(', ')}; ${row.barH}px) and n/total ${row.meta}`,
        row.barH === 3 &&
          row.bar.length === 1 &&
          row.bar[0] === `cb-pb-casebook=${signal}` &&
          row.meta === `${finished}/${jv.job.steps.length}`,
      );
      check(
        `what needs Court is a signal line ("${row.sub}")`,
        row.sub === '1 needs you' && row.subColour === signal,
      );

      // The batch card: confirm.
      check(
        'a batch card needs Court (signal edge): confirm · skip batch',
        (await until(
          pg,
          () => !!document.querySelector('.cb-needs-card[data-kind="batch"]'),
        )) &&
          (await pg.$eval('.cb-needs-card[data-kind="batch"]', (e) =>
            [...e.querySelectorAll('.kit-btn')]
              .map((b) => b.textContent)
              .join(' \u00b7 '),
          )) === 'confirm \u00b7 skip batch',
      );
      await pg.click(
        '.cb-needs-card[data-kind="batch"] .kit-btn:has-text("confirm")',
      );
      check(
        'confirming clears the batch card (serve answered it)',
        (await until(
          pg,
          () => !document.querySelector('.cb-needs-card[data-kind="batch"]'),
        )) &&
          (await eventually(async () =>
            ((await job(jobId)).needs_you ?? []).every(
              (c) => c.kind !== 'batch',
            ),
          )),
      );

      // ---- pause and resume --------------------------------------------
      console.log('\nscenario: apply — pause and resume');
      await pg.click('.kit-primary');
      check(
        'primary "Pause job" pauses it (serve) and becomes "Resume"',
        (await eventually(
          async () => (await job(jobId)).job.paused === true,
        )) &&
          (await until(
            pg,
            () =>
              document.querySelector('.kit-primary')?.textContent === 'Resume',
          )),
      );
      check(
        'the paused job says so in its kicker',
        (await pg.$eval('.cb-job .kit-kick', (e) => e.textContent)).endsWith(
          '\u00b7 paused',
        ),
      );
      await pressWithFocus(pg, 'p');
      check(
        '"p" resumes it: serve has it running, the primary is "Pause job" again',
        (await eventually(
          async () => (await job(jobId)).job.paused === false,
        )) &&
          (await until(
            pg,
            () =>
              document.querySelector('.kit-primary')?.textContent ===
              'Pause job',
          )),
      );

      // ---- a burst of live events -----------------------------------------
      console.log('\nscenario: apply — a burst of live events');
      // Kept: the resume's own reloads settle, so the count below is the
      // burst's alone.
      await pg.waitForTimeout(500);
      const fetched = [];
      const onFetch = (r) => {
        const u = r.url();
        if (/\/api\/(jobs|job|needs-you)(\?|$)/.test(u))
          fetched.push(new URL(u).pathname);
      };
      pg.on('request', onFetch);
      // 30 job events about the open job, at once (a resume of a job that
      // isn't paused changes nothing and announces it), then a pause.
      const BURST = 30;
      await Promise.all(
        Array.from({ length: BURST }, () =>
          agent.api('POST', '/api/jobs/resume', { id: jobId }),
        ),
      );
      await agent.api('POST', '/api/jobs/pause', { id: jobId });
      const settled = await until(
        pg,
        () => document.querySelector('.kit-primary')?.textContent === 'Resume',
      );
      // Kept: the check bounds how many fetches the burst makes; a window
      // for any extra one to go out.
      await pg.waitForTimeout(600);
      pg.off('request', onFetch);
      check(
        `${BURST + 1} live events fetch a bounded few times, one reload in flight and one queued (${fetched.length} fetches), and the page ends current (paused)`,
        settled && fetched.length >= 1 && fetched.length <= 4,
      );
      check(
        `an event about a job fetches that job only, never the whole list (${[...new Set(fetched)].join(', ')})`,
        fetched.every((p) => p === '/api/job'),
      );
      await agent.api('POST', '/api/jobs/resume', { id: jobId });
      await until(
        pg,
        () =>
          document.querySelector('.kit-primary')?.textContent === 'Pause job',
      );

      // ---- a stale reload never draws over a newer one ------------------
      console.log('\nscenario: apply — reloads in order');
      // Kept: the reloads before this settle, so the one held is the event's.
      await pg.waitForTimeout(500);
      // Hold every /api/job reload: the first (running) is released after
      // Court's own pause has drawn, the rest after the check.
      const heldJob = [];
      await pg.route(/\/api\/job\?/, async (route) => {
        const resp = await route.fetch();
        const body = await resp.text();
        heldJob.push(() =>
          route.fulfill({ response: resp, body }).catch(() => {}),
        );
      });
      // An event about the job (a resume that changes nothing): a reload,
      // held, whose reply says running.
      await agent.api('POST', '/api/jobs/resume', { id: jobId });
      const heldOne = await eventually(async () => heldJob.length >= 1);
      // Court pauses: serve's reply (paused) draws.
      await pg.click('.kit-primary');
      const pausedDrawn = await until(
        pg,
        () => document.querySelector('.kit-primary')?.textContent === 'Resume',
      );
      await heldJob.shift()?.();
      // Kept: the older reply must not be drawn; a window for it to be.
      await pg.waitForTimeout(500);
      const after = await read.primary(pg);
      const kick = await pg.$eval('.cb-job .kit-kick', (e) => e.textContent);
      for (const f of heldJob.splice(0)) await f();
      await pg.unroute(/\/api\/job\?/);
      check(
        `an older reload (running) answered after Court's pause (paused) is not drawn (primary "${after}", kicker "${kick}")`,
        heldOne && pausedDrawn && after === 'Resume' && kick.endsWith('paused'),
      );
      await pg.click('.kit-primary');
      await eventually(async () => (await job(jobId)).job.paused === false);
      await until(
        pg,
        () =>
          document.querySelector('.kit-primary')?.textContent === 'Pause job',
      );

      // ---- a needs-you card (spec §10) ----------------------------------
      console.log('\nscenario: apply — a needs-you card');
      await agent.api('POST', '/api/agent/job-step', {
        session: SESSION,
        job: jobId,
        step: prStep.id,
        state: 'started',
      });
      const draft =
        'Closing this: lodash 4.17.21 is already on main through #9. Thanks!';
      await agent.api('POST', '/api/agent/job-ask', {
        session: SESSION,
        job: jobId,
        step: prStep.id,
        question: "public comment on someone else's repo",
        text: draft,
      });
      check(
        'a needs-you card offers the four actions (a fake casebook_job_ask)',
        (await until(
          pg,
          () => !!document.querySelector('.cb-needs-card[data-kind="text"]'),
          undefined,
          8000,
        )) &&
          (await evalNow(pg, '.cb-needs-card[data-kind="text"]', (e) =>
            [...e.querySelectorAll('.kit-btn')]
              .map((b) => b.textContent)
              .join(' \u00b7 '),
          )) ===
            'post and close \u00b7 edit text \u00b7 close without comment \u00b7 skip',
      );
      const textCard = await evalNow(
        pg,
        '.cb-needs-card[data-kind="text"]',
        (e) => ({
          edge: getComputedStyle(e).borderLeftColor,
          edgeW: getComputedStyle(e).borderLeftWidth,
          head: e.querySelector('.kit-card-head').textContent,
          quote: e.querySelector('blockquote').textContent,
          what: e.querySelector('.cb-needs-what').textContent,
          fill: e.querySelector('.kit-btn.fill')?.textContent,
        }),
      );
      check(
        `the card has a signal edge (${textCard.edge}, ${textCard.edgeW}) and quotes the exact text`,
        textCard.edge === signal &&
          textCard.edgeW === '3px' &&
          textCard.quote === draft &&
          textCard.fill === 'post and close',
      );
      check(
        `it says what and where ("${textCard.head}"; "${textCard.what}")`,
        textCard.head ===
          "needs you \u00b7 public comment on someone else's repo" &&
          textCard.what === 'schuettc/t9-prs#7 \u00b7 close with comment',
      );
      await pg.$eval('.cb-job .kit-kick', (e) =>
        e.scrollIntoView({ block: 'start' }),
      );
      await inThemes(t, pg, 'job');
      // edit text: the text becomes a field; saving sends it to serve.
      await pg.click(
        '.cb-needs-card[data-kind="text"] .kit-btn:has-text("edit text")',
      );
      const edited = 'Closing: already on main through #9.';
      const field = '.cb-needs-card[data-kind="text"] textarea.cb-needs-edit';
      await pg.fill(field, '');
      await pg.keyboard.type('Closing: already ');
      // While Court types, the job moves: a step starts (a step event) and
      // job events arrive; each redraws the open job.
      const fieldBefore = await pg.$(field);
      await agent.api('POST', '/api/agent/job-step', {
        session: SESSION,
        job: jobId,
        step: repoA.id,
        state: 'started',
      });
      for (let i = 0; i < 5; i++)
        await agent.api('POST', '/api/jobs/resume', { id: jobId });
      const redrawn = await until(
        pg,
        (id) =>
          document.querySelector(`.cb-step[data-step="${id}"]`)?.dataset
            .state === 'running',
        repoA.id,
      );
      // Kept: the redraw must not replace the field; a window for a late one.
      await pg.waitForTimeout(300);
      const replaced = await pg.evaluate(
        ([el, sel]) => el !== document.querySelector(sel),
        [fieldBefore, field],
      );
      await pg.keyboard.type('on main through #9.');
      const ed = await evalNow(pg, field, (e) => ({
        value: e.value,
        focused: document.activeElement === e,
        caret: e.selectionStart,
      })).catch(() => ({ value: '(no field)', focused: false, caret: -1 }));
      check(
        `typing in "edit text" while step events redraw the job: the text, focus and caret survive ("${ed.value}", focused ${ed.focused}, caret ${ed.caret}; redrawn ${redrawn && replaced})`,
        redrawn &&
          replaced &&
          ed.value === edited &&
          ed.focused &&
          ed.caret === edited.length,
      );
      await pg.click(
        '.cb-needs-card[data-kind="text"] .kit-btn:has-text("save text")',
      );
      check(
        'edit text saves the new text to serve; the card stays, quoting it',
        (await eventually(async () =>
          ((await job(jobId)).needs_you ?? []).some(
            (c) => c.kind === 'text' && c.text === edited,
          ),
        )) &&
          (await until(
            pg,
            (w) =>
              document.querySelector(
                '.cb-needs-card[data-kind="text"] blockquote',
              )?.textContent === w,
            edited,
          )),
      );
      await pg.click(
        '.cb-needs-card[data-kind="text"] .kit-btn:has-text("post and close")',
      );
      check(
        'answering closes the card: "post and close" clears it (page and serve)',
        (await until(
          pg,
          () => !document.querySelector('.cb-needs-card[data-kind="text"]'),
        )) &&
          (await eventually(async () =>
            ((await job(jobId)).needs_you ?? []).every(
              (c) => c.kind !== 'text',
            ),
          )),
      );
      check(
        'serve took the approved text for the step',
        await eventually(
          async () => stepFor(await job(jobId), PR).text === edited,
        ),
      );
      // The agent posts and reports; serve verifies with a fresh gh read
      // (the probe's fake gh) and the step advances.
      await agent.api('POST', '/api/agent/job-step', {
        session: SESSION,
        job: jobId,
        step: prStep.id,
        state: 'reported',
      });
      check(
        'the step advances: ✓ closed · verified',
        await until(
          pg,
          (id) =>
            document.querySelector(`.cb-step[data-step="${id}"] .cb-step-t`)
              ?.textContent === 'closed \u00b7 verified',
          prStep.id,
          8000,
        ),
      );
      checkList(
        'serve verified it with one gh read, to the probe fake (nothing else ran gh)',
        serveHandle.ghCalls(),
        ['pr view 7 -R schuettc/t9-prs --json state'],
      );

      // The agent pauses the step it started with its reason: an amber card.
      await agent.api('POST', '/api/agent/job-step', {
        session: SESSION,
        job: jobId,
        step: repoA.id,
        state: 'paused',
        detail: 'a reviewer commented 2 days ago, after you decided.',
      });
      check(
        'a paused step is an amber "pi paused" card: archive anyway (danger) · skip',
        (await until(
          pg,
          () => !!document.querySelector('.cb-needs-card[data-kind="paused"]'),
        )) &&
          (await evalNow(pg, '.cb-needs-card[data-kind="paused"]', (e) => {
            const bs = [...e.querySelectorAll('.kit-btn')];
            return [
              e.querySelector('.kit-card-head').textContent,
              getComputedStyle(e).borderLeftColor,
              bs
                .map(
                  (b) =>
                    b.textContent + (b.classList.contains('danger') ? '!' : ''),
                )
                .join(' \u00b7 '),
            ].join(' | ');
          })) === `pi paused | ${agentC} | archive anyway! \u00b7 skip`,
      );
      check(
        'the steps table shows it ‖ paused, and the row "1 paused"',
        (await until(
          pg,
          (id) =>
            document.querySelector(`.cb-step[data-step="${id}"] .cb-step-g`)
              ?.textContent === '\u2016',
          repoA.id,
        )) &&
          (await until(
            pg,
            (id) =>
              document.querySelector(
                `.cb-apply-list .kit-row[data-job="${id}"] .kit-sub`,
              )?.textContent === '1 paused',
            jobId,
          )),
      );
      await pg.click(
        '.cb-needs-card[data-kind="paused"] .kit-btn:has-text("skip")',
      );
      check(
        'skip clears the paused card and skips the step',
        (await until(
          pg,
          () => !document.querySelector('.cb-needs-card[data-kind="paused"]'),
        )) &&
          (await eventually(
            async () => stepFor(await job(jobId), REPO_A).state === 'skipped',
          )),
      );

      // ---- undo ----------------------------------------------------------
      console.log('\nscenario: apply — undo');
      jv = await job(jobId);
      const undoable = jv.job.steps.filter((s) => s.undoable).map((s) => s.id);
      const withUndo = await pg.$$eval('.cb-step', (els) =>
        els
          .filter((e) => e.querySelector('.cb-undo'))
          .map((e) => Number(e.dataset.step)),
      );
      checkList(
        'undo shows on exactly the finished steps serve can undo (the local deletes, not the closed PR)',
        withUndo,
        undoable,
      );
      check(
        '(serve can undo the local and remote deletes, not the PR)',
        undoable.includes(l1.id) &&
          undoable.includes(l1r.id) &&
          !undoable.includes(prStep.id),
      );
      const undoPost = pg.waitForResponse((r) =>
        r.url().includes('/api/jobs/undo'),
      );
      await pg.click(`.cb-step[data-step="${l1.id}"] .cb-undo`);
      const undoBody = (await undoPost).request().postDataJSON();
      check(
        `undo posts /api/jobs/undo for the step (${JSON.stringify(undoBody)})`,
        undoBody?.step === l1.id,
      );
      check(
        'serve restored feat/l1 in the probe clone (git branch, in the temp home)',
        await eventually(
          async () =>
            gitIn(home, 't9-local', 'rev-parse --verify refs/heads/feat/l1') ===
            l1.expected_tip,
        ),
      );
      check(
        'the step reads ↺ undone, with no undo',
        await until(
          pg,
          (id) => {
            const e = document.querySelector(`.cb-step[data-step="${id}"]`);
            return (
              e?.querySelector('.cb-step-t')?.textContent === 'undone' &&
              !e.querySelector('.cb-undo')
            );
          },
          l1.id,
        ),
      );

      // ---- sections: context, keys, primary -----------------------------
      console.log(
        '\nscenario: apply — only the active section feeds the composer',
      );
      check(
        'the open job is attached to the composer, with its title',
        (await read.attached(pg)) ===
          `job #${jobId} \u00b7 ${planTitle.toLowerCase()}`,
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
      const onAttention = await read.attached(pg);
      const primaryAttention = await read.primary(pg);
      check(
        `on decide the bar's primary is decide's, not "Pause job" ("${primaryAttention}")`,
        primaryAttention !== 'Pause job' && primaryAttention !== 'Resume',
      );
      // A live event under the hidden section: the job pauses.
      await agent.api('POST', '/api/jobs/pause', { id: jobId });
      // Kept: the hidden section's event must not change the line; a window
      // for the event to reach the page.
      await pg.waitForTimeout(800);
      check(
        `a live job event while To apply is hidden leaves the attached line alone ("${onAttention}")`,
        (await read.attached(pg)) === onAttention &&
          (await read.primary(pg)) === primaryAttention &&
          !onAttention.includes(`job #${jobId}`),
      );
      await pressWithFocus(pg, 'p');
      await pg.waitForTimeout(500); // kept: "p" must resume nothing; a window for it
      check(
        'on decide, "p" does not resume the hidden job',
        (await job(jobId)).job.paused === true,
      );
      await pg.evaluate((id) => {
        location.hash = `#/apply/${id}`;
      }, jobId);
      check(
        'back on To apply the job is attached again and the primary follows its state ("Resume")',
        await until(
          pg,
          (want) =>
            document.querySelector('[data-testid="composer-attached"]')
              ?.textContent === want &&
            document.querySelector('.kit-primary')?.textContent === 'Resume',
          `job #${jobId} \u00b7 ${planTitle.toLowerCase()}`,
        ),
      );
      const overlay = async () => {
        await pressWithFocus(pg, '?');
        await until(pg, () => !!document.querySelector('.kit-keys'));
        const labels = await pg.$$eval(
          '.kit-keys .kit-keys-row > span:last-child',
          (els) => els.map((e) => e.textContent),
        );
        await pg.keyboard.press('Escape');
        await until(pg, () => !document.querySelector('.kit-keys'));
        return labels;
      };
      const onApply = await overlay();
      check(
        `on apply the overlay lists its keys, not decide's (${onApply.join(', ')})`,
        onApply.includes('approve the open plan') &&
          onApply.includes('pause or resume the open job') &&
          !onApply.includes('accept proposal'),
      );
      await pressWithFocus(pg, 'p');
      check(
        'back on To apply, "p" resumes it',
        await eventually(async () => (await job(jobId)).job.paused === false),
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
      check(
        "on decide the primary isn't apply's",
        !['Pause job', 'Resume', 'Approve and run'].includes(
          await read.primary(pg),
        ),
      );

      // An item is in one unfinished job: job #1 is approved (running),
      // so its five items wait in no group; a sixth, decided now, is the
      // only one waiting, and its group's button plans it alone.
      console.log('\nscenario: apply — an item is in one unfinished job');
      await agent.api('POST', '/api/decide', {
        keys: [REPO_C],
        disposition: 'archive',
      });
      await pg.evaluate(() => {
        location.hash = '#/apply';
      });
      await until(
        pg,
        () =>
          document
            .querySelector('.kit-ctl[data-id="apply"]')
            ?.classList.contains('on') ?? false,
      );
      const heldOk = await until(
        pg,
        (c) =>
          [...document.querySelectorAll('.cb-apply-list .kit-row[data-key]')]
            .map((r) => r.dataset.key)
            .join(',') === c &&
          document.querySelector(
            '.cb-apply-part[data-part="archive|repo"] .cb-group-plan',
          )?.textContent === 'Archive 1 repo\u2026',
        REPO_C,
      );
      check(
        `the running job's five items wait in no group; only the new one does ("Archive 1 repo\u2026")`,
        heldOk,
      );
      const secondResp = pg.waitForResponse(
        (r) =>
          r.url().includes('/api/apply/plan') &&
          r.request().method() === 'POST',
      );
      await pg.click('.cb-apply-part[data-part="archive|repo"] .cb-group-plan');
      const second = await (await secondResp).json();
      checkList(
        'the group plans only the item no job holds',
        (second.job?.steps ?? []).map((st) => st.key),
        [REPO_C],
      );

      // A second plan: "a" on Attention doesn't approve it.
      await pg.evaluate((id) => {
        location.hash = `#/apply/${id}`;
      }, second.job.id);
      await until(
        pg,
        (id) => document.querySelector('.cb-plan')?.dataset.job === String(id),
        second.job.id,
      );
      await pg.click(`.cb-session[data-session="${SESSION}"]`);
      await until(
        pg,
        () =>
          document.querySelector('.kit-primary')?.textContent ===
          'Approve and run',
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
      await pg.waitForTimeout(600); // kept: "a" must approve nothing; a window for it
      check(
        'on decide, "a" does not approve the hidden open plan',
        (await job(second.job.id)).job.state === 'planned',
      );

      // ---- discarding a plan ---------------------------------------------
      console.log('\nscenario: apply — a plan can be discarded');
      await pg.evaluate((id) => {
        location.hash = `#/apply/${id}`;
      }, second.job.id);
      await until(
        pg,
        (id) => document.querySelector('.cb-plan')?.dataset.job === String(id),
        second.job.id,
      );
      const one = await pg.$eval('.cb-approve-what', (e) => e.textContent);
      check(
        `one outward step: "goes" ("${one}")`,
        one === '1 step \u00b7 1 outward. The outward step goes to:',
      );
      check(
        `the item in it left its group; the plan is a row under "Plans to approve" (#${second.job.id})`,
        await until(
          pg,
          ([key, id]) =>
            !document.querySelector(
              `.cb-apply-list .kit-row[data-key="${key}"]`,
            ) &&
            !document.querySelector(
              '.cb-apply-part[data-part="archive|repo"]',
            ) &&
            !!document.querySelector(
              `.cb-apply-list .kit-row[data-job="${id}"]`,
            ) &&
            !!document.querySelector('.cb-apply-part[data-part="plans"]'),
          [REPO_C, second.job.id],
        ),
      );
      const cancelPost = pg
        .waitForResponse((r) => r.url().includes('/api/apply/cancel'))
        .catch(() => null);
      await pg.click('.cb-approve .kit-btn:has-text("discard")');
      const cancelBody = (await cancelPost)?.request().postDataJSON();
      check(
        `discard posts /api/apply/cancel for the plan (${JSON.stringify(cancelBody)}) and serve has it cancelled`,
        cancelBody?.plan_id === second.job.id &&
          (await eventually(
            async () => (await job(second.job.id)).job.state === 'cancelled',
          )),
      );
      check(
        'the list shows again, without the plan, and its item waits in its group again',
        await until(
          pg,
          ([id, key]) =>
            location.hash === '#/apply' &&
            !document.querySelector(
              `.cb-apply-list .kit-row[data-job="${id}"]`,
            ) &&
            document.querySelector(
              '.cb-apply-part[data-part="archive|repo"] .cb-group-plan',
            )?.textContent === 'Archive 1 repo\u2026' &&
            !!document.querySelector(
              `.cb-apply-list .kit-row[data-key="${key}"] .kit-box`,
            ),
          [second.job.id, REPO_C],
        ),
      );

      // Two plans can overlap when they were made before serve kept an
      // item to one unfinished job (an older database). Approving one holds
      // its items; approving the other is refused, in serve's words.
      console.log(
        '\nscenario: apply — approving a plan whose item another job holds',
      );
      const third = await agent.api('POST', '/api/apply/plan', {
        keys: [REPO_C],
      });
      const twin = await copyPlan(home, third.job.id);
      await agent.api('POST', '/api/apply/approve', {
        plan_id: third.job.id,
        session: SESSION,
      });
      await pg.evaluate((id) => {
        location.hash = `#/apply/${id}`;
      }, twin);
      await until(
        pg,
        (id) => document.querySelector('.cb-plan')?.dataset.job === String(id),
        twin,
      );
      check(
        `its item waits in no group: the approved job #${third.job.id} holds it`,
        await until(
          pg,
          ([key, id]) =>
            !document.querySelector(
              `.cb-apply-list .kit-row[data-key="${key}"]`,
            ) &&
            !!document.querySelector(
              `.cb-apply-list .kit-row[data-job="${id}"]`,
            ),
          [REPO_C, third.job.id],
        ),
      );
      await pg.click(`.cb-session[data-session="${SESSION}"]`);
      await until(
        pg,
        () =>
          document.querySelector('.kit-primary')?.textContent ===
          'Approve and run',
      );
      const refusedResp = pg.waitForResponse((r) =>
        r.url().includes('/api/apply/approve'),
      );
      await pg.click('.kit-primary');
      const rr = await refusedResp;
      const rb = await rr.json().catch(() => ({}));
      check(
        `serve refuses it, naming the job (${rr.status()}: ${rb.error})`,
        rr.status() === 409 &&
          (rb.error ?? '').includes(
            `${REPO_C} is already in job #${third.job.id}`,
          ),
      );
      check(
        "the page shows serve's message",
        await until(
          pg,
          (w) =>
            document.querySelector('[data-testid="approve"] .cb-apply-note')
              ?.textContent === w,
          rb.error ?? '-',
        ),
      );
      check(
        'and it is still a plan',
        (await job(twin)).job.state === 'planned',
      );
    } finally {
      clearInterval(keep);
    }
    check(`no page errors (${errors.join(' | ')})`, errors.length === 0);
  } finally {
    await pg.close();
  }
}

// staleScenario: serve refuses a plan from an observation older than one
// sync interval (2s here); the page shows serve's words, which name a sync
// and no command, and offers "sync first". The sync is serve's own (POST
// /api/sync, App.Sync) and hermetic: this serve's casebook-data remote is
// the committed bundle on disk, it scans no roots, and its gh is the probe's
// fake. When it is done the plan is built again, once.
async function staleScenario(context, t, serveHandle) {
  const { check, checkList, until, eventually } = t;
  console.log(
    '\nscenario: apply — a stale plan is refused in serve\u2019s words, and offers sync first',
  );
  const agent = createAgent(serveHandle.base, serveHandle.token);
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  try {
    await pg.setViewportSize({ width: 1600, height: 900 });
    await pg.goto(serveHandle.url + '#/apply', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const STALE_BUTTON =
      '.cb-apply-part[data-part="archive|repo"] .cb-group-plan';
    const okC = await cssColor(pg, 'var(--kit-ok)');
    const mutedC = await cssColor(pg, 'var(--kit-muted)');
    // Court decides with the page open (and live): serve rebuilds its index
    // (built_at now) and says so; the page's foot follows serve's
    // observation age.
    await until(
      pg,
      () => document.querySelector('.kit-live')?.dataset.state === 'live',
    );
    await agent.api('POST', '/api/decide', {
      keys: ['repo:schuettc/t9-stale'],
      disposition: 'archive',
    });
    const sum0 = await agent.api('GET', '/api/summary');
    check(
      `serve gives the page its sync interval (${sum0.sync_interval_ms} ms) and the index's age (built_at)`,
      sum0.sync_interval_ms === 2000 && !!Date.parse(sum0.built_at),
    );
    const freshSeen = await until(
      pg,
      (ok) => {
        const e = document.querySelector('.cb-apply-obs');
        return (
          e?.textContent === 'observations fresh' &&
          e.dataset.state === 'fresh' &&
          getComputedStyle(e).color === ok &&
          !!document.querySelector(
            '.cb-apply-part[data-part="archive|repo"] .cb-group-plan',
          )
        );
      },
      okC,
      1800,
    );
    const obsNow = await pg.$eval('.cb-apply-obs', (e) => e.textContent);
    check(
      `within one sync interval of the rebuild the foot says the observations are fresh, in ok ("${obsNow}")`,
      freshSeen,
    );
    // Past the sync interval since the index was built: the foot says how
    // old they are, on its own (no event), muted.
    check(
      'past one sync interval the foot says how old the observations are, muted',
      await until(
        pg,
        (muted) => {
          const e = document.querySelector('.cb-apply-obs');
          return (
            /^observations \d+s old$/.test(e?.textContent ?? '') &&
            e.dataset.state === 'stale' &&
            getComputedStyle(e).color === muted
          );
        },
        mutedC,
        5000,
      ),
    );
    // serve agrees: its index is older than the interval.
    await eventually(async () => {
      const s = await agent.api('GET', '/api/summary');
      return Date.now() - Date.parse(s.built_at) > 2300;
    });
    const resp = pg.waitForResponse((r) => r.url().includes('/api/apply/plan'));
    await pg.click(STALE_BUTTON);
    const r = await resp;
    const body = await r.json();
    check(`serve refuses the plan (409: ${body.error})`, r.status() === 409);
    const shown = (await until(
      pg,
      () => !!document.querySelector('[data-testid="plan-refused"]'),
    ))
      ? await pg.$eval('[data-testid="plan-refused"]', (e) => e.textContent)
      : '';
    check(
      `the page shows serve's message verbatim ("${shown}")`,
      shown === body.error && shown.includes('sync'),
    );
    check(
      'it names a sync and no command for Court to run',
      !/\bgit |\bgh |casebook |`|\$/.test(shown),
    );
    const offer = await pg.$eval('[data-testid="refusal"]', (e) => ({
      edge: getComputedStyle(e).borderLeftColor,
      btns: [...e.querySelectorAll('.kit-btn')].map(
        (b) => b.textContent + (b.classList.contains('fill') ? '*' : ''),
      ),
    }));
    check(
      `the refusal offers "sync first" (${offer.btns.join(', ')})`,
      offer.btns.join(',') === 'sync first*',
    );
    const around = await pg.evaluate(() => ({
      filled: [
        ...document.querySelectorAll(
          '[data-testid="apply-overview"] .kit-btn.fill',
        ),
      ].map((b) => b.textContent),
      primary: document.querySelector('.kit-primary')?.textContent,
    }));
    check(
      `refused, sync first is the one offer: the only filled button in the document, and the bar's primary (${around.filled.join(', ')}; "${around.primary}")`,
      around.filled.join(',') === 'sync first' &&
        around.primary === 'Sync first',
    );
    check(
      "while the refusal stands the group's button waits",
      await pg.$eval(STALE_BUTTON, (b) => b.disabled),
    );
    check(
      'no job was made',
      ((await agent.api('GET', '/api/jobs')).jobs ?? []).length === 0,
    );
    await inThemes(t, pg, 'stale', ['light']);

    // A second tab, refused too. Court presses sync first in the first
    // tab only: the plan is built again there, not here.
    const pg2 = await context.newPage();
    pg2.on('pageerror', (e) => errors.push(`tab 2: ${e}`));
    await pg2.setViewportSize({ width: 1600, height: 900 });
    await pg2.goto(serveHandle.url + '#/apply', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await until(
      pg2,
      () => document.querySelector('.kit-live')?.dataset.state === 'live',
    );
    await until(pg2, (b) => !!document.querySelector(b), STALE_BUTTON);
    const resp2 = pg2.waitForResponse((x) =>
      x.url().includes('/api/apply/plan'),
    );
    await pg2.click(STALE_BUTTON);
    check(
      'a second tab is refused too',
      (await resp2).status() === 409 &&
        (await until(
          pg2,
          () => !!document.querySelector('[data-testid="plan-refused"]'),
        )),
    );
    const tab2Plans = [];
    const onReq2 = (q) => {
      if (q.method() === 'POST' && q.url().includes('/api/apply/plan'))
        tab2Plans.push(q.url());
    };
    pg2.on('request', onReq2);

    // sync first: serve syncs (once), the page says so, and the plan is
    // built again when it is done.
    const ghBefore = serveHandle.ghCalls().length;
    const bundle = join(here, 'testdata', 'home', 'data', 'repo.bundle');
    const bundleBefore = hashOf(bundle);
    await pg.evaluate(() => {
      window.__sawSyncing = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="syncing"]'))
          window.__sawSyncing = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
    const syncPosts = [];
    const planPosts = [];
    const onReq = (q) => {
      if (q.method() !== 'POST') return;
      if (q.url().includes('/api/sync')) syncPosts.push(q.url());
      if (q.url().includes('/api/apply/plan')) planPosts.push(q.url());
    };
    pg.on('request', onReq);
    const replanned = pg
      .waitForResponse(
        (x) => x.url().includes('/api/apply/plan') && x.status() === 200,
        { timeout: 30000 },
      )
      .catch(() => null);
    await pg.click('[data-testid="refusal"] .kit-btn:has-text("sync first")');
    const plan = await (await replanned)?.json().catch(() => null);
    await pg.waitForTimeout(300); // kept: no second sync or plan may follow
    pg.off('request', onReq);
    check(
      `sync first asks serve to sync once (${syncPosts.length} POST /api/sync), and the page said it was syncing`,
      syncPosts.length === 1 &&
        (await pg.evaluate(() => window.__sawSyncing === true)),
    );
    check(
      `when the sync is done the plan is built again, once, and opens (${planPosts.length} POST /api/apply/plan; job ${plan?.job?.id})`,
      planPosts.length === 1 &&
        !!plan &&
        (await until(
          pg,
          (id) =>
            location.hash === `#/apply/${id}` &&
            document.querySelector('.cb-plan')?.dataset.job === String(id),
          plan.job.id,
        )),
    );
    checkList(
      "the plan is the refused one: the stale repo's archive",
      (plan?.job?.steps ?? []).map((st) => `${st.action} ${st.key}`),
      ['repo-archive repo:schuettc/t9-stale'],
    );
    const sum1 = await agent.api('GET', '/api/summary');
    check(
      `serve's index was rebuilt by the sync (built_at ${sum0.built_at} → ${sum1.built_at}) and it is no longer syncing`,
      Date.parse(sum1.built_at) > Date.parse(sum0.built_at) + 2000 &&
        sum1.syncing === false,
    );
    check(
      'serve has one plan (no second sync, no second plan)',
      ((await agent.api('GET', '/api/jobs')).jobs ?? []).length === 1,
    );
    // The other tab heard the sync too; it re-plans nothing, and its
    // refusal (of observations the sync made fresh) is gone.
    const tab2Cleared = await until(
      pg2,
      () =>
        !document.querySelector('[data-testid="refusal"]') &&
        document.querySelector('.kit-primary')?.textContent !== 'Sync first',
    );
    await pg2.waitForTimeout(300); // kept: this tab may not re-plan
    pg2.off('request', onReq2);
    check(
      `the tab that didn't ask re-plans nothing (${tab2Plans.length} POST /api/apply/plan) and no longer shows the refusal`,
      tab2Plans.length === 0 && tab2Cleared,
    );
    await pg2.close();
    // Nothing outward ran: every gh call went to the probe's fake, each a
    // read (the fake refuses what it doesn't know), each with the
    // fail-closed environment; casebook-data's remote is the bundle on disk.
    const ghSync = serveHandle.ghCalls().slice(ghBefore);
    const outward =
      /\b(archive|unarchive|close|reopen|merge|delete|edit|create|comment|review)\b|(^| )(-X|--method)( |$)/;
    check(
      `nothing outward ran in the sync: ${ghSync.length} gh calls, all to the fake, none that changes GitHub (${[...new Set(ghSync.map((c) => c.split(' ').slice(0, 2).join(' ')))].join('; ')})`,
      ghSync.length > 0 && ghSync.every((c) => !outward.test(c)),
    );
    const env = serveHandle.ghEnv();
    check(
      `every gh call saw the fail-closed environment (GH_HOST github.invalid, a token that isn't one, the probe's gh config; ${env.length} calls)`,
      env.length === serveHandle.ghCalls().length &&
        env.every(
          (l) =>
            l ===
            `github.invalid probe-not-a-token ${join(serveHandle.home, 'gh')}`,
        ),
    );
    const origin = probeGit(
      join(serveHandle.home, 'data', 'repo'),
      'remote get-url origin',
      serveHandle.home,
    );
    check(
      `casebook-data's remote, which the sync pulls from and pushes to, is the bundle on disk (${origin})`,
      origin.endsWith('/testdata/home/data/repo.bundle') &&
        !/^(https?|ssh|git):|@/.test(origin),
    );
    check(
      'the committed bundle is untouched by the sync (nothing was pushed to it)',
      hashOf(bundle) === bundleBefore,
    );
    check(`no page errors (${errors.join(' | ')})`, errors.length === 0);
  } finally {
    await pg.close();
  }
}
