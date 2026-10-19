// probe-decide.mjs — decisions aren't lost or doubled, run by probe.mjs with
// its check helpers (t.check, t.until, t.eventually).
//
// One serve of its own (serve.mjs: --no-open, CASEBOOK_NO_BROWSER=1, the
// hermetic git guard, the fake gh) with a repo of its own, and two rules
// that recommend: Close it on its issues, Delete it on three old repos.
// Every check reads serve's state (GET /api/item: the decision, its
// proposal and the decision file's commits), never the page's words:
//
//   a group's "Delete all 3" decides each of the three once; its undo
//     puts all three back, undecided
//   the recommended button on the item page accepts the recommendation,
//     one decision, one commit; u undoes it; u after a re-decide puts the
//     earlier decision back
//   another button decides differently (the rule's record counts it)
//   a recommendation that arrives while Court is picking a Not now still
//     counts as decided differently

import { openGroups, startServe } from './serve.mjs';
import { createAgent } from './agent.mjs';

let serves = [];
/** stopDecideServes stops every serve these scenarios started (probe.mjs cleanup). */
export function stopDecideServes() {
  for (const s of serves) s.stop();
  serves = [];
}

const IP = 'rd-item';
const IPISSUE = (n) => `issue:schuettc/${IP}#${n}`;
const IPPR = (n) => `pr:schuettc/${IP}#${n}`;
const IPOLD = (n) => `repo:schuettc/rd-old-${n}`;
const IP_RULE = {
  id: 'item-issues',
  name: 'Stale questions',
  match: [
    { field: 'kind', op: 'is', value: 'issue' },
    { field: 'repo', op: 'is', value: `schuettc/${IP}` },
  ],
  propose: { disposition: 'close', note: 'a stale question' },
};
const IP_OLD = {
  id: 'item-old',
  name: 'Old repos',
  match: [
    { field: 'kind', op: 'is', value: 'repo' },
    {
      field: 'repo',
      op: 'in',
      value: [1, 2, 3].map((n) => `schuettc/rd-old-${n}`).join(','),
    },
  ],
  propose: { disposition: 'delete', note: 'not pushed in years' },
};

function seed() {
  const item = ([number, title, author], i) => ({
    repo: `schuettc/${IP}`,
    number,
    title,
    author,
    state: 'OPEN',
    created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    updated_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  });
  return {
    seedRepos: [
      {
        repo: `schuettc/${IP}`,
        pushed_at: '2026-09-20T00:00:00Z',
        default_branch: 'main',
        prs: [[5, 'Bump the uploader', 'renovate']].map(item),
        issues: [
          [1, 'The uploader retries forever', 'alice'],
          [2, 'README typo', 'carol'],
          [3, 'Tags question', 'dave'],
          [4, 'Flag docs', 'erin'],
        ].map(item),
      },
      ...[1, 2, 3].map((n) => ({
        repo: `schuettc/rd-old-${n}`,
        // Pushed lately: a starter rule (your-old-repos) would otherwise
        // recommend them too.
        pushed_at: '2026-09-20T00:00:00Z',
        default_branch: 'main',
        prs: [],
        issues: [],
      })),
    ],
  };
}

const READ = '.kit-app > .kit-read:not([hidden])';
const LIST = '.kit-app > .kit-list:not([hidden])';
const STRIP = '.cb-strip';

// press presses keys with nothing focused. Headless Chrome withholds focus
// events without window focus, so they are dispatched.
async function press(pg, ...keys) {
  await pg.evaluate(() => {
    document.activeElement?.blur();
    window.dispatchEvent(new Event('focus'));
    document.body.dispatchEvent(new FocusEvent('focus'));
  });
  for (const k of keys) await pg.keyboard.press(k);
}

// row is the shown list's row for key.
const row = (pg, key) => pg.locator(`${LIST} .kit-row[data-key="${key}"]`);

