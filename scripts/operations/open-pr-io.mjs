/**
 * @file scripts/operations/open-pr-io.mjs
 * @description THE IO SHELL of the `open-pr` declaration — one spawn of `we:scripts/pr-land.mjs`.
 *
 * It validates prepare isolation before shelling the home. No `gh` call of its own, no GitHub API, no branch push: every one
 * of those already belongs to `pr-land.mjs`, and a second route to any of them is the bypass this operation
 * exists to close. If this file ever grows an `https` import, the operation has become the problem it names.
 *
 * WHEN THERE IS NO CREDENTIAL, IT FAILS AND SAYS SO. `pr-land.mjs` shells `gh`; on a host where `gh` cannot
 * authenticate the spawn returns a non-verdict and `classifySubmit` reports `unrun` — never `opened`, and
 * never a quiet fall-through to some other channel. The caller still holds the `plan`, which is the argv and
 * the payload the operation decided on, and submits THAT through whatever channel does hold a credential.
 *
 * IMPURE by construction: `child_process`.
 */
import { readMainCard, assertMachineTitle } from './machine-pr-title.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifySubmit, measureNonTestLines, OPEN_PR_MAX_NON_TEST_LINES } from './open-pr.mjs';
import { checkDuplicateBornAs } from '../lib/duplicate-bornas-added.mjs';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { buildGhShimSettingsEnv, defaultShimDir, shimGhPath, resolveOrgAwareShimDir, pathWithOrgAwareShim, isDaemonCaller } from '../lib/gh-app-shim.mjs';

/**
 * #81 — a lane's ref, when the caller did not name one. `lane/<slug>` from the lane lease's `purpose`
 * (`git rev-parse --git-path .lane-lease`). Returns '' when there is no lease/purpose. `read` is injected.
 */
