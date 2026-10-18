// probe-walkthrough.mjs — the first-run walkthrough starts and can be
// skipped, run by probe.mjs with its check helpers (t.check, t.until).
//
// One serve of its own (serve.mjs: --no-open, CASEBOOK_NO_BROWSER=1, the
// hermetic git guard, the fake gh), on the plain fixture. Its context is a
// first visit: no walkthrough flag (every other group's context is marked
// seen, probe.mjs).

import { startServe } from './serve.mjs';
import { createAgent } from './agent.mjs';

let serves = [];
/** stopWalkthroughServes stops every serve these scenarios started (probe.mjs cleanup). */
export function stopWalkthroughServes() {
  for (const s of serves) s.stop();
  serves = [];
}

export async function walkthroughScenarios(shared, t) {
  const { check, until } = t;
  console.log(
    '\nscenario: the first-run walkthrough starts and can be skipped',
  );
  const context = await shared.browser().newFirstVisitContext({
    viewport: { width: 1600, height: 900 },
  });
  const s = await startServe();
  serves.push(s);
  const agent = createAgent(s.base, s.token);
  const toDecide = async () =>
    (await agent.api('GET', '/api/items?view=all&limit=1')).total ?? 0;
  try {
    const before = await toDecide();
    const pg = await context.newPage();
    await pg.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await pg.waitForSelector('.kit-bar', { timeout: 8000 });
    check(
      'the first open shows the walkthrough, at its first step',
      await until(
        pg,
        () =>
          document.querySelector('.cb-walk:not([hidden])')?.dataset.step ===
          'decide',
      ),
    );
    await pg.click('.cb-walk-next');
    await until(
      pg,
      () => document.querySelector('.cb-walk')?.dataset.step !== 'decide',
    );
    await pg.click('.cb-walk-skip');
    check(
      'skip ends it: the overlay goes and the walkthrough is marked seen',
      await until(
        pg,
        () =>
          !document.querySelector('.cb-walk:not([hidden])') &&
          localStorage.getItem('casebook.walkthrough') === 'seen',
      ),
    );
    const after = await toDecide();
    check(
      `the walkthrough decided nothing (${before} to decide, then ${after})`,
      before > 0 && after === before,
    );
  } catch (err) {
    check(
      `the walkthrough: the scenario ran to its end — ${err.message}`,
      false,
    );
  } finally {
    await context.close();
    s.stop();
    serves = serves.filter((x) => x !== s);
  }
}
