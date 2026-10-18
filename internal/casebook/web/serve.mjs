// serve.mjs — spawn a seeded casebook serve for the probe.
//
// Sets up a fresh CASEBOOK_HOME from the committed testdata/home fixture,
// starts `casebook serve --foreground --no-open`, waits for its advert,
// and returns {url, base, token, stop}.
//
// BROWSER SAFETY: serve is always started with --no-open and with
// CASEBOOK_NO_BROWSER=1, which triggers the test seam in cli/workbench.go
// that replaces openBrowser with a silent no-op.  No test or probe path
// can reach localweb.OpenBrowser.

import { execSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// ---- hermetic git, guarded ---------------------------------------------------
//
// Every git the probe runs (its fixtures, its checks, the serves it starts,
// the binary's build) runs with no global or system config (so none of
// Court's hooks) and with CASEBOOK_DISABLE=1, which casebook's own git hook
// shims (~/.config/casebook/hooks) honour: nothing the probe does records
// into Court's casebook. A guard enforces it: at load, a git shim goes first
// on this process's PATH (every child inherits it), logs each call with the
// environment it ran in, and refuses one without that environment. The probe
// checks the log (gitGuard()).
export const HERMETIC_GIT = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  CASEBOOK_DISABLE: '1',
  GIT_AUTHOR_NAME: 'probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
};
const guardDir = realpathSync(tmpdir()) + `/casebook-probe-git-${process.pid}`;
const guardLog = join(guardDir, 'git-calls.log');
{
  const realGit = execSync('command -v git', { shell: '/bin/sh' })
    .toString()
    .trim();
  if (!realGit || realGit.startsWith(guardDir))
    throw new Error('serve.mjs: no git to guard');
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(
    join(guardDir, 'git'),
    `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' "\${CASEBOOK_DISABLE:-unset}" "\${GIT_CONFIG_GLOBAL:-unset}" "\${GIT_CONFIG_NOSYSTEM:-unset}" "$*" >> '${guardLog}'
if [ "$CASEBOOK_DISABLE" != 1 ] || [ "$GIT_CONFIG_GLOBAL" != /dev/null ] || [ "$GIT_CONFIG_NOSYSTEM" != 1 ]; then
  echo "probe git guard: refused git without CASEBOOK_DISABLE=1 and hermetic config: $*" >&2
  exit 97
fi
exec '${realGit}' "$@"
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${guardDir}:${process.env.PATH}`;
  process.on('exit', () => rmSync(guardDir, { recursive: true, force: true }));
}

/**
 * gitGuard reads the guard's log: every git call the probe and its serves
 * made, and those that ran without CASEBOOK_DISABLE=1 and hermetic config
 * (the shim refused them).
 */
export function gitGuard() {
  const lines = existsSync(guardLog)
    ? readFileSync(guardLog, 'utf8').split('\n').filter(Boolean)
    : [];
  const bad = lines.filter((l) => {
    const [disable, global, nosystem] = l.split('\t');
    return disable !== '1' || global !== '/dev/null' || nosystem !== '1';
  });
  return { calls: lines.length, bad };
}

/** probeGit runs git in dir, hermetically, with HOME the probe's home. */
export function probeGit(dir, args, home) {
  return execSync(`git ${args}`, {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, ...HERMETIC_GIT, HOME: home },
  })
    .toString()
    .trim();
}

/**
 * seenWalkthrough marks the first-run walkthrough seen in every page of a
 * playwright context (an init script setting walkthrough.ts's flag), so
 * its overlay covers nothing a probe or a walk looks at. Only the
 * walkthrough's own probe opens a context without it.
 */
export async function seenWalkthrough(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('casebook.walkthrough', 'seen');
    } catch {
      // a page with no storage (about:blank) has no walkthrough either
    }
  });
}

/**
 * openGroups opens decide's groups, as Court does: every group starts
 * collapsed (serve sends only the open groups' rows, open=), so a probe
 * that reads rows opens them first. One at a time, each waited for (a
 * click reloads the list; a second click before it repaints would close
 * the group again). The left-open group stays as it is. Then, unless
 * rows is false, it waits for a row (with rows false an empty list is
 * fine).
 */
