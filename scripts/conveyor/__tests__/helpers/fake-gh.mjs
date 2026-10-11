/**
 * @file fake-gh.mjs — a REAL `gh` executable on `PATH` that costs nothing to run and needs no auth/network.
 *
 * TWO GENERATIONS LIVE HERE, ON PURPOSE.
 *
 * GENERATION 1 — {@link withFakeGh} — is UNCHANGED (#3445, the dispatcher-fixture-root thread, #3402). It
 * answers exactly `pr list` (from a canned `prs` array) and `pr view <n> --json comments` (from a canned
 * `comments` map) via its own self-contained embedded shim string. Existing callers
 * (`scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs`,
 * `scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`,
 * `scripts/readiness/__tests__/conveyor-state-pr-list-single-spawn.test.mjs`,
 * `scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`) import it exactly as
 * before — this generation's code is untouched below (down to its own docblock) so those tests keep passing
 * unmodified.
 *
 * GENERATION 2 — {@link createFakeGithub} (#3383, the daemon-scenario-simulator epic, part 2 "Fake GitHub" —
 * see `reports/2026-09-24-daemon-scenario-simulator.md`) — is a STATEFUL fake GitHub: a real `gh` on `PATH`
 * backed by a JSON store file, guarded by an atomic-mkdir lock, written tmp+rename, with branch/merge facts
 * derived at READ TIME from a REAL bare origin repo (never canned). It exists because the simulator needs
 * `gh` calls made by DIFFERENT processes (the daemon hosts, pass scripts, fake agent sessions, and the test's
 * own setup code) to see and mutate the SAME PRs/labels/comments — generation 1's per-fixture canned-JSON
 * shape has no way to express "daemon A labels a PR, daemon B's next `pr view` sees the label", because
 * nothing in it is a state machine. The CLI half (the `gh` stand-in every one of those processes actually
 * execs) lives in the sibling file `fake-gh-shim.mjs` — see that file's header for the exact verb/field/path
 * surface it answers and why the shim is a REAL FILE ON DISK (not an embedded string like generation 1's),
 * so a relative import can share this module's store/lock/transition code without copying it.
 *
 * WHY GENERATION 2's STATE LIVES BEHIND PURE FUNCTIONS. `openPrPure`, `addLabelsPure`, `mergePrPure`, etc.
 * below take a plain `repoState` object and return/mutate it with no I/O — no lock, no git, no file. That is
 * what makes them independently unit-testable (the task's own requirement): a test can assert "adding a label
 * that doesn't exist throws LABEL_NOT_FOUND" or "merging closes a stacked PR unless deleteBranchOnMerge" by
 * constructing a `repoState` literal and calling the function, with no `mkdtemp`, no lock file, no subprocess.
 * The IMPURE half — `refOid`, `computeMergeStatus`, `createMergeCommit`, `listChangedFiles*`, `listCommits` —
 * is kept separate for the same reason generation 1's own header gives for splitting `exec`/`runNode`:
 * overriding the high seam replaces the code under test, overriding the low one exercises it. Both the
 * in-process JS API ({@link createFakeGithub}'s returned object) and the out-of-process CLI
 * (`fake-gh-shim.mjs`) call the SAME pure + impure functions against the SAME store file, so there is exactly
 * one state machine, reached two ways — never two implementations that could drift.
 *
 * LOGGING/EXIT DISCIPLINE CARRIES FORWARD. Generation 2's shim inherits generation 1's two hard-won rules
 * verbatim (see generation 1's own docblock below for the incident each closes): one `appendFileSync` per
 * call, never a read-modify-write of a shared log; and the response path never calls `process.exit()` right
 * after writing stdout — it sets `process.exitCode` and returns, so Node drains the pipe on its own. A 200-PR
 * `pr list` fixture is one of this generation's own required tests for exactly that second reason.
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, chmodSync, rmSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================================================
// GENERATION 1 — unchanged. See this file's header, "GENERATION 1", for why nothing below this line (down to
// the "GENERATION 2" banner) may change shape.
// ============================================================================================================

/**
 * WHY THIS EXISTS (#3445, the dispatcher-fixture-root thread, #3402). `scripts/readiness/conveyor-state.mjs`
 * shells the real `gh pr list …` to build `state.prs`, and `scripts/conveyor/tick-core.mjs` shells `gh pr view
 * … --json comments` for the durable fix/ci-heal retry floor. A harness test that wants to assert the
 * conveyor-state → dispatch-plan → tick-core chain against a SYNTHETIC backlog corpus (mkdtemp + `--backlog-dir`)
 * still hits the REAL `gh` for those two calls unless something stands in for it — and a fixture corpus is
 * worthless if the PR picture behind it is still live production data. Mirrors
 * `scripts/operations/__tests__/helpers/fake-claude.mjs`: same shape (a shim written to a temp dir, prepended
 * onto `PATH`), same reasoning (exercise the real `execFileSync('gh', …)` call path unmodified, never inject a
 * replacement spawner).
 *
 * WHAT THIS IS NOT. It does not talk to GitHub, and it does not model every `gh` subcommand — only the two this
 * repo's readiness/tick machinery actually shells (`pr list`, `pr view … --json comments`). Anything else is an
 * unknown-subcommand failure, on purpose: a caller that starts relying on a THIRD `gh` verb should have that
 * surfaced as a fixture gap, not silently answered with an empty guess.
 *
 * LOGGING IS ONE `appendFileSync` PER CALL, NEVER A READ-MODIFY-WRITE OF THE WHOLE LOG (x3xz8qp/#3988). The
 * shim used to `readFileSync` the log, push onto its parsed `.calls` array, then `writeFileSync` it back whole —
 * safe for one caller at a time, but `dispatch-plan.mjs`'s already-done ground-truth pass (#3457/#3460) spawns
 * MANY of these concurrently (`Promise.all`, by design — see that file's own header comment on why sequential
 * was the bug). Many concurrent shim processes racing the same read→modify→write lost entries under real
 * concurrency (measured live: 70 concurrent calls logged as few as 55) — a silent undercount that would have
 * hidden, not caught, a spawn-count regression in exactly the kind of test this file exists to support. Each
 * call now `appendFileSync`s its OWN one-line JSON record (mirrors `node-spy.mjs`'s already-safe technique); a
 * small single `write()` to an `O_APPEND` file descriptor is atomic on POSIX, so concurrent appends interleave
 * as whole lines and no entry is ever lost or torn.
 *
 * THE RESPONSE NEVER CALLS `process.exit()` RIGHT AFTER `process.stdout.write()` (x3xz8qp/#3988, the SAME
 * incident that found the logging race above — a large-fixture spawn-count test is what finally exercised a
 * `pr list` payload big enough to hit this). `stdout` to a pipe is written ASYNCHRONOUSLY in Node; an immediate
 * `process.exit()` can tear down the process before the write actually drains, silently truncating the parent's
 * read. Small fixtures (a handful of PRs) never crossed the ~8KB pipe-buffer threshold where this bites, so it
 * went unnoticed until a 150-PR fixture came back as `"Unterminated string in JSON at position 8192"` —
 * `execFileSync('gh', …)`'s caller in `conveyor-state.mjs` degraded that to an empty `state.prs` (its own
 * fail-soft `catch`), which would have made a spawn-count test pass for the wrong reason (nothing to count
 * because the payload never arrived) rather than proving the real thing. Fixed by never calling `process.exit()`
 * on the success paths at all: the script just returns, Node drains stdout and exits on its own once the event
 * loop is empty.
 */

