/**
 * @file scripts/conveyor/stale-claim-io.mjs
 * @description IO shell + CLI for the stale fix-claim pass (`stale-claim.mjs`). REPORT-ONLY by default: it reads the claim
 *   store, `claude agents --json --all`, and each claimed PR's last commit time, then appends one row per claim to
 *   `~/.plateau/assistant/stale-claims.jsonl`. `staleClaim.mode = act` (env `WE_STALE_CLAIM_MODE`, or the platform
 *   preference) additionally releases through `run.mjs clear-claim --kind=…` and rearms through `run.mjs rearm`, the
 *   same operator-control code paths a person would use, and emits a typed `stale-claim-released` daemon event.
 *   Main-only modules are imported lazily so importing this file has no side effects.
 *
 *   Usage: node scripts/conveyor/stale-claim-io.mjs [--mode=report|act] [--json]
 */
import { execFile as execFileCb } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveStaleClaimSettings, runStalePass } from './stale-claim.mjs';

const execFile = promisify(execFileCb);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTOR = 'stale-claim-pass';

export function staleClaimsLogPath({ env = process.env, home = homedir() } = {}) {
  return env.WE_STALE_CLAIMS_LOG ? resolve(env.WE_STALE_CLAIMS_LOG) : join(home, '.plateau', 'assistant', 'stale-claims.jsonl');
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** `owner/repo` for a claim (the store may hold the constellation key, e.g. `we`). */
export function claimRepoSlug(claim, constellation = {}) {
  const repo = claim.meta?.repo ?? '';
  return constellation[repo]?.slug ?? repo;
}

/** Last commit time of the PR head, the closest cheap proxy for "last push". */
export async function readLastPush(claim, { run = execFile, slugOf = claimRepoSlug } = {}) {
  const { stdout } = await run('gh', ['pr', 'view', String(claim.meta.pr), '--repo', slugOf(claim), '--json', 'state,commits'], { timeout: 60_000 });
  const pr = JSON.parse(stdout);
  const last = (pr.commits ?? []).map(c => Date.parse(c.committedDate)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return Number.isFinite(last) ? { atMs: last, open: pr.state === 'OPEN' } : null;
}

/** Run one operator control through the real CLI (same path as `run.mjs clear-claim` / `run.mjs rearm`). */
export async function runControl(op, claim, reason, { run = execFile, slugOf = claimRepoSlug, root = ROOT } = {}) {
  const args = ['scripts/operations/run.mjs', op, `--repo=${slugOf(claim)}`, `--pr=${claim.meta.pr}`,
    ...(op === 'clear-claim' ? [`--kind=${claim.meta.kind}`] : []),
    `--actor=${ACTOR}`, '--channel=daemon', `--reason=stale claim: ${reason}`];
  try { await run('node', args, { cwd: root, timeout: 120_000 }); return { ok: true }; }
  catch (error) { return { ok: false, reason: String(error?.stderr || error?.message || error).slice(0, 300) }; }
}

async function readAgents() {
  try {
    const { stdout } = await execFile('claude', ['agents', '--json', '--all'], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

const importMain = async rel => { try { return await import(pathToFileURL(join(ROOT, rel)).href); } catch { return null; } };

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flag = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const store = await importMain('scripts/conveyor/fix-claim-store.mjs');
  if (!store) { process.stderr.write('stale-claim: claim store not present in this checkout\n'); return 2; }
  const claimFile = await importMain('scripts/conveyor/fix-dispatch-claim.mjs');
  const constellation = (await importMain('scripts/lib/constellation-repos.mjs'))?.CONSTELLATION_REPOS ?? {};
  const events = await importMain('scripts/lib/daemon-events.mjs');
  const settingsLib = await importMain('scripts/lib/settings-files.mjs');
  const cascade = await importMain('scripts/lib/policy-cascade.mjs');
  const settings = resolveStaleClaimSettings({
    tool: (() => { try { return settingsLib?.readSettings?.()?.staleClaim; } catch { return undefined; } })(),
    platform: (() => { try { return cascade?.platformPreference?.('staleClaim', { env }); } catch { return undefined; } })(),
    env: flag('mode') ? { ...env, WE_STALE_CLAIM_MODE: flag('mode') } : env,
  });
  const slugOf = claim => claimRepoSlug(claim, constellation);
  const logPath = staleClaimsLogPath({ env });
  const nowMs = Date.now();
  const result = await runStalePass({
    claims: store.listFixDispatchClaims(store.fixDispatchClaimRoot(), { liveOnly: false }),
    agents: await readAgents(), settings, nowMs,
    deps: {
      pidAlive,
      activityMs: agent => { try { const v = claimFile?.transcriptActivityMs?.(agent); return Number.isFinite(v) ? v : null; } catch { return null; } },
      sessionNameFor: claim => { try { return store.fixDispatchSessionName({ repo: claim.meta.repo, pr: claim.meta.pr, kind: claim.meta.kind }); } catch { return null; } },
      lastPush: claim => readLastPush(claim, { slugOf }),
      release: async (claim, { reason }) => {
        const r = await runControl('clear-claim', claim, reason, { slugOf });
        return { released: r.ok, reason: r.reason };
      },
      rearm: (claim, { reason }) => runControl('rearm', claim, reason, { slugOf }),
      record: async row => { await mkdir(dirname(logPath), { recursive: true }); await appendFile(logPath, `${JSON.stringify(row)}\n`); },
      emit: event => events?.appendDaemonEvent?.(event),
    },
  });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`stale-claim mode=${result.mode} claims=${result.rows.length} log=${logPath}\n`);
    for (const r of result.rows.filter(x => x.outcome !== 'kept')) {
      process.stdout.write(`  ${r.outcome} ${r.repo}#${r.pr} ${r.kind} owner=${r.ownerName} state=${r.ownerState} claimAge=${r.claimAgeMin}m pushAge=${r.pushAgeMin}m (${r.reason})\n`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
}