export function deriveLaneRef({
  cwd = process.cwd(),
  read = (c) => readFileSync(execFileSync('git', ['rev-parse', '--git-path', '.lane-lease'], { cwd: c, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().replace(/^(?!\/)/, c + '/'), 'utf8'),
} = {}) {
  try {
    const slug = String(JSON.parse(read(cwd))?.purpose ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `lane/${slug}` : '';
  } catch { return ''; }
}

/**
 * #79 — the credential the rest of the conveyor uses. A background subagent has no app-token shim on PATH, so
 * `gh` ran unauthenticated and pr-land reported a false "no credential". Prefer this checkout's shim (App
 * opted in), else the shared shim dir if it exists and is not already first on PATH; else leave env alone.
 *
 * Card 6931 — a DAEMON caller never falls back: the guarded shim is its auth boundary, and neither fallback below
 * carries the refusal guard. A builder that throws (no real gh, failed shim write) or returns no PATH throws here.
 */
export function resolveGhCredentialEnv({ env = process.env, exists = existsSync, build = buildGhShimSettingsEnv, orgShimDir = () => resolveOrgAwareShimDir({ exists }) } = {}) {
  const daemon = isDaemonCaller(env);
  let built = null;
  try {
    built = build({ env, pathEnv: env.PATH || '' });
  } catch (e) {
    if (daemon) throw e;
  }
  if (built?.PATH) return { ...env, ...built, PATH: pathWithShimFirst(built.PATH.split(':')[0], env.PATH || '') };
  if (daemon) throw new Error('gh-shim: refusing daemon gh call without the gh auth guard (the shim builder returned no PATH)');
  // xpd70wx — the target repo may live in ANY constellation org (plateauapp, frontier-ui, web-everything). The
  // legacy shared shim has no owner map and cannot see plateauapp, so prefer the daemons' org-aware shim.
  try {
    const orgDir = orgShimDir();
    // Already first: keep it there — the legacy branch below must never push it out of first place.
    if (orgDir && (env.PATH || '').split(':')[0] === orgDir) return env;
    const orgPath = pathWithOrgAwareShim({ pathEnv: env.PATH || '', orgDir });
    if (orgPath) return { ...env, PATH: orgPath };
  } catch { /* fall through */ }
  const dir = defaultShimDir();
  if (exists(shimGhPath(dir)) && (env.PATH || '').split(':')[0] !== dir) {
    return { ...env, PATH: pathWithShimFirst(dir, env.PATH || '') };
  }
  return env;
}

/** PURE: `dir` as PATH's first entry, later copies dropped. A shim guards only as the FIRST gh on PATH. */
function pathWithShimFirst(dir, pathEnv) {
  return [dir, ...pathEnv.split(':').filter((d) => d && d !== dir)].join(':');
}
import { checkPrePrReview, loadPrePrSettings, renderBypassNote, codeSpan } from '../lib/pre-pr-review.mjs';
import { prepareItemFromRef, preparePrTitle, verifyPreparePr, prepareBatchIds, verifyPrepareBatchPr } from './prepare-pr.mjs';

/** The single home. Resolved from THIS file's location, never cwd — the lane being opened is not this repo. */
export const PR_LAND_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-land.mjs');

/** Opening a PR waits on required checks in two of the three modes, so the bound is generous; a kill is `unrun`. */
export const OPEN_PR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Appends the recorded bypass (reason, actor, quoted operator instruction — each rendered as a single-line code
 * span) to a COPY of the PR body file. FAILS CLOSED: a bypass whose PR-body note cannot be written throws, so the
 * caller refuses it rather than opening a PR whose body does not record the bypass. `cleanup` removes the copy.
 */
function withBypassInBody(argv, b) {
  const i = argv.findIndex((a) => a.startsWith('--body-file='));
  if (i < 0) throw new Error('the request has no --body-file, so the bypass cannot be recorded in the PR body');
  const dir = mkdtempSync(join(tmpdir(), 'open-pr-bypass-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const out = join(dir, 'body.md');
    // pr-land expands a leading `~` in --body-file; read the same file it will.
    writeFileSync(out, readFileSync(argv[i].slice('--body-file='.length).replace(/^~/, homedir()), 'utf8') + renderBypassNote(b));
    return { argv: argv.map((a, j) => (j === i ? `--body-file=${out}` : a)), cleanup };
  } catch (e) { cleanup(); throw e; }
}

/** The decisions a gate may return; anything else (null, `{}`, a typo'd action) is a check error, never a pass. */
const GATE_ACTIONS = Object.freeze(['pass', 'advise', 'refuse']);

/** The gate when its own check threw (or returned no usable decision): enforce fails CLOSED (refuse); advise/off
 *  proceed, loudly. If even the mode cannot be read here, that too is a refusal — this path never throws. */
function failedGate(e, loadSettings) {
  // the error text can embed agent-supplied argv (`--sha=…`), so it is rendered as an inert one-line span
  const cause = codeSpan(e && e.message ? e.message : e, 300);
  let mode;
  try { mode = loadSettings()?.settings?.mode; } catch (se) {
    return { action: 'refuse', why: 'check-error', reason: 'pre-pr-review-error', message: `the pre-PR review check itself failed (${cause}) and its mode could not be read (${codeSpan(se && se.message ? se.message : se, 300)}) — refusing (fail closed).` };
  }
  const message = `the pre-PR review check itself failed (${cause}); prePrReview.mode is ${codeSpan(mode, 40)}`;
  // Only an explicit advise/off proceeds; enforce, a missing mode or an unknown one refuses.
  return mode === 'advise' || mode === 'off'
    ? { action: 'advise', why: 'check-error', message }
    : { action: 'refuse', why: 'check-error', reason: 'pre-pr-review-error', message: `${message} — refusing (fail closed). Fix the cause and open the PR again.` };
}

function createGitReader(cwd, exec = execFileSync) {
  // A replacement character changes filename identity: an empty lookup for the
  // substituted path could otherwise be mistaken for proof that a blob is absent.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return (args, options = {}) => {
    const output = exec('git', args, { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024, ...options });
    return typeof output === 'string' ? output : decoder.decode(output);
  };
}

/** Attributes can override --text. Recover binary rows from immutable blobs, counting the
 * whole old and new files conservatively. Only a successful tree read proves a missing side.
 */
function countBinaryDiffRows(text, { git, topLevel, base, sha }) {
  if (!text.includes('-\t-\t')) return text;
  if (!text.endsWith('\0')) throw new Error('unterminated numstat record');
  const rows = text.slice(0, -1).split('\0');
  let mergeBase;
  // Bound the entire fallback, including every tree/blob read, rather than each file alone.
  const deadline = performance.now() + 60_000;
  const read = (args, options = {}) => {
    const timeout = Math.ceil(deadline - performance.now());
    if (timeout <= 0) throw new Error('binary size read timed out');
    return git(['-C', topLevel, ...args], { ...options, timeout });
  };
  const lines = (revision, path) => {
    const entry = read(['ls-tree', '-z', '--full-tree', revision, '--', path]);
    if (entry === '') return 0;
    const match = /^\d+ blob ([a-f0-9]+)\t([\s\S]*)\0$/.exec(entry);
    if (!match || match[2] !== path) throw new Error('unreadable diff blob');
    // Blob contents are arbitrary bytes, not filename metadata. Latin-1 preserves
    // one character per byte so newline counting never needs lossy UTF-8 decoding.
    const blob = read(['cat-file', 'blob', match[1]], { encoding: 'latin1' });
    let count = blob.length && !blob.endsWith('\n') ? 1 : 0;
    for (let i = 0; i < blob.length; i++) if (blob[i] === '\n') count++;
    return count;
  };
  for (let i = 0; i < rows.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rows[i]);
    if (!match) throw new Error('unreadable numstat line');
    const rowIndex = i;
    const source = match[3] || rows[++i];
    const destination = match[3] || rows[++i];
    if (!source || !destination) throw new Error('incomplete numstat path');
    if (match[1] !== '-' || match[2] !== '-') continue;
    mergeBase ??= read(['merge-base', base, sha]).trim();
    if (!mergeBase) throw new Error('missing diff merge base');
    rows[rowIndex] = `${lines(sha, destination)}\t${lines(mergeBase, source)}\t${match[3]}`;
  }
  return rows.join('\0') + '\0';
}

/** Local Git size evidence, separately constructible with a temp cwd or injected git/exec.
 * Tests can opt into the production reader without enabling credential resolution or the GitHub advisory.
 */
export function createPrDiffStatReader({ cwd = process.cwd(), exec = execFileSync, git = createGitReader(cwd, exec) } = {}) {
  return ({ base, sha }) => {
    if (!base || base.startsWith('-') || !sha || sha.startsWith('-')) throw new Error('invalid diff ref');
    const resolvedSha = git(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    let ref = base;
    try { git(['rev-parse', '--verify', '--quiet', `origin/${base}`]); ref = `origin/${base}`; } catch { /* use local base */ }
    // Remove Git's record terminator only; trailing whitespace can belong to the
    // directory name, and trimming it could select a different repository.
    const topLevel = git(['rev-parse', '--show-toplevel']).replace(/\n$/, '');
    const text = git(['-C', topLevel, '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', `${ref}...${resolvedSha}`], { timeout: 60_000 });
    return {
      text: countBinaryDiffRows(text, { git, topLevel, base: ref, sha: resolvedSha }),
      sha: resolvedSha,
    };
  };
}

/**
 * The runner the declaration is injected with. ONE spawn; `spawn` is injected so every branch of
 * `classifySubmit` is reachable with no `gh`, no network and no PR.
 */
export function createPrLandRunner({ prePrReview = checkPrePrReview, loadSettings = loadPrePrSettings, spawn = spawnSync, cwd = process.cwd(),
  // Card 6931 — the credential env is resolved per run, inside the runner, so a daemon's guard refusal is a refused
  // outcome before any gh call (never a crash where run.mjs builds the sinks). An explicit `env` skips resolution;
  // a caller that injected `spawn` is a rehearsal/test and writes no shim.
  env: envOpt, resolveEnv = spawn !== spawnSync ? () => process.env : resolveGhCredentialEnv,
  git: gitOpt,
  // Injected git or spawn keeps size evidence hermetic; opt in with an explicit diffStat reader.
  diffStat = spawn !== spawnSync || gitOpt !== undefined ? () => '' : createPrDiffStatReader({ cwd }),
  // Real git/gh only when the real spawn is in use: a caller that injected `spawn` is a rehearsal/test and must stay hermetic.
  dupBornAs = spawn !== spawnSync ? () => [] : ({ env: execEnv, ...opts }) => checkDuplicateBornAs({ ...opts, exec: (cmd, args) => execFileSync(cmd, args, { cwd, env: execEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) }),
} = {}) {
  const git = gitOpt === undefined ? createGitReader(cwd) : gitOpt;
  return ({ argv, skipPrePrReview = '', actor = '', operatorInstruction = '' }) => {
    let env;
    try { env = envOpt ?? resolveEnv(); }
    catch (e) { return { outcome: 'refused', reason: 'gh-auth-guard-unavailable', detail: String(e?.message || e) }; }
    let r;
    let cleanupBody = () => {}; // removes the temp PR-body copy a bypass writes; called on every path out
    const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    // Pre-PR review gate (card 2): ADDED before the home's own gates, never instead of them (the post-PR review
    // gate and the verify finish-guard still run inside pr-land). A rehearsal opens nothing, so it is not gated.
    // Any failure of the check is mode-aware (`failedGate`): enforce refuses, it never silently admits.
    if (!argv.includes('--dry-run')) {
      let gate;
      try {
        gate = prePrReview({ cwd, base: arg('base') || 'main', sha: arg('sha') || 'HEAD', env, skip: skipPrePrReview, actor, operatorInstruction });
        if (!gate || !GATE_ACTIONS.includes(gate.action)) throw new Error(`the check returned no usable decision (action: ${JSON.stringify(gate?.action)})`);
      } catch (e) { gate = failedGate(e, loadSettings); }
      if (gate.settingsError) process.stderr.write(`open-pr: WARNING — ${gate.settingsError}\n`);
      if (gate.action === 'refuse') return { outcome: 'refused', reason: gate.reason || 'pre-pr-review-missing', detail: gate.message };
      // Gate and push are bound to the SAME commit: pr-land publishes exactly the sha the gate judged.
      if (gate.sha) argv = [...argv.filter((a) => !a.startsWith('--sha=')), `--sha=${gate.sha}`];
      if (gate.bypass) {
        try { ({ argv, cleanup: cleanupBody } = withBypassInBody(argv, gate.bypass)); }
        catch (e) { return { outcome: 'refused', reason: 'pre-pr-review-bypass-unrecorded', detail: `bypass refused — ${e.message}` }; }
      }
      if (gate.action === 'advise') process.stderr.write(`open-pr: advisory — ${gate.message}\n`);
      // Only the gate's audited bypass, recorded in the body above, can waive size admission.
      if (!gate.bypass) {
        let size;
        let measuredSha;
        try {
          const evidence = diffStat({ base: arg('base') || 'main', sha: arg('sha') || 'HEAD' });
          // Plain-text injected readers retain their caller's argv; the production reader also pins its commit.
          size = measureNonTestLines(typeof evidence === 'string' ? evidence : evidence.text);
          measuredSha = typeof evidence === 'string' ? '' : evidence.sha;
        }
        catch {
          cleanupBody();
          return { outcome: 'refused', reason: 'pr-size-unreadable', detail: 'Could not measure the PR diff. Restore readable git numstat evidence and try again.' };
        }
        if (size.lines > OPEN_PR_MAX_NON_TEST_LINES && !size.exempt) {
          cleanupBody();
          return { outcome: 'refused', reason: 'pr-too-large', detail: `The PR changes ${size.lines} non-test lines, exceeding the ${OPEN_PR_MAX_NON_TEST_LINES} limit. Split the PR into smaller PRs.` };
        }
        if (measuredSha) argv = [...argv.filter((a) => !a.startsWith('--sha=')), `--sha=${measuredSha}`];
      }
    }
    // xsjn0uf-incident — advisory: a card this PR adds whose bornAs is already on main / in another open PR.
    if (!argv.includes('--dry-run')) {
      let dups = [];
      // xbdzt01 — the scan must skip THIS PR. open-pr always hands pr-land `--ref=` (never `--branch=`), so the head
      // ref is `ref`; reading only `branch` excluded nothing and flagged every card as "also in" the PR itself.
      try { dups = dupBornAs({ base: arg('base') || 'main', sha: arg('sha') || 'HEAD', branch: arg('ref') || arg('branch') || '', env }) || []; } catch { dups = []; }
      for (const w of dups) process.stderr.write(`open-pr: WARNING — duplicate card: ${w}\n`);
    }
    let item;
    try { item = prepareItemFromRef(arg('ref')); } catch (e) { cleanupBody(); throw e; }
    const batchIds = prepareBatchIds(arg('title'));
    if (item || batchIds.length) {
      try {
        const sha = batchIds.length ? verifyPrepareBatchPr({ items: batchIds, source: arg('sha') || 'HEAD', base: arg('base') || 'main', git }) : verifyPreparePr({ item, source: arg('sha') || 'HEAD', base: arg('base') || 'main', git });
        argv = argv.filter((a) => !a.startsWith('--title=') && !a.startsWith('--sha='));
        argv.push(`--title=${assertMachineTitle(batchIds.length ? `prepare: ${batchIds.join(', ')}` : preparePrTitle(item, readMainCard(item, git)))}`, `--sha=${sha}`);
      } catch (e) {
        cleanupBody();
        return { outcome: 'refused', reason: String(e.message || e) };
      }
    }
    try {
      r = spawn(process.execPath, [PR_LAND_CLI, ...argv, '--json'], {
        encoding: 'utf8', timeout: OPEN_PR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd, env,
      });
    } catch (e) {
      r = { error: e };
    } finally {
      cleanupBody();
    }
    return classifySubmit(r ?? {});
  };
}

/**
 * The sink. It returns the classification rather than throwing on a refusal: a home that REFUSED has answered
 * the question, and that answer belongs in the run record where the caller can read which guard fired. Only a
 * genuinely unusable result is an error.
 */
export function createOpenPrSinks({ run = createPrLandRunner() } = {}) {
  return {
    ['open-pr.submit']: async (payload) => {
      const out = run({ argv: payload.argv, skipPrePrReview: payload.skipPrePrReview, actor: payload.actor, operatorInstruction: payload.operatorInstruction });
      // A REQUESTED `--dry-run` classifies as `unrun` too (it opens nothing, by design), but it is not the
      // "environment could not complete" case this throw exists for — the caller asked for a rehearsal and
      // got one. Throwing here misreports a working preview as a failure (found dogfooding this operation's
      // own step-2 dry-run instructions).
      //
      // Keyed on `out.reason === 'dry-run'` — the HOME'S OWN reported reason — never on whether `--dry-run`
      // was in the request argv. A request can carry `--dry-run` and still genuinely fail to run (spawn
      // error, kill signal, unparseable stdout) before pr-land ever reaches its own dry-run branch; keying
      // on the request would silently swallow that as an unremarkable rehearsal instead of throwing it,
      // masking a real infrastructure failure. Found by independent review of this very fix (PR #1715).
      if (out.outcome === 'unrun' && out.reason !== 'dry-run' && out.pr != null) {
        // #79 — the PR exists; never claim it was not opened.
        throw new Error(`open-pr: PR #${out.pr} is open${out.url ? ` (${out.url})` : ''}, but the home stopped after opening it: ${out.reason}${out.detail ? ` — ${out.detail}` : ''}`);
      }
      if (out.outcome === 'unrun' && out.reason !== 'dry-run') {
        throw new Error(
          `open-pr: pr-land did not report a result — ${out.reason}${out.detail ? ` — ${out.detail}` : ''}. The PR was NOT opened, and this is not a `
          + 'refusal you can fix by editing the request. On a host with no `gh` credential this is expected: '
          + `submit the planned argv through a channel that has one — ${JSON.stringify(payload.argv)}`,
        );
      }
      return out;
    },
  };
}