/** The shim, as a node script. One string so the fixture is a single file with nothing to resolve. */
const SHIM = `#!/usr/bin/env node
// A stand-in for the \`gh\` CLI. Answers exactly the two calls the readiness/tick machinery shells — see
// fake-gh.mjs for why. Written by fake-gh.mjs.
const { readFileSync, appendFileSync } = require('node:fs');
const FIXTURE = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const LOG = process.env.FAKE_GH_LOG;
const argv = process.argv.slice(2);

// One line per call, appended atomically (never a read-modify-write of the whole log — see this file's own
// header on why: concurrent shim processes racing a read/write cycle silently lose entries).
appendFileSync(LOG, JSON.stringify({ argv }) + '\\n');

if (argv[0] === 'pr' && argv[1] === 'list') {
  // No \`process.exit()\` here on purpose — see this file's own header on why an immediate exit can truncate a
  // large payload before the async pipe write drains. The process exits on its own once the event loop empties.
  process.stdout.write(JSON.stringify(FIXTURE.prs || []));
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  const num = Number(argv[2]);
  const comments = (FIXTURE.comments && FIXTURE.comments[num]) || [];
  process.stdout.write(JSON.stringify({ comments }));
} else {
  process.stderr.write('fake-gh: unhandled subcommand ' + argv.join(' ') + '\\n');
  process.exitCode = 1;
}
`;

/**
 * Stand up a fake `gh` on disk, canned to answer `pr list` with `prs` and `pr view <n> --json comments` with
 * `comments[n]` (default `[]`).
 *
 * @param {{prs?: object[], comments?: Record<number, object[]>}} [fixture]
 * @returns {{ env: Record<string,string>, calls: () => Array<{argv:string[]}>, cleanup: () => void }}
 */