export async function openGroups(pg, { rows = true, timeout = 8000 } = {}) {
  const list = '.kit-app > .kit-list';
  // An empty list has neither: with rows false, there is nothing to open.
  const any = await pg
    .waitForSelector(`${list} .cb-group[data-group], ${list} .kit-row`, {
      timeout,
    })
    .then(
      () => true,
      (e) => {
        if (rows) throw e;
        return false;
      },
    );
  if (!any) return;
  const end = Date.now() + timeout;
  for (;;) {
    const id = await pg.evaluate(
      (list) =>
        [
          ...document.querySelectorAll(
            `${list} .cb-group.collapsed[data-group]`,
          ),
        ]
          .map((e) => e.dataset.group)
          .find((g) => g !== 'left-open') ?? null,
      list,
    );
    if (id === null) break;
    if (Date.now() > end) {
      const head = await pg.evaluate(
        ({ list, id }) =>
          [...document.querySelectorAll(`${list} .cb-group[data-group]`)]
            .find((e) => e.dataset.group === id)
            ?.outerHTML.slice(0, 400) ?? '',
        { list, id },
      );
      throw new Error(`openGroups: ${id} stayed collapsed (${head})`);
    }
    await pg.evaluate(
      ({ list, id }) =>
        [...document.querySelectorAll(`${list} .cb-group[data-group]`)]
          .find((e) => e.dataset.group === id)
          ?.querySelector('.cb-group-caret')
          ?.click(),
      { list, id },
    );
    await pg
      .waitForFunction(
        // Open, or gone (a list narrowed meanwhile no longer has it).
        ({ list, id }) => {
          const g = [
            ...document.querySelectorAll(`${list} .cb-group[data-group]`),
          ].find((e) => e.dataset.group === id);
          return !g || !g.classList.contains('collapsed');
        },
        { list, id },
        { timeout: Math.max(1000, end - Date.now()) },
      )
      .catch(() => {});
  }
  if (rows) await pg.waitForSelector(`${list} .kit-row`, { timeout });
}

// The args we always pass to casebook serve. Never remove --no-open.
const SERVE_ARGS = ['serve', '--foreground', '--no-open'];

// Hard invariant: verify at module load that the args include --no-open.
// This ensures serve.mjs can never be accidentally changed to open a browser.
if (!SERVE_ARGS.includes('--no-open')) {
  throw new Error(
    'serve.mjs invariant violated: SERVE_ARGS must include --no-open',
  );
}

// Find the casebook binary: CASEBOOK_BIN env var (CI pre-builds and sets
// this), or rebuild from source so the binary always embeds the latest assets.
// A probe that starts more than one serve builds the binary once.
let builtBinary = '';
function findBinary() {
  if (process.env.CASEBOOK_BIN) return process.env.CASEBOOK_BIN;
  if (builtBinary) return builtBinary;
  const built = join(repoRoot, 'bin', 'casebook');
  // Always rebuild: the probe tests the current source, and the binary embeds
  // internal/casebook/serve/assets/ which was just rewritten by build:js/css.
  console.error('[serve.mjs] building casebook binary…');
  // go build stamps the binary from git: hermetic too.
  execSync(`go build -o "${built}" ./cmd/casebook`, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...HERMETIC_GIT },
  });
  builtBinary = built;
  return built;
}

