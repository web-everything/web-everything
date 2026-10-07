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
import { existsSync, readFileSync } from 'node:fs';
import { buildGhShimSettingsEnv, defaultShimDir, ghShimPathOverride, shimGhPath } from '../lib/gh-app-shim.mjs';

/**
 * #81 — a lane's ref, when the caller did not name one. `lane/<slug>` from the lane lease's `purpose`
 * (`git rev-parse --git-path .lane-lease`). Returns '' when there is no lease/purpose. `read` is injected.
 */
export function deriveLaneRef({
  cwd = process.cwd(),
  read = (c) => readFileSync(execFileSync('git', ['rev-parse', '--git-path', '.lane-lease'], { cwd: c, encoding: 'utf8' }).trim().replace(/^(?!\/)/, c + '/'), 'utf8'),
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
import { prepareItemFromRef, preparePrTitle, verifyPreparePr } from './prepare-pr.mjs';

/** The single home. Resolved from THIS file's location, never cwd — the lane being opened is not this repo. */
export const PR_LAND_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-land.mjs');

/** Opening a PR waits on required checks in two of the three modes, so the bound is generous; a kill is `unrun`. */
export const OPEN_PR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The runner the declaration is injected with. ONE spawn; `spawn` is injected so every branch of
 * `classifySubmit` is reachable with no `gh`, no network and no PR.
 */
export function createPrLandRunner({ spawn = spawnSync, cwd = process.cwd(), env = resolveGhCredentialEnv(),
  git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
} = {}) {
  return ({ argv }) => {
    let r;
    const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const item = prepareItemFromRef(arg('ref'));
    if (item) {
      try {
        const sha = verifyPreparePr({ item, source: arg('sha') || 'HEAD', base: arg('base') || 'main', git });
        argv = argv.filter((a) => !a.startsWith('--title=') && !a.startsWith('--sha='));
        argv.push(`--title=${assertMachineTitle(preparePrTitle(item, readMainCard(item, git)))}`, `--sha=${sha}`);
      } catch (e) {
        return { outcome: 'refused', reason: String(e.message || e) };
      }
    }
    try {
      r = spawn(process.execPath, [PR_LAND_CLI, ...argv, '--json'], {
        encoding: 'utf8', timeout: OPEN_PR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd, env,
      });
    } catch (e) {
      r = { error: e };
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
      const out = run({ argv: payload.argv });
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
