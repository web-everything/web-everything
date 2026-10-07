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

import { classifySubmit } from './open-pr.mjs';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { buildGhShimSettingsEnv, defaultShimDir, ghShimPathOverride, shimGhPath } from '../lib/gh-app-shim.mjs';

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
 */
export function resolveGhCredentialEnv({ env = process.env, exists = existsSync, build = buildGhShimSettingsEnv } = {}) {
  try {
    const built = build({ env, pathEnv: env.PATH || '' });
    if (built?.PATH) return { ...env, ...built };
  } catch { /* fall through */ }
  const dir = defaultShimDir();
  if (exists(shimGhPath(dir)) && !(env.PATH || '').split(':').includes(dir)) {
    return { ...env, PATH: ghShimPathOverride({ dir, currentPath: env.PATH || '' }) };
  }
  return env;
}
import { checkPrePrReview, loadPrePrSettings, renderBypassNote, codeSpan } from '../lib/pre-pr-review.mjs';
import { prepareItemFromRef, preparePrTitle, verifyPreparePr } from './prepare-pr.mjs';

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

/** The gate when its own check threw: enforce fails CLOSED (refuse); advise/off proceed, loudly. */
function failedGate(e, loadSettings) {
  const { settings } = loadSettings();
  // the error text can embed agent-supplied argv (`--sha=…`), so it is rendered as an inert one-line span
  const message = `the pre-PR review check itself failed (${codeSpan(e && e.message ? e.message : e, 300)}); prePrReview.mode is ${settings.mode}`;
  return settings.mode === 'enforce'
    ? { action: 'refuse', why: 'check-error', reason: 'pre-pr-review-error', message: `${message} — refusing (fail closed). Fix the cause and open the PR again.` }
    : { action: 'advise', why: 'check-error', message };
}

/**
 * The runner the declaration is injected with. ONE spawn; `spawn` is injected so every branch of
 * `classifySubmit` is reachable with no `gh`, no network and no PR.
 */
export function createPrLandRunner({ prePrReview = checkPrePrReview, loadSettings = loadPrePrSettings, spawn = spawnSync, cwd = process.cwd(), env = resolveGhCredentialEnv(),
  git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
} = {}) {
  return ({ argv, skipPrePrReview = '', actor = '', operatorInstruction = '' }) => {
    let r;
    let cleanupBody = () => {}; // removes the temp PR-body copy a bypass writes; called on every path out
    const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    // Pre-PR review gate (card 2): ADDED before the home's own gates, never instead of them (the post-PR review
    // gate and the verify finish-guard still run inside pr-land). A rehearsal opens nothing, so it is not gated.
    // Any failure of the check is mode-aware (`failedGate`): enforce refuses, it never silently admits.
    if (!argv.includes('--dry-run')) {
      let gate;
      try { gate = prePrReview({ cwd, base: arg('base') || 'main', sha: arg('sha') || 'HEAD', env, skip: skipPrePrReview, actor, operatorInstruction }); }
      catch (e) { gate = failedGate(e, loadSettings); }
      if (gate.settingsError) process.stderr.write(`open-pr: WARNING — ${gate.settingsError}\n`);
      if (gate.action === 'refuse') return { outcome: 'refused', reason: gate.reason || 'pre-pr-review-missing', detail: gate.message };
      // Gate and push are bound to the SAME commit: pr-land publishes exactly the sha the gate judged.
      if (gate.sha) argv = [...argv.filter((a) => !a.startsWith('--sha=')), `--sha=${gate.sha}`];
      if (gate.bypass) {
        try { ({ argv, cleanup: cleanupBody } = withBypassInBody(argv, gate.bypass)); }
        catch (e) { return { outcome: 'refused', reason: 'pre-pr-review-bypass-unrecorded', detail: `bypass refused — ${e.message}` }; }
      }
      if (gate.action === 'advise') process.stderr.write(`open-pr: advisory — ${gate.message}\n`);
    }
    let item;
    try { item = prepareItemFromRef(arg('ref')); } catch (e) { cleanupBody(); throw e; }
    if (item) {
      try {
        const sha = verifyPreparePr({ item, source: arg('sha') || 'HEAD', base: arg('base') || 'main', git });
        argv = argv.filter((a) => !a.startsWith('--title=') && !a.startsWith('--sha='));
        argv.push(`--title=${assertMachineTitle(preparePrTitle(item, readMainCard(item, git)))}`, `--sha=${sha}`);
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