// opened waits for the reading column to show key with its buttons.
function opened(t, pg, key) {
  return t.until(
    pg,
    ([read, k]) => {
      const r = document.querySelector(read);
      return (
        r?.querySelector('.cb-item')?.getAttribute('data-key') === k &&
        r.querySelectorAll('.cb-choices .cb-choice').length > 0
      );
    },
    [READ, key],
    8000,
  );
}

export async function decideScenarios(shared, t) {
  const context = await shared.browser().newContext({
    viewport: { width: 1600, height: 900 },
  });
  const s = await startServe(seed());
  serves.push(s);
  try {
    await decisionsScenario(context, t, s);
  } catch (err) {
    t.check(`decisions: the scenario ran to its end — ${err.message}`, false);
  } finally {
    await context.close();
    s.stop();
    serves = serves.filter((x) => x !== s);
  }
}

async function decisionsScenario(context, t, s) {
  const { check, until, eventually } = t;
  console.log("\nscenario: decisions aren't lost or doubled");
  const agent = createAgent(s.base, s.token);
  const api = (m, p, b) => agent.api(m, p, b);
  const itemOf = async (key) =>
    await api('GET', `/api/item?key=${encodeURIComponent(key)}`);
  // what serve holds for key: its decision, its pending proposal, and how
  // many commits its decision file has.
  const held = async (key) => {
    const v = await itemOf(key);
    return {
      d: v.item.decision ?? null,
      rec: v.item.proposal ?? null,
      commits: (v.decisions ?? []).length,
      proposals: v.proposals ?? [],
    };
  };

  // Only this scenario's items wait on Court.
  const new0 = await api('GET', '/api/items?view=new&limit=500');
  const mine = (k) => k.includes(`/${IP}#`) || k.includes('/rd-old-');
  const others = (new0.items ?? []).map((it) => it.key).filter((k) => !mine(k));
  if (others.length)
    await api('POST', '/api/decide', { keys: others, disposition: 'ignore' });
  await api('POST', '/api/rules/save?create=1', IP_RULE);
  await api('POST', '/api/rules/save?create=1', IP_OLD);
  check(
    'the rules recommend: Close it on the issues, Delete it on the old repos',
    await eventually(
      async () =>
        (await held(IPISSUE(1))).rec?.state === 'pending' &&
        (await held(IPISSUE(4))).rec?.state === 'pending' &&
        (await held(IPOLD(1))).rec?.state === 'pending',
      8000,
    ),
  );
  const ruleRecord = async (id) =>
    ((await api('GET', '/api/rules')).rules ?? []).find((r) => r.rule.id === id)
      ?.record ?? null;

  const pg = await context.newPage();
  const posts = [];
  pg.on('request', (r) => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });
  await pg.goto(`${s.url}#/decide`, { waitUntil: 'domcontentloaded' });
  await openGroups(pg);

  // ---- a group's decision, and its undo -------------------------------------
  // First, so no other decision's strip is up when its own is looked for.
  const OLDS = [1, 2, 3].map(IPOLD);
  const OLD = `${LIST} .cb-group[data-rule="${IP_OLD.id}"]`;
  await pg.waitForSelector(`${OLD} .cb-group-box`, { timeout: 8000 });
  const oldBefore = await Promise.all(OLDS.map(held));
  posts.length = 0;
  // Ticking the group shows its three in the middle, the rule's choice
  // filled; nothing is decided until it is pressed.
  await pg.click(`${OLD} .cb-group-box`);
  const FILLED = `${READ} .cb-mid-acts .cb-choice.on[data-d="delete"]`;
  await pg.waitForSelector(FILLED, { timeout: 8000 });
  check(
    `ticking the group decides nothing: its three show in the middle, "1 ticked" aside (${posts.length} POSTs)`,
    posts.filter((p) => /^\/api\/(decide|proposals\/)/.test(p)).length === 0 &&
      (await pg.$eval(`${OLD} .cb-group-ticked`, (e) => e.textContent)) ===
        '3 ticked \u00b7 untick',
  );
  await pg.click(FILLED);
  const groupDecided = await eventually(async () => {
    const now = await Promise.all(OLDS.map(held));
    return now.every(
      (h, i) =>
        h.d?.disposition === 'delete' && h.commits === oldBefore[i].commits + 1,
    );
  }, 8000);
  const groupPosts = posts.filter((p) =>
    /^\/api\/(decide|proposals\/)/.test(p),
  );
  check(
    `ticked, the three's delete decides each of them, once: one commit each, from one POST (${groupPosts.join(', ')})`,
    groupDecided && groupPosts.length === 1,
  );
  await until(
    pg,
    (sel) => {
      const e = document.querySelector(sel);
      return !!e?.checkVisibility() && /all 3/.test(e.textContent ?? '');
    },
    STRIP,
    8000,
  );
  await pg.click(`${STRIP} button`);
  check(
    'its undo puts all three back as they were: undecided, recommended again',
    await eventually(async () => {
      const now = await Promise.all(OLDS.map(held));
      return now.every((h) => h.d === null && h.rec?.state === 'pending');
    }, 8000),
  );

  // ---- the item page: the recommended button accepts, once ---------------
  await row(pg, IPISSUE(1)).click();
  check('issue #1 opens', await opened(t, pg, IPISSUE(1)));
  await until(pg, (r) => !!document.querySelector(`${r} .cb-choice.rec`), READ);
  const i1 = await held(IPISSUE(1));
  posts.length = 0;
  await pg.click(`${READ} .cb-choice[data-d="close"]`);
  await pg.click(
    `${READ} .cb-close-comment button:has-text("close without comment")`,
  );
  const accepted = await eventually(async () => {
    const h = await held(IPISSUE(1));
    return (
      h.d?.disposition === 'close' &&
      (h.d.proposed_by ?? '').includes(IP_RULE.id) &&
      h.commits === i1.commits + 1 &&
      h.proposals.some((p) => p.state === 'accepted')
    );
  }, 8000);
  check(
    `the recommended Close it accepts the rule's recommendation: one decision, one commit, one POST (${posts.join(', ')})`,
    accepted &&
      posts.filter((p) => p === '/api/proposals/accept').length === 1 &&
      !posts.includes('/api/decide'),
  );
  check(
    'the next item opens',
    await until(
      pg,
      ([r, k]) =>
        !!document.querySelector(`${r} .cb-item`) &&
        document.querySelector(`${r} .cb-item`)?.getAttribute('data-key') !== k,
      [READ, IPISSUE(1)],
      8000,
    ),
  );
  await press(pg, 'u');
  check(
    'u undoes it: issue #1 is undecided again, as it was',
    await eventually(async () => (await held(IPISSUE(1))).d === null, 8000),
  );

  // ---- u after a re-decide puts the earlier decision back ------------------
  await api('POST', '/api/decide', { keys: [IPISSUE(2)], disposition: 'keep' });
  await pg.evaluate((k) => {
    location.hash = `#/item/${encodeURIComponent(k)}`;
  }, IPISSUE(2));
  await opened(t, pg, IPISSUE(2));
  await pg.click(`${READ} .cb-choice[data-d="ignore"]`);
  check(
    'issue #2, kept, re-decided Stop tracking it on its page',
    await eventually(
      async () => (await held(IPISSUE(2))).d?.disposition === 'ignore',
      8000,
    ),
  );
  await press(pg, 'u');
  check(
    'u puts back what was there: issue #2 is kept again',
    await eventually(
      async () => (await held(IPISSUE(2))).d?.disposition === 'keep',
      8000,
    ),
  );

  // ---- another choice decides differently ---------------------------------
  await pg.evaluate((k) => {
    location.hash = `#/item/${encodeURIComponent(k)}`;
  }, IPISSUE(4));
  await opened(t, pg, IPISSUE(4));
  await until(pg, (r) => !!document.querySelector(`${r} .cb-choice.rec`), READ);
  posts.length = 0;
  await pg.click(`${READ} .cb-choice[data-d="keep"]`);
  check(
    'Leave it open against the recommended Close it is decided differently: kept, its recommendation changed, the rule counts it',
    (await eventually(async () => {
      const h = await held(IPISSUE(4));
      return (
        h.d?.disposition === 'keep' &&
        h.proposals.some((p) => p.state === 'changed')
      );
    }, 8000)) &&
      (await eventually(
        async () => (await ruleRecord(IP_RULE.id))?.decided_differently === 1,
        8000,
      )) &&
      posts.includes('/api/proposals/change') &&
      !posts.includes('/api/decide'),
  );

  // ---- a recommendation that comes while Court is picking a Not now ------
  // (review 2026-10-17): the decision still counts against it, not over it.
  {
    const S = 'probe-item-late';
    await agent.presence(S, 'pi \u00b7 late', '/home/court/late', 'pi');
    await pg.evaluate((k) => {
      location.hash = `#/item/${encodeURIComponent(k)}`;
    }, IPPR(5));
    await opened(t, pg, IPPR(5));
    await pg.click(`${READ} .cb-choice[data-d="wait"]`);
    await pg.waitForSelector(`${READ} .cb-notnow:not([hidden]) .kit-chip`, {
      timeout: 8000,
    });
    await agent.propose(S, [IPPR(5)], 'close', 'superseded upstream');
    // The page has it: it says so beside the open picker.
    const heard = await until(
      pg,
      (sel) => !!document.querySelector(sel)?.checkVisibility(),
      `${READ} .cb-rec-fresh`,
      8000,
    );
    posts.length = 0;
    await pg.click(
      `${READ} .cb-notnow:not([hidden]) .kit-chip[data-id="in-1w"]`,
    );
    check(
      `a recommendation that came while picking a not now (the page heard it: ${heard}) counts as decided differently: waiting, its recommendation changed`,
      heard &&
        (await eventually(async () => {
          const h = await held(IPPR(5));
          return (
            h.d?.disposition === 'wait' &&
            h.proposals.some((p) => p.state === 'changed')
          );
        }, 8000)) &&
        posts.includes('/api/proposals/change') &&
        !posts.includes('/api/decide'),
    );
  }

  // ---- ticks only cover what is shown -------------------------------------
  // Review 2026-10-19: a tick a search had hidden was decided with the one
  // shown. Tick A, narrow until only B shows, tick B, press: only B.
  {
    const [A, B] = [IPOLD(1), IPOLD(2)];
    await pg.evaluate(() => (location.hash = '#/decide'));
    await openGroups(pg);
    await row(pg, A).locator('.kit-box').click();
    const SEARCH = `${LIST} input[placeholder="search by key or title"]`;
    await pg.fill(SEARCH, 'rd-old-2');
    await until(
      pg,
      ([l, a, b]) =>
        !document.querySelector(`${l} .kit-row[data-key="${a}"]`) &&
        !!document.querySelector(`${l} .kit-row[data-key="${b}"]`),
      [LIST, A, B],
      8000,
    );
    await openGroups(pg);
    await row(pg, B).locator('.kit-box').click();
    const DEL = `${READ} .cb-mid-acts .cb-choice[data-d="delete"]:not([disabled])`;
    await pg.waitForSelector(DEL, { timeout: 8000 });
    await pg.click(DEL);
    const bDone = await eventually(
      async () => (await held(B)).d?.disposition === 'delete',
      8000,
    );
    const a = await held(A);
    check(
      `tick A, search until only B shows, tick B, delete: only B is decided (B ${bDone}, A ${a.d?.disposition ?? 'undecided'})`,
      bDone && a.d === null,
    );
    await pg.fill(SEARCH, '');
  }
  await pg.close();
}