// Set up a fresh CASEBOOK_HOME from the committed testdata/home fixture.
// The fixture contains:
//   data/repo.bundle   – git bundle of the casebook-data repo
//   cache/github.json  – GitHub observation cache (may be empty)
// Config is written fresh so paths are correct for this machine.
//
// seedRepos adds repos (the cache's repo shape: {repo, prs, issues, …}) to the
// fixture's GitHub cache, so a scenario can own items no other scenario
// touches. seedClones adds real clones on this machine (makeClone), with
// landed branches, so a scenario can own local branches no other scenario
// touches.
let homes = 0;
function setupHome(seedRepos = [], seedClones = []) {
  const fixture = join(here, 'testdata', 'home');
  const home =
    realpathSync(tmpdir()) + `/casebook-probe-${process.pid}-${homes++}`;

  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(join(home, 'state', 'live'), { recursive: true });
  writeFakeGh(home);

  // Clone the bundle to data/repo.
  const bundlePath = join(fixture, 'data', 'repo.bundle');
  const repoPath = join(home, 'data', 'repo');
  probeGit(home, `clone -q "${bundlePath}" "${repoPath}"`, home);
  // Real clones on this machine ("probe"), with landed branches, under the
  // home: the casebook lane's git runs in them and nowhere else.
  if (seedClones.length) {
    const git = (args) => probeGit(repoPath, args, home);
    const snap = join(repoPath, 'machines', 'probe.json');
    const probe = existsSync(snap)
      ? JSON.parse(readFileSync(snap, 'utf8'))
      : { version: 1, machine: 'probe', roots: [], clones: [] };
    probe.roots = [...(probe.roots ?? []), join(home, 'clones')];
    probe.clones = [
      ...(probe.clones ?? []),
      ...seedClones.map((c) => makeClone(home, c)),
    ];
    writeFileSync(snap, JSON.stringify(probe, null, 2) + '\n');
    git('add -A');
    git('commit -q -m "probe: seed machine snapshots"');
  }

  // Copy the github cache to the state directory, which is where CachePath()
  // looks: $CASEBOOK_HOME/state/github.json (tools.StateDir("casebook") joins
  // $CASEBOOK_HOME with "state").
  const srcCache = join(fixture, 'cache', 'github.json');
  if (existsSync(srcCache)) {
    cpSync(srcCache, join(home, 'state', 'github.json'));
  }
  if (seedRepos.length) {
    const cachePath = join(home, 'state', 'github.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    cache.owners.schuettc.repos.push(...seedRepos);
    for (const r of seedRepos) {
      cache.merged_prs[r.repo] = { fetched: true, at: cache.authored_at };
    }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }
  // Write a minimal config.toml. casebook_repo is left blank so it defaults
  // to CASEBOOK_HOME/data/repo (the clone above).
  writeFileSync(
    join(home, 'config', 'config.toml'),
    [
      'machine = "probe"',
      'user = "schuettc"',
      'casebook_remote = ""',
      'roots = []',
      'sync_interval = "30m"',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );

  return home;
}

// ---- hermetic executors ------------------------------------------------------
//
// serve runs gh for one thing in these probes: verifying an agent-lane step
// the agent reported (a fresh `gh pr view`, `gh repo view`). The Go tests
// give serve apptest.FakeGh for it; the binary has no such seam, so every
// serve the probe starts finds a fake gh first on its PATH, answering the
// verification reads the way apptest.FakeGh does and refusing anything else.
// Nothing the probe starts can reach GitHub: were the fake bypassed, the serve's environment sends a real gh
// to a host that doesn't exist (GH_HOST, a .invalid name) with a token
// that isn't one, and no config of Court's (GH_CONFIG_DIR): it fails closed.
//
// git is real, and hermetic (HERMETIC_GIT above), and every repository it
// touches is under the probe's temp home.
const GH_FAIL_CLOSED = {
  GH_HOST: 'github.invalid',
  GH_TOKEN: 'probe-not-a-token',
  GITHUB_TOKEN: 'probe-not-a-token',
  GH_ENTERPRISE_TOKEN: 'probe-not-a-token',
  GITHUB_ENTERPRISE_TOKEN: 'probe-not-a-token',
  GH_PROMPT_DISABLED: '1',
};
const FAKE_GH = `#!/bin/sh
case "$*" in
  "pr view "*"--json state"*) echo '{"state":"CLOSED"}' ;;
  "issue view "*"--json state"*) echo '{"state":"CLOSED"}' ;;
  "repo view "*"--json isArchived"*) echo '{"isArchived":true}' ;;
  "repo view "*) echo '{}' ;;
  *) echo "probe fake gh: unexpected: $*" >&2; exit 1 ;;
esac
`;

function writeFakeGh(home) {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
}

// makeClone creates a real clone under <home>/clones/<name>, with a bare
// "origin" under <home>/remotes (so a remote delete pushes there), and
// returns its snapshot record (the machines/<m>.json clone shape) with the
// landed verdicts a sync would have written: each branch in c.branches is
// merged into main, pushed, and landed in main.
function makeClone(home, c) {
  const path = join(home, 'clones', c.name);
  const remote = join(home, 'remotes', `${c.name}.git`);
  mkdirSync(path, { recursive: true });
  mkdirSync(dirname(remote), { recursive: true });
  const git = (dir, args) => probeGit(dir, args, home);
  git(home, `init -q --bare "${remote}"`);
  git(path, 'init -q -b main');
  git(path, `remote add origin "${remote}"`);
  writeFileSync(join(path, 'README'), `${c.name}\n`);
  git(path, 'add README');
  git(path, 'commit -q -m init');
  const branches = [];
  for (const b of c.branches) {
    git(path, `switch -q -c "${b}" main`);
    writeFileSync(join(path, `${b.replace(/\W/g, '_')}.txt`), `${b}\n`);
    git(path, 'add -A');
    git(path, `commit -q -m "${b}"`);
    const tip = git(path, 'rev-parse HEAD');
    git(path, 'switch -q main');
    git(path, `merge -q --ff-only "${b}"`);
    git(path, `push -q origin "${b}"`);
    git(path, `branch -q --set-upstream-to="origin/${b}" "${b}"`);
    branches.push({
      name: b,
      tip,
      tip_at: '2026-09-20T00:00:00Z',
      upstream: `origin/${b}`,
      remote_tip: tip,
      landed_state: 'yes',
      landed: 'in main',
      landed_tip: tip,
      landed_how: 'default-branch',
    });
  }
  git(path, 'push -q origin main');
  return {
    path,
    repo: `schuettc/${c.name}`,
    remotes: { origin: `schuettc/${c.name}` },
    branches: [
      { name: 'main', tip: git(path, 'rev-parse main'), landed_state: 'no' },
      ...branches,
    ],
  };
}

// Wait up to timeoutMs for the advert file to appear and return its contents.
function waitForAdvert(advertPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      try {
        const text = readFileSync(advertPath, 'utf8');
        const adv = JSON.parse(text);
        if (adv.url && adv.token) {
          clearInterval(poll);
          resolve(adv);
        }
      } catch {
        // not yet — keep polling
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`casebook serve did not start within ${timeoutMs}ms`));
      }
    }, 100);
  });
}

