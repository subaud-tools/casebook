// probe.mjs — the build-time browser check for the casebook bundle.
//
// Spawns real seeded casebook serves (via serve.mjs), opens their pages in
// headless Chrome (playwright-core), and checks what the page must never
// get wrong (Court, 2026-10-18; what can be seen is checked by looking):
//
//   1. nothing runs without Court's click, and what runs is exactly what
//      review showed                                  (probe-apply.mjs)
//   2. decisions aren't lost or doubled               (probe-decide.mjs)
//   3. the page works end to end without errors      (the e2e group below,
//      the walkthrough's start and skip in probe-walkthrough.mjs, and no
//      console or page error on any page any group opens)
//   4. the probe's own safety: every git hermetic, no page but the
//      walkthrough group's showed the walkthrough, MIN_CHECKS, and the
//      PROBE_ONLY partial-run rules
//
// Chrome is required in CI (KIT_BROWSER=required) and optional locally.
// Skips cleanly when Chrome is absent and KIT_BROWSER is not set.
//
// BROWSER SAFETY: all serve startups go through serve.mjs which enforces
// --no-open and CASEBOOK_NO_BROWSER=1 (it throws at module load without
// --no-open), so no probe can open Court's browser.

import pkg from 'playwright-core';
import { startServe, gitGuard, seenWalkthrough } from './serve.mjs';
import { createAgent } from './agent.mjs';
import { applyScenarios, stopApplyServes } from './probe-apply.mjs';
import { decideScenarios, stopDecideServes } from './probe-decide.mjs';
import {
  walkthroughScenarios,
  stopWalkthroughServes,
} from './probe-walkthrough.mjs';

const { chromium } = pkg;

const required = process.env.KIT_BROWSER === 'required';

let passes = 0;
let fails = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passes++;
  } else {
    console.error(`  ✗ ${label}`);
    fails++;
  }
}

// checkList checks a list against what it should be, saying how they differ.
function checkList(label, got, want) {
  const diff =
    got.length !== want.length || got.some((g, i) => g !== want[i])
      ? ` — got [${got.join(', ')}], want [${want.join(', ')}]`
      : '';
  check(`${label}${diff}`, diff === '');
}

// until waits for a condition in the page and reports whether it held.
async function until(pg, fn, arg, timeout = 6000) {
  try {
    await pg.waitForFunction(fn, arg, { timeout, polling: 50 });
    return true;
  } catch (err) {
    if (err?.name === 'TimeoutError') return false;
    throw err;
  }
}