export function withFakeGh({ prs = [], comments = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const bin = join(dir, 'gh');
  const fixturePath = join(dir, 'fixture.json');
  const logPath = join(dir, 'calls.json'); // NDJSON despite the name — one `{argv}` record per line, see header.
  writeFileSync(bin, SHIM, 'utf8');
  chmodSync(bin, 0o755);
  writeFileSync(fixturePath, JSON.stringify({ prs, comments }), 'utf8');
  writeFileSync(logPath, '', 'utf8');

  return {
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_GH_FIXTURE: fixturePath, FAKE_GH_LOG: logPath },
    calls: () => {
      try {
        return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

// ============================================================================================================
// GENERATION 2 — the stateful fake GitHub (#3383). Everything below is new.
// ============================================================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
/** The CLI half — a real sibling file so `fake-gh-shim.mjs` can `import` this module's code directly instead
 *  of duplicating it (see this file's header). */
const SHIM_PATH = join(HERE, 'fake-gh-shim.mjs');

// ---------------------------------------------------------------------------------------------------------
// Store + lock plumbing, shared byte-for-byte between the in-process JS API below and `fake-gh-shim.mjs`
// (which imports these exact functions rather than re-implementing them).
// ---------------------------------------------------------------------------------------------------------

/** A stale lock (its holder died mid-call) is taken over after this long — long enough that no real call in
 *  this fixture (including a `pr merge` that shells a few `git` subprocesses) should ever legitimately hold
 *  the lock this long, short enough that a genuinely wedged test does not hang the whole suite. */
export const LOCK_STALE_MS = 10_000;
/** How long a caller will retry the mkdir before giving up and throwing — comfortably above the stale window
 *  so a legitimate stale-takeover always gets a chance to happen before a caller gives up on it. */
const LOCK_RETRY_TIMEOUT_MS = 20_000;

/** Synchronous sleep with no busy-loop CPU spin — same technique `fake-claude.mjs` uses for its own
 *  `FAKE_CLAUDE_WORK_MS` foreground-blocking branch. */
export function sleepSyncMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the store's lock via atomic `mkdir` (EEXIST is the only correctness-relevant failure mode of
 * `mkdir` — two processes racing it never both succeed). Retries with a short randomized backoff; a lock
 * whose holder record is older than {@link LOCK_STALE_MS} is force-taken (the holder crashed mid-call and
 * would otherwise wedge every future caller forever).
 *
 * @param {string} storePath
 * @returns {string} the lock directory path — pass to {@link releaseStoreLock} to release it
 */
export function acquireStoreLock(storePath) {
  const lockPath = `${storePath}.lock`;
  const holderPath = join(lockPath, 'holder.json');
  const deadline = Date.now() + LOCK_RETRY_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(holderPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const holder = JSON.parse(readFileSync(holderPath, 'utf8'));
        if (Date.now() - holder.at > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          continue; // retry the mkdir immediately — no need to sleep first, the slot is free now
        }
      } catch {
        // holder.json missing or mid-write (another process is between mkdir and the holder write) — not
        // yet provably stale, fall through to the ordinary backoff-and-retry below.
      }
      if (Date.now() > deadline) throw new Error(`fake-gh: timed out acquiring lock ${lockPath}`);
      sleepSyncMs(5 + Math.floor(Math.random() * 15));
    }
  }
}

/** Release a lock acquired by {@link acquireStoreLock}. Best-effort: a missing lock dir is not an error. */
export function releaseStoreLock(lockPath) {
  try { rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

/** The empty store shape — every field a caller might read is present so nothing has to null-check it. */
function emptyStore() {
  return { repos: {}, tokens: { revoked: [] }, faults: {} };
}

export function readStoreSync(storePath) {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}

/** tmp-write + rename — the write is atomic from any concurrent reader's point of view (a reader never sees
 *  a half-written file), matching this repo's other store fixtures' own convention. */
export function writeStoreSync(storePath, store) {
  const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(store), 'utf8');
  renameSync(tmp, storePath);
}

/**
 * Run `fn(store)` with the store locked, write whatever `fn` left `store` looking like back to disk, and
 * release the lock — always, including on the throwing path. `fn`'s return value passes through.
 *
 * @param {string} storePath
 * @param {(store: object) => any} fn
 */
export function withStore(storePath, fn) {
  const lockPath = acquireStoreLock(storePath);
  try {
    const store = readStoreSync(storePath);
    const result = fn(store);
    writeStoreSync(storePath, store);
    return result;
  } finally {
    releaseStoreLock(lockPath);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pure state-transition functions. Every one of these takes a plain `repoState` object — one value of
// `store.repos[slug]` — and mutates + returns it (or a value derived from it). NONE of them touch a file,
// a lock, or `git`; a unit test constructs a `repoState` literal and calls these directly.
// ---------------------------------------------------------------------------------------------------------

function isoNow(now) { return new Date(now).toISOString(); }

export function ensureLabelExists(repoState, name) {
  return Object.prototype.hasOwnProperty.call(repoState.labels, name);
}

/** `gh label create NAME [--force]`. Throws `LABEL_EXISTS` on a duplicate create with no `--force`, exactly
 *  like the real CLI. */
export function createLabelPure(repoState, name, { color = 'ededed', description = '', force = false } = {}) {
  if (ensureLabelExists(repoState, name) && !force) {
    const err = new Error(`'${name}' already exists`);
    err.code = 'LABEL_EXISTS';
    throw err;
  }
  repoState.labels[name] = { color, description };
  return repoState.labels[name];
}

export function requirePr(repoState, number) {
  const pr = repoState.prs[String(number)];
  if (!pr) {
    const err = new Error(`no pull requests found for #${number}`);
    err.code = 'PR_NOT_FOUND';
    throw err;
  }
  return pr;
}

/** `gh pr edit --add-label X [--add-label Y …]`. Throws `LABEL_NOT_FOUND` for any label the repo has never
 *  seen `label create`d — a fixture gap is loud, exactly like real `gh` refusing an unknown label. Adding a
 *  label the PR already carries is a silent no-op (no duplicate `labeled` event), matching real GitHub. */
export function addLabelsPure(repoState, number, names, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  for (const name of names) {
    if (!ensureLabelExists(repoState, name)) {
      const err = new Error(`'${name}' not found`);
      err.code = 'LABEL_NOT_FOUND';
      throw err;
    }
  }
  for (const name of names) {
    if (!pr.labels.includes(name)) {
      pr.labels.push(name);
      pr.events.push({ event: 'labeled', label: name, actor, createdAt: isoNow(now) });
    }
  }
  pr.updatedAt = isoNow(now);
  return pr;
}

export function removeLabelsPure(repoState, number, names, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  for (const name of names) {
    const idx = pr.labels.indexOf(name);
    if (idx !== -1) {
      pr.labels.splice(idx, 1);
      pr.events.push({ event: 'unlabeled', label: name, actor, createdAt: isoNow(now) });
    }
  }
  pr.updatedAt = isoNow(now);
  return pr;
}

/** `gh pr comment`. `author` is who WROTE the comment; `viewerDidAuthor` is computed later, at read time,
 *  against whichever actor is doing the READING (see {@link buildPrGraphqlView}) — it is never stored. */
export function addCommentPure(repoState, number, body, { author = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  const id = repoState.nextCommentId++;
  const comment = { id, author: { login: author }, body, createdAt: isoNow(now) };
  pr.comments.push(comment);
  pr.updatedAt = isoNow(now);
  return comment;
}

export function setChecksPure(repoState, number, checks = []) {
  const pr = requirePr(repoState, number);
  const now = isoNow(Date.now());
  pr.checks = checks.map((c) => ({
    name: c.name,
    status: c.status || 'COMPLETED',
    conclusion: c.conclusion || 'SUCCESS',
    startedAt: c.startedAt || now,
    completedAt: c.completedAt || now,
  }));
  return pr;
}

export function closePrPure(repoState, number, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  if (pr.state === 'OPEN') {
    pr.state = 'CLOSED';
    pr.closedAt = isoNow(now);
    pr.events.push({ event: 'closed', actor, createdAt: pr.closedAt });
  }
  return pr;
}

export function reopenPrPure(repoState, number, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  if (pr.state === 'CLOSED') {
    pr.state = 'OPEN';
    pr.closedAt = null;
    pr.events.push({ event: 'reopened', actor, createdAt: isoNow(now) });
  }
  return pr;
}

/** Marks `number` MERGED. Does NOT touch any other PR — see {@link applyBranchDeletionPure} for the
 *  stacked-PR fallout `--delete-branch` causes, kept separate because it is itself independently testable. */
export function mergePrPure(repoState, number, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const pr = requirePr(repoState, number);
  pr.state = 'MERGED';
  pr.mergedAt = isoNow(now);
  pr.closedAt = pr.mergedAt;
  pr.events.push({ event: 'merged', actor, createdAt: pr.mergedAt });
  return pr;
}

/**
 * The GitHub-performed transition a `pr merge --delete-branch` causes for every OTHER open PR stacked on the
 * branch that just got deleted (design doc "Fake GitHub state model" / #3383 incident I-03/I-18/N-18):
 * CLOSED, unless `repoState.deleteBranchOnMerge` is set, in which case RETARGETED onto `newBase` instead.
 *
 * @returns {number[]} the PR numbers touched
 */
export function applyBranchDeletionPure(repoState, deletedBranch, newBase, { actor = 'we-daemon-bot', now = Date.now() } = {}) {
  const touched = [];
  for (const pr of Object.values(repoState.prs)) {
    if (pr.state !== 'OPEN' || pr.baseRefName !== deletedBranch) continue;
    if (repoState.deleteBranchOnMerge) {
      pr.baseRefName = newBase;
      pr.events.push({ event: 'base_ref_changed', actor, createdAt: isoNow(now) });
    } else {
      pr.state = 'CLOSED';
      pr.closedAt = isoNow(now);
      pr.events.push({ event: 'closed', actor, createdAt: pr.closedAt });
    }
    pr.updatedAt = isoNow(now);
    touched.push(pr.number);
  }
  return touched;
}

/** `gh pr create` / the JS API's `openPr`. Applies `labels` through {@link addLabelsPure} (so an unknown seed
 *  label fails exactly the same way a later `--add-label` would — one rule, not two). */
export function openPrPure(repoState, {
  head, base, title, body = '(body)', labels = [], author = 'agent', isDraft = false,
  checks = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], now = Date.now(), headRefOid = null,
} = {}) {
  const number = repoState.nextPrNumber++;
  const nowIso = isoNow(now);
  const pr = {
    number, title: title ?? `PR #${number}`, body, author: { login: author },
    headRefName: head, baseRefName: base || repoState.defaultBranch, isDraft,
    state: 'OPEN', createdAt: nowIso, updatedAt: nowIso, closedAt: null, mergedAt: null,
    labels: [], comments: [],
    checks: checks.map((c) => ({
      name: c.name, status: c.status || 'COMPLETED', conclusion: c.conclusion || 'SUCCESS',
      startedAt: nowIso, completedAt: nowIso,
    })),
    events: [],
    lastKnownHeadRefOid: headRefOid,
  };
  repoState.prs[String(number)] = pr;
  if (labels.length) addLabelsPure(repoState, number, labels, { actor: 'we-daemon-bot', now });
  return pr;
}

export function filterPrs(repoState, { state = 'open', head, base, label } = {}) {
  const s = String(state).toUpperCase();
  const wanted = s === 'ALL' ? null : (s === 'OPEN' || s === 'CLOSED' || s === 'MERGED') ? s : 'OPEN';
  return Object.values(repoState.prs)
    .filter((pr) => {
      if (wanted && pr.state !== wanted) return false;
      if (head && pr.headRefName !== head) return false;
      if (base && pr.baseRefName !== base) return false;
      if (label && !pr.labels.includes(label)) return false;
      return true;
    })
    .sort((a, b) => b.number - a.number);
}

/** `'a, b,c'` → `['a','b','c']` — the one place a `gh --json`/`--jq`-adjacent CSV field list is parsed. */
export function parseFieldsCsv(fieldsCsv) {
  return String(fieldsCsv).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Pick exactly `fieldsCsv` (a `gh --json`-style comma list) off `obj`, in the order given — mirrors how
 *  `gh --json a,b` shapes its output regardless of the object's own key order. */
export function pickFields(obj, fieldsCsv) {
  const out = {};
  for (const f of parseFieldsCsv(fieldsCsv)) out[f] = obj[f];
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Impure, git-derived computations. All take `originPath` explicitly (never read it off ambient state) so a
// test can point them at any real bare repo it built.
// ---------------------------------------------------------------------------------------------------------

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function branchExists(originPath, branch) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: originPath, encoding: 'utf8' });
  return res.status === 0;
}

/** The current oid a ref resolves to on the real origin, or `null` if the ref no longer exists (a deleted
 *  head branch — see this file's header + the design doc on why a PR then falls back to its
 *  `lastKnownHeadRefOid`). */
export function refOid(originPath, ref) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: originPath, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Mirror real GitHub's `refs/pull/<n>/head` on the origin, so a daemon that fetches a PR by NUMBER
 *  (`we:scripts/conveyor/reconcile-pass.mjs#defaultFetchRef`) resolves it here as it does live. Best-effort;
 *  only re-written when the head moved since the last publish. */
export function publishPullRef(originPath, pr, oid) {
  if (!oid || pr.pullRefOid === oid) return;
  const res = spawnSync('git', ['update-ref', `refs/pull/${pr.number}/head`, oid], { cwd: originPath, encoding: 'utf8' });
  if (res.status === 0) pr.pullRefOid = oid;
}

/** `git merge-tree --write-tree <base> <head>` — exit 0 = clean merge (stdout's first line is the resulting
 *  tree oid), exit 1 = CONFLICTING, anything else = an error this fixture did not expect. See the design doc
 *  ("mergeable via `git merge-tree --write-tree`") — measured against git 2.50 to confirm this exit-code
 *  contract before relying on it. */
function mergeTree(originPath, base, head) {
  return spawnSync('git', ['merge-tree', '--write-tree', base, head], { cwd: originPath, encoding: 'utf8' });
}

/**
 * `mergeable` + the inputs {@link buildPrGraphqlView} needs for `mergeStateStatus`. Returns `UNKNOWN` when
 * either ref is missing on origin (matches real GitHub, which cannot compute mergeability without both
 * sides).
 */
export function computeMergeStatus(originPath, base, head) {
  if (!refOid(originPath, base) || !refOid(originPath, head)) {
    return { mergeable: 'UNKNOWN', conflicting: null, behindCount: 0 };
  }
  const res = mergeTree(originPath, base, head);
  const conflicting = res.status === 1;
  const mergeable = res.status === 0 ? 'MERGEABLE' : conflicting ? 'CONFLICTING' : 'UNKNOWN';
  let behindCount = 0;
  try { behindCount = Number(runGit(['rev-list', `${head}..${base}`, '--count'], originPath).trim()) || 0; } catch { behindCount = 0; }
  return { mergeable, conflicting, behindCount };
}

/** Real merge commit: `merge-tree --write-tree` for the tree, `commit-tree -p base -p head` for the commit,
 *  `update-ref` to land it on `baseBranch`, then (if asked) delete `headBranch`. Throws `CONFLICTING` instead
 *  of ever writing a broken merge — real `gh pr merge` refuses too. */
export function createMergeCommit(originPath, { baseBranch, baseOid, headOid, message, deleteHeadBranch, headBranch }) {
  const res = mergeTree(originPath, baseOid, headOid);
  if (res.status !== 0) {
    const err = new Error('not mergeable');
    err.code = 'CONFLICTING';
    throw err;
  }
  const treeOid = res.stdout.trim().split('\n')[0];
  const commitOid = runGit(['commit-tree', treeOid, '-p', baseOid, '-p', headOid, '-m', message], originPath).trim();
  runGit(['update-ref', `refs/heads/${baseBranch}`, commitOid], originPath);
  if (deleteHeadBranch) runGit(['update-ref', '-d', `refs/heads/${headBranch}`], originPath);
  return commitOid;
}

/**
 * #3383 scenario A2 — a real `git` push straight onto `branch` of `originPath`, run from a scratch clone
 * (mkdtemp'd, removed afterward). Used ONLY by the `kind:'push-to-main'` fault ({@link createFakeGithub}'s own
 * `fault()` docblock) to make "origin/main advances MID-TICK" deterministic: the fault fires from INSIDE the
 * `gh` shim's own dispatch (see `fake-gh-shim.mjs`), i.e. from the middle of whatever real `gh` call the
 * daemon's own tick happens to make (`pr list`, typically), so the push genuinely lands between the tick's
 * own tick-start self-sync and the rest of that same tick's work — no separate scenario-runner step could ever
 * land it at that exact point, since a play-array step only ever runs BETWEEN ticks, never inside one.
 * @param {string} originPath
 * @param {string} branch
 * @param {Record<string,string>} files
 * @param {string} message
 */
export function pushCommitToRef(originPath, branch, files = {}, message = 'sim: fault-injected commit') {
  const work = mkdtempSync(join(tmpdir(), 'fake-gh-push-'));
  try {
    execFileSync('git', ['clone', '--quiet', originPath, work], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['checkout', branch], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [name, content] of Object.entries(files)) {
      const p = join(work, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
    execFileSync('git', ['add', '-A'], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', [
      '-c', 'user.email=sim-fault@example.com', '-c', 'user.name=Sim Fault', '-c', 'commit.gpgsign=false',
      'commit', '-m', message,
    ], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function mergeBaseOf(originPath, base, head) {
  try { return runGit(['merge-base', base, head], originPath).trim(); } catch { return base; }
}

/** `--json files` shape: `{path, additions, deletions}` (gh's own GraphQL-backed shape — see this file's
 *  header on why this differs from {@link listChangedFilesRest}'s REST shape). */
export function listChangedFilesNative(originPath, base, head) {
  const mb = mergeBaseOf(originPath, base, head);
  const out = runGit(['diff', '--numstat', mb, head], originPath);
  return out.split('\n').filter(Boolean).map((line) => {
    const [add, del, path] = line.split('\t');
    return { path, additions: add === '-' ? 0 : Number(add), deletions: del === '-' ? 0 : Number(del) };
  });
}

/** REST shape: `{filename, status, patch}` — used by `pulls/{n}/files` and `compare/{a}...{b}`.
 *  `maxPatched` bounds how many entries carry a `patch` (one `git diff` each — 300+ file PRs would otherwise run
 *  past a daemon tick); the rest get `''`, as GitHub itself omits patches for very large diffs (PR #3881). */
export function listChangedFilesRest(originPath, base, head, { maxPatched = Infinity } = {}) {
  const mb = mergeBaseOf(originPath, base, head);
  const lines = runGit(['diff', '--name-status', mb, head], originPath).split('\n').filter(Boolean);
  return lines.map((line, idx) => {
    const [code, path] = line.split('\t');
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'removed' : code.startsWith('R') ? 'renamed' : 'modified';
    let patch = '';
    if (idx < maxPatched) {
      try {
        const raw = runGit(['diff', '--unified=3', mb, head, '--', path], originPath);
        const at = raw.indexOf('\n@@');
        patch = at === -1 ? '' : raw.slice(at + 1);
      } catch { patch = ''; }
    }
    return { filename: path, status, patch };
  });
}

/** `commits: [{oid, messageHeadline, messageBody, authors: [{name, email}]}]`. */
export function listCommits(originPath, base, head) {
  const mb = mergeBaseOf(originPath, base, head);
  let out;
  try { out = runGit(['log', '--format=%H%x1f%an%x1f%ae%x1f%s%x1f%b%x1e', `${mb}..${head}`], originPath); } catch { return []; }
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [oid, name, email, subject, bodyRaw] = rec.split('\x1f');
    return { oid, messageHeadline: subject || '', messageBody: (bodyRaw || '').trim(), authors: [{ name, email }] };
  });
}

// ---------------------------------------------------------------------------------------------------------
// JSON view builders — the ONE place that turns `repoState` + git facts into the shapes `gh` actually prints.
// ---------------------------------------------------------------------------------------------------------

/**
 * The full `gh --json` (GraphQL-backed, camelCase) view of one PR. Every derived field is computed HERE, at
 * read time, never cached in the store — see the design doc's "always recomputed from the real origin at
 * read time" invariant.
 *
 * `fields` (an array of requested `--json` field names, or `null` for "compute everything") makes the git
 * work LAZY: `mergeable`/`mergeStateStatus`/`files`/`commits` each cost real `git` subprocess spawns
 * (merge-tree, diff, log), and a `pr list --json number,title` of 200 PRs has no reason to pay for any of
 * them. The JS API's `pr()`/`prs()` pass no `fields` (always wants the full view); the CLI shim passes the
 * caller's own `--json` list straight through.
 */
export function buildPrGraphqlView(repoState, pr, { originPath, callerActor, fields = null }) {
  const want = (name) => !fields || fields.includes(name);
  const needHeadOid = want('headRefOid') || want('mergeable') || want('mergeStateStatus') || want('files') || want('commits');
  const needBaseOid = want('mergeable') || want('mergeStateStatus') || want('files') || want('commits');
  const needMergeInfo = want('mergeable') || want('mergeStateStatus');
  const needFiles = want('files');
  const needCommits = want('commits');

  let headOid = pr.lastKnownHeadRefOid;
  if (needHeadOid) {
    const liveHeadOid = refOid(originPath, pr.headRefName);
    if (liveHeadOid) pr.lastKnownHeadRefOid = liveHeadOid; // best-effort remember-last, see design doc point 3
    publishPullRef(originPath, pr, liveHeadOid);
    headOid = liveHeadOid || pr.lastKnownHeadRefOid;
  }
  const baseOid = needBaseOid ? refOid(originPath, pr.baseRefName) : null;

  let mergeable = 'UNKNOWN';
  let mergeStateStatus = 'UNKNOWN';
  let files = [];
  let commits = [];
  if (headOid && baseOid && (needMergeInfo || needFiles || needCommits)) {
    // Resolved OIDs, never the branch NAME strings, from here on — `pr.headRefName` can no longer resolve
    // once its branch is deleted (a merged PR's own head, per the design doc's "reads headRefOid of its last
    // known sha"), and `git diff`/`merge-tree` against a dangling name fails loudly instead of falling back.
    if (needMergeInfo) {
      const status = computeMergeStatus(originPath, baseOid, headOid);
      mergeable = status.mergeable;
      const anyCheckFailed = pr.checks.some((c) => c.conclusion === 'FAILURE');
      if (status.conflicting) mergeStateStatus = 'DIRTY';
      else if (anyCheckFailed) mergeStateStatus = 'UNSTABLE';
      else if (status.behindCount > 0) mergeStateStatus = 'BEHIND';
      else mergeStateStatus = 'CLEAN';
    }
    if (needFiles) files = listChangedFilesNative(originPath, baseOid, headOid);
    if (needCommits) commits = listCommits(originPath, baseOid, headOid);
  }

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    url: `https://github.com/${repoState.slug}/pull/${pr.number}`,
    isDraft: pr.isDraft,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    headRefName: pr.headRefName,
    headRefOid: headOid,
    baseRefName: pr.baseRefName,
    // Every fake PR lives in its own repo (no fork model) — the same-repo guard (`sameRepoRefusal`) reads this.
    isCrossRepository: false,
    mergeable,
    mergeStateStatus,
    labels: pr.labels.map((name) => ({ name })),
    comments: pr.comments.map((c) => ({ ...c, viewerDidAuthor: c.author.login === callerActor })),
    statusCheckRollup: pr.checks.map((c) => ({
      __typename: 'CheckRun', name: c.name, status: c.status, conclusion: c.conclusion,
      startedAt: c.startedAt, completedAt: c.completedAt,
    })),
    commits,
    files,
    reviewDecision: null,
  };
}

/** `repos/{o}/{r}/issues/{n}/events` (and the shared half of `/timeline`) — REST shape, snake_case. */
export function restEvent(e) {
  const out = { event: e.event, actor: { login: e.actor }, created_at: e.createdAt };
  if (e.label) out.label = { name: e.label };
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// createFakeGithub — the in-process JS API. Same store + lock the CLI shim uses (see `fake-gh-shim.mjs`), so
// a scenario's own setup code (`w.gh.openPr(...)`) and a daemon's `execFileSync('gh', …)` see one truth.
// ---------------------------------------------------------------------------------------------------------

const SEED_LABELS = [
  'review:pending', 'review:accepted', 'review:changes', 'review:human',
  'advisory:accepted', 'advisory:changes',
  'redteam:accepted',
  'ready-to-merge',
  'merge-status:conflicting', 'merge-status:checking',
];

function seedLabels() {
  const labels = {};
  for (const name of SEED_LABELS) labels[name] = { color: 'ededed', description: '' };
  return labels;
}

/**
 * Stand up a stateful fake GitHub: writes the `gh` shim wrapper + an empty store under `root`, and returns
 * the JS API described in `fake-gh-shim.mjs`'s sibling design doc / this task's brief.
 *
 * @param {{root: string, repos: Array<{slug:string, originPath:string, defaultBranch?:string, deleteBranchOnMerge?:boolean}>, actor?: string}} o
 */
export function createFakeGithub({ root, repos, actor = 'we-daemon-bot' }) {
  mkdirSync(root, { recursive: true });
  const storePath = join(root, 'store.json');
  const logPath = join(root, 'calls.ndjson');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, '', 'utf8');

  const ghBin = join(binDir, 'gh');
  writeFileSync(ghBin, `#!/bin/sh\nexec node "${SHIM_PATH}" "$@"\n`, 'utf8');
  chmodSync(ghBin, 0o755);

  const store = emptyStore();
  for (const r of repos) {
    store.repos[r.slug] = {
      slug: r.slug,
      defaultBranch: r.defaultBranch || 'main',
      deleteBranchOnMerge: !!r.deleteBranchOnMerge,
      originPath: r.originPath,
      labels: seedLabels(),
      prs: {},
      nextPrNumber: 1,
      nextCommentId: 1,
    };
  }
  writeStoreSync(storePath, store);

  const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_GH_STORE: storePath, FAKE_GH_LOG: logPath, FAKE_GH_ACTOR: actor };

  /** Run `fn(repoState, store)` under the shared lock; throws if `slug` was never registered. */
  const withRepo = (slug, fn) => withStore(storePath, (s) => {
    const repoState = s.repos[slug];
    if (!repoState) throw new Error(`createFakeGithub: unknown repo "${slug}" (registered: ${Object.keys(s.repos).join(', ') || '(none)'})`);
    return fn(repoState, s);
  });

  return {
    env,

    openPr({ repo, head, base = 'main', title, body = '(body)', labels = [], author = 'agent', isDraft = false,
      checks = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }) {
      return withRepo(repo, (repoState) => {
        if (!branchExists(repoState.originPath, head)) {
          throw new Error(`createFakeGithub.openPr: head branch "${head}" does not exist on origin ${repoState.originPath}`);
        }
        const headOid = refOid(repoState.originPath, head);
        const pr = openPrPure(repoState, { head, base, title, body, labels, author, isDraft, checks, headRefOid: headOid });
        publishPullRef(repoState.originPath, pr, headOid);
        return pr.number;
      });
    },

    addLabels(repo, number, names) {
      return withRepo(repo, (repoState) => addLabelsPure(repoState, number, names, { actor }));
    },

    removeLabels(repo, number, names) {
      return withRepo(repo, (repoState) => removeLabelsPure(repoState, number, names, { actor }));
    },

    comment(repo, number, body, { author: commentAuthor = actor } = {}) {
      return withRepo(repo, (repoState) => addCommentPure(repoState, number, body, { author: commentAuthor }));
    },

    setChecks(repo, number, checks) {
      return withRepo(repo, (repoState) => setChecksPure(repoState, number, checks));
    },

    /** Declare the repo's branch-protection required status checks, served by the shim's
     *  `branches/{b}/protection` route. Unset (the default) keeps that route unsupported, so readers fall back. */
    setRequiredChecks(repo, names) {
      return withRepo(repo, (repoState) => { repoState.requiredChecks = names.map(String); });
    },

    /** #4075 — seed `gh run list` rows (`{databaseId, headBranch, conclusion, status, createdAt, updatedAt,
     *  workflowName}`) for a repo; replaces any previous set. */
    setRuns(repo, runs) {
      return withRepo(repo, (repoState) => { repoState.runs = runs.map((r) => ({ ...r })); return repoState.runs; });
    },

    closePr(repo, number) {
      return withRepo(repo, (repoState) => closePrPure(repoState, number, { actor }));
    },

    reopenPr(repo, number) {
      return withRepo(repo, (repoState) => reopenPrPure(repoState, number, { actor }));
    },

    mergePr(repo, number, { deleteBranch = true } = {}) {
      return withRepo(repo, (repoState) => {
        const pr = requirePr(repoState, number);
        const baseOid = refOid(repoState.originPath, pr.baseRefName);
        const headOid = refOid(repoState.originPath, pr.headRefName);
        if (!baseOid || !headOid) throw new Error(`createFakeGithub.mergePr: missing base/head ref for #${number}`);
        const commitOid = createMergeCommit(repoState.originPath, {
          baseBranch: pr.baseRefName, baseOid, headOid,
          message: `Merge pull request #${number} from ${pr.headRefName}`,
          deleteHeadBranch: deleteBranch, headBranch: pr.headRefName,
        });
        mergePrPure(repoState, number, { actor });
        if (deleteBranch) applyBranchDeletionPure(repoState, pr.headRefName, pr.baseRefName, { actor });
        return commitOid;
      });
    },

    pr(repo, number) {
      return withRepo(repo, (repoState) => buildPrGraphqlView(repoState, requirePr(repoState, number), { originPath: repoState.originPath, callerActor: actor }));
    },

    prs(repo) {
      return withRepo(repo, (repoState) => Object.values(repoState.prs)
        .map((pr) => buildPrGraphqlView(repoState, pr, { originPath: repoState.originPath, callerActor: actor }))
        .sort((a, b) => b.number - a.number));
    },

    revokeToken(token) {
      return withStore(storePath, (s) => { if (!s.tokens.revoked.includes(token)) s.tokens.revoked.push(token); });
    },

    /** Arm a fault for the next `times` calls whose verb matches (e.g. `'pr list'`, `'pr edit'`, `'api'`).
     *  `kind: 'network'` (#4075 soak harness gap, break `sticky-smoke-rejection`) fails the call with Go-style
     *  net/http stderr text (`error connecting to api.github.com` / `dial tcp ...: i/o timeout`) — what a REAL
     *  `gh` (a Go binary) prints on a genuine network fault, distinct from the HTTP_* fixtures the other kinds
     *  use — see `fake-gh-shim.mjs`'s own `GO_NETWORK_ERROR` comment.
     *  `kind: 'no-files'` (verb `'api compare'`, PR #3881) is not a failure either: the compare call answers, but
     *  its body carries no `files` array.
     *  `kind: 'push-to-main'` (#3383, scenario A2 — origin advancing MID-TICK, deterministically, from INSIDE
     *  the daemon's own tick) is not a failure at all: the matching call still answers normally, but the shim
     *  first runs a real `git` push of `files`/`message` onto `branch` (default `main`) of `repo`'s own origin
     *  (default: whichever repo the call itself resolves to) — see {@link pushCommitToRef} and
     *  `fake-gh-shim.mjs`'s own dispatch, which performs this side effect before falling through to the
     *  ordinary verb handler. */
    fault({
      verb, kind, times = 1, repo = null, files = {}, message = 'sim: fault-injected commit', branch = 'main',
      localMessage = null,
    }) {
      return withStore(storePath, (s) => {
        if (!s.faults[verb]) s.faults[verb] = [];
        s.faults[verb].push({ kind, timesLeft: times, repo, files, message, branch, localMessage });
      });
    },

    calls() {
      try { return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    },

    cleanup() {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    },
  };
}