/**
 * Start a seeded casebook serve.
 * Always uses --no-open and CASEBOOK_NO_BROWSER=1 so no browser tab opens.
 * Returns { url, base, token, stop } where stop() kills the serve process.
 */
export async function startServe(opts = {}) {
  const bin = findBinary();
  const home = setupHome(opts.seedRepos, opts.seedClones);
  const advertPath = join(home, 'state', 'live', 'serve.json');

  let exited = false;
  let stderr = '';
  const proc = spawn(bin, SERVE_ARGS, {
    env: {
      ...process.env,
      CASEBOOK_HOME: home,
      HOME: home,
      // The fake gh first on PATH (then the git guard); git without Court's
      // config; a real gh, were it reached, fails closed.
      PATH: `${join(home, 'bin')}:${process.env.PATH}`,
      ...HERMETIC_GIT,
      ...GH_FAIL_CLOSED,
      GH_CONFIG_DIR: join(home, 'gh'),
      // Disables browser opening via the test seam in cli/workbench.go:
      // with it, even a serve that finds a tab was open (which reopens the
      // page whatever --no-open says) opens nothing.
      CASEBOOK_NO_BROWSER: '1',
    },
    stdio: 'pipe',
  });
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });
  proc.on('exit', () => {
    exited = true;
  });
  let adv;
  try {
    adv = await waitForAdvert(advertPath);
  } catch (err) {
    if (!exited) proc.kill();
    throw new Error(`${String(err)}\nstderr: ${stderr}`);
  }

  return {
    url: adv.url,
    base: adv.base,
    token: adv.token,
    home,
    stop() {
      if (!exited) proc.kill();
      // serve shuts down gracefully and may still be finishing a background
      // push into home for a moment after the kill, so a single rm can meet
      // ENOTEMPTY. Retry with backoff; a home that still can't be removed is
      // a temp-dir leak, never a reason to fail the run.
      try {
        rmSync(home, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch (err) {
        console.error(`probe: could not remove ${home}: ${err.code ?? err}`);
      }
    },
  };
}