// eventually polls a check in node until it holds (serve-side state).
async function eventually(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// expectError says one console error is meant (a scenario provoking serve's
// refusal: the browser logs the 4xx it gets): the next console error that
// has text is not counted. One call, one error.
const expectedErrors = [];
function expectError(text) {
  expectedErrors.push(text);
}

const helpers = { check, checkList, until, eventually, expectError };

let e2eServe = null;
function cleanup() {
  if (e2eServe) {
    e2eServe.stop();
    e2eServe = null;
  }
  stopApplyServes();
  stopDecideServes();
  stopWalkthroughServes();
}

process.on('SIGTERM', () => {
  cleanup();
  process.exit(143); // 128 + SIGTERM(15)
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(130); // 128 + SIGINT(2)
});
process.on('exit', () => {
  cleanup();
});

// ---- the page end to end ----------------------------------------------------
//
// One pass over a serve of its own, as Court uses it: decide loads with its
// groups collapsed, one opens to its rows, an item opens; a decision waits
// in review, its group opens there and runs; run shows the job and its
// progress as the agent reports.
const E2E_PR = 'pr:schuettc/e2e-prs#1';
const E2E_SEED = {
  seedRepos: [
    {
      repo: 'schuettc/e2e-prs',
      pushed_at: '2026-09-20T00:00:00Z',
      default_branch: 'main',
      prs: [
        {
          repo: 'schuettc/e2e-prs',
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

async function e2eScenario(browser) {
  console.log('\nscenario: the page end to end');
  const s = await startServe(E2E_SEED);
  e2eServe = s;
  const agent = createAgent(s.base, s.token);
  const S = 'probe-e2e-pi';
  const here = () => agent.presence(S, 'pi · e2e', '/home/court/e2e', 'pi');
  await here();
  const keep = setInterval(() => void here(), 1000);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  });
  const LIST = '.kit-app > .kit-list:not([hidden])';
  const READ = '.kit-app > .kit-read:not([hidden])';
  try {
    const pg = await context.newPage();
    await pg.goto(`${s.url}&session=${S}#/decide`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await pg.waitForSelector('.kit-bar', { timeout: 8000 });
    checkList(
      'the bar has its three steps: decide, review, run',
      await pg.$$eval('.kit-ctl[data-id]', (els) =>
        els
          .map((e) => e.dataset.id)
          .filter((id) => ['decide', 'review', 'run'].includes(id)),
      ),
      ['decide', 'review', 'run'],
    );

    // decide loads: its groups collapsed, no rows until one opens.
    const all = await agent.api('GET', '/api/items?view=all&limit=500');
    const groups = (all.groups ?? []).filter((g) => g.total > 0);
    check(
      `decide loads serve's groups, every one collapsed, no rows shown (${groups.map((g) => g.id).join(', ')})`,
      groups.length > 0 &&
        (await until(
          pg,
          ([list, ids]) => {
            const gs = [...document.querySelectorAll(`${list} .cb-group`)];
            return (
              ids.every((id) =>
                gs.some(
                  (g) =>
                    g.dataset.group === id && g.classList.contains('collapsed'),
                ),
              ) && !document.querySelector(`${list} .kit-row`)
            );
          },
          [LIST, groups.map((g) => g.id)],
          8000,
        )),
    );
    const first = groups[0];
    await pg.evaluate(
      ([list, id]) =>
        [...document.querySelectorAll(`${list} .cb-group[data-group]`)]
          .find((e) => e.dataset.group === id)
          ?.querySelector('.cb-group-caret')
          ?.click(),
      [LIST, first.id],
    );
    check(
      `opening the group ${first.id} shows its rows (${first.total}, serve's count)`,
      await until(
        pg,
        ([list, n]) =>
          document.querySelectorAll(`${list} .kit-row`).length === n,
        [LIST, Math.min(first.total, 200)],
        8000,
      ),
    );
    await pg.click(`${LIST} .kit-row`);
    check(
      'a row opens its item, with its decision buttons',
      await until(
        pg,
        (read) =>
          location.hash.startsWith('#/item/') &&
          !!document.querySelector(`${read} .cb-item[data-key]`) &&
          document.querySelectorAll(`${read} .cb-choices .cb-choice`).length >
            0,
        READ,
        8000,
      ),
    );

    // review opens a group; run shows the job and its progress.
    await agent.api('POST', '/api/decide', {
      keys: [E2E_PR],
      disposition: 'close',
    });
    await pg.click('.kit-ctl[data-id="review"]');
    const HEAD = '.cb-apply-part[data-part="close|pr"] .cb-group-box';
    await pg.waitForSelector(HEAD, { timeout: 8000 });
    await pg.click(HEAD);
    const RUN = '[data-testid="run-group"] .kit-btn.fill';
    check(
      'review opens the group with its commands and its button, on',
      await until(
        pg,
        (b) =>
          document.querySelector('[data-testid="review-group"]')?.dataset
            .group === 'close|pr' &&
          document.querySelectorAll('.cb-plan-step .cb-cmd').length > 0 &&
          !!document.querySelector(b) &&
          !document.querySelector(b).disabled,
        RUN,
        8000,
      ),
    );
    const approved = pg.waitForResponse(
      (r) =>
        r.url().includes('/api/apply/approve') &&
        r.request().method() === 'POST',
    );
    await pg.click(RUN);
    const job = (await (await approved).json()).job ?? {};
    check(
      `run shows the job (#${job.id}), and lists it running, 0 of 1`,
      await until(
        pg,
        (id) =>
          location.hash === `#/run/${id}` &&
          document.querySelector('.cb-job')?.dataset.job === String(id) &&
          (
            document.querySelector(`.cb-pane-run .cb-run-job[data-job="${id}"]`)
              ?.textContent ?? ''
          ).endsWith('0 of 1'),
        job.id,
        8000,
      ),
    );
    for (const state of ['started', 'reported'])
      await agent.api('POST', '/api/agent/job-step', {
        session: S,
        job: job.id,
        step: job.steps[0].id,
        state,
      });
    check(
      'its step moves live as the agent reports it, and serve verifies it; run counts its item done',
      (await until(
        pg,
        (step) =>
          document.querySelector(`.cb-job .cb-step[data-step="${step}"]`)
            ?.dataset.state === 'verified' &&
          document.querySelector(
            '.cb-pane-run .cb-group[data-group="done"] .cb-group-n',
          )?.textContent === '1',
        job.steps[0].id,
        10000,
      )) &&
        (await eventually(
          async () =>
            (await agent.api('GET', `/api/job?id=${job.id}`)).job.steps[0]
              .state === 'verified',
        )),
    );
  } finally {
    clearInterval(keep);
    await context.close();
    s.stop();
    e2eServe = null;
  }
}

// ---- the scenario list ------------------------------------------------------
//
// run() below is the scenario list. A full run (no PROBE_ONLY) must pass at
// least MIN_CHECKS checks: a scenario that stops early, or is skipped, can't
// leave the probe green. Raise it whenever checks are added.
const MIN_CHECKS = 69;

// PROBE_ONLY runs one group of scenarios, for working on them: a partial
// run. It has to say so: under CI (the CI env var) it is refused outright,
// and a required run (KIT_BROWSER=required, as `just verify-slow` makes it)
// refuses it unless PROBE_PARTIAL=1 says the partial run is meant
// (`just casebook-probe-only <name>`). An unknown name is an error, not a
// quiet full run without the floor.
const only = process.env.PROBE_ONLY ?? '';
const underCI = !!process.env.CI;
const partial = process.env.PROBE_PARTIAL === '1';
// group is the group running now; walkLeaks the groups whose pages showed
// the walkthrough's overlay (only the walkthrough group's may), pageErrors
// every console error and uncaught error on any page, by group.
let group = '';
const walkLeaks = [];
const pageErrors = [];
const groupsRan = new Set();
const GROUPS = {
  e2e: (browser) => e2eScenario(browser),
  apply: (browser) => applyScenarios({ browser: () => browser }, helpers),
  decide: (browser) => decideScenarios({ browser: () => browser }, helpers),
  walkthrough: (browser) =>
    walkthroughScenarios({ browser: () => browser }, helpers),
};
const PROBE_GROUPS = Object.keys(GROUPS);
const throttle = Number(process.env.PROBE_THROTTLE ?? '') || 0;

// throttlePage slows a page's CPU by PROBE_THROTTLE (see run()).
async function throttlePage(c, pg) {
  try {
    const cdp = await c.newCDPSession(pg);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    throttled++;
  } catch (err) {
    // A page closed before its session opened is no page to slow.
    if (!pg.isClosed()) throw err;
  }
}
let throttled = 0;

async function run() {
  if (only && !PROBE_GROUPS.includes(only)) {
    console.error(
      `probe: PROBE_ONLY=${only} is not a group (${PROBE_GROUPS.join(', ')})`,
    );
    fails++;
    return;
  }
  if (only && underCI) {
    console.error(
      `probe: PROBE_ONLY=${only} is set under CI; CI runs the whole probe`,
    );
    fails++;
    return;
  }
  if (only && required && !partial) {
    console.error(
      `probe: PROBE_ONLY=${only} is set for a full, required run; unset it, or run the part on purpose with \`just casebook-probe-only ${only}\``,
    );
    fails++;
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = null;
  }
  if (!browser) {
    if (required || underCI) {
      console.error(
        'probe: Chrome is required (KIT_BROWSER=required) but not found.',
      );
      console.error(
        '  Install: node node_modules/playwright-core/cli.js install --with-deps chromium chromium-headless-shell',
      );
      process.exit(1);
    }
    console.log(
      'probe: Chrome not found, skipping (set KIT_BROWSER=required to fail instead).',
    );
    return;
  }

  // Every context the probe opens records its pages' console errors and
  // uncaught errors. PROBE_THROTTLE=<rate> (opt-in, e.g. 4) slows every
  // page's CPU that many times (CDP Emulation.setCPUThrottlingRate), as a
  // busy CI runner does.
  const newContext = browser.newContext.bind(browser);
  // mark gives a context the probe's watchers, and, unless it is a first
  // visit, the walkthrough marked seen (seenWalkthrough) and a watch for
  // its overlay: only the walkthrough group may ever see it.
  const mark = async (c, firstVisit) => {
    if (!firstVisit) {
      await seenWalkthrough(c);
      await c.addInitScript(() => {
        new MutationObserver((ms) => {
          for (const m of ms)
            for (const n of m.addedNodes)
              if (n.classList?.contains('cb-walk'))
                console.error('probe: the walkthrough overlay showed');
        }).observe(document, { childList: true, subtree: true });
      });
    }
    c.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const meant = expectedErrors.findIndex((x) => msg.text().includes(x));
      if (meant >= 0) expectedErrors.splice(meant, 1);
      else if (msg.text().includes('the walkthrough overlay showed'))
        walkLeaks.push(group);
      else pageErrors.push(`${group}: ${msg.text()}`);
    });
    c.on('page', (pg) => {
      pg.on('pageerror', (e) => pageErrors.push(`${group}: ${e}`));
      if (throttle > 1) void throttlePage(c, pg);
    });
    return c;
  };
  // newFirstVisitContext is a first visit: the walkthrough group's.
  browser.newFirstVisitContext = async (...args) =>
    mark(await newContext(...args), true);
  browser.newContext = async (...args) => {
    const c = await newContext(...args);
    // The agent pane opens on a click; every other scenario finds it open,
    // as a tab where Court opened it does (dock.ts keeps that in
    // sessionStorage).
    await c.addInitScript(() => {
      try {
        sessionStorage.setItem('casebook.dock', 'open');
      } catch {
        // a page with no storage (about:blank) has no pane either
      }
    });
    return mark(c, false);
  };
  ran = true;

  try {
    for (const name of PROBE_GROUPS) {
      if (only && name !== only) continue;
      group = name;
      groupsRan.add(name);
      try {
        await GROUPS[name](browser);
      } catch (err) {
        check(`${name}: the group ran to its end — ${err.message}`, false);
      }
    }
    group = '';
  } catch (err) {
    console.error('probe: unexpected error:', err);
    fails++;
  } finally {
    console.log('\ninvariant: no page showed a console or page error');
    check(
      pageErrors.length
        ? `no console or page errors — ${pageErrors.length}: ${pageErrors.slice(0, 5).join(' | ')}`
        : 'no console or page errors on any page',
      pageErrors.length === 0,
    );
    console.log('\ninvariant: every git the probe ran was hermetic');
    {
      const g = gitGuard();
      check(
        g.bad.length
          ? `every git call ran hermetic with CASEBOOK_DISABLE=1 — ${g.bad.length} of ${g.calls} did not: ${g.bad.slice(0, 3).join(' | ')}`
          : `every git call the probe and its serves made (${g.calls}) ran hermetic, with CASEBOOK_DISABLE=1 (the guard's log)`,
        g.calls > 0 && g.bad.length === 0,
      );
    }
    console.log('\ninvariant: only the walkthrough group saw the walkthrough');
    for (const g of groupsRan) {
      if (g === 'walkthrough') continue;
      const n = walkLeaks.filter((x) => x === g).length;
      check(
        n
          ? `${g}: no page showed the walkthrough — ${n} did`
          : `${g}: no page showed the walkthrough (marked seen)`,
        n === 0,
      );
    }
    await browser.close();
    cleanup();
  }
}

let ran = false; // a browser ran the scenarios (not the no-Chrome skip)

void run().then(() => {
  if (throttle > 1) {
    console.log(`\nprobe: ${throttled} pages ran at ${throttle}x CPU throttle`);
  }
  console.log(`\nprobe: ${passes} passed, ${fails} failed`);
  if (ran && !only && passes < MIN_CHECKS) {
    console.error(
      `probe: a full run passed ${passes} checks, fewer than MIN_CHECKS (${MIN_CHECKS})`,
    );
    fails++;
  }
  if (fails > 0) process.exit(1);
});
