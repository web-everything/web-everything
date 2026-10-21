#!/usr/bin/env node
/**
 * @file scripts/operations/referral-findings-cli.mjs
 * @description Standalone read-only referral finding inventory: --repo=<owner/repo> --pr=<n> [--json].
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { createMemoryRunStore, newRunId } from './run-store.mjs';
import { runOperationCli } from './cli-adapter.mjs';
import { referralFindingsOperation } from './referral-findings.mjs';
import { daemonCloneRoots, isDaemonCloneRealpath } from '../lib/daemon-clone-registry.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';
import { REPO_ROOT, createRecordReferralRulingReader } from './record-referral-ruling-io.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';

export async function runReferralFindingsCli(argv, { readRulingContext, root = REPO_ROOT,
  env = process.env, cloneRoots = daemonCloneRoots } = {}) {
  let real;
  try { real = realpathSync(root); } catch { real = resolve(root); }
  // The shared reader fetches for freshness; resident clones belong to their gated rebuild.
  if (env.WE_DAEMON_MANAGED_CLONE === '1' || /(?:^|[/\\])(?:wev-[^/\\]*|[^/\\]*-daemon[^/\\]*)(?:[/\\]|$)/.test(real)
    || isDaemonCloneRealpath(real, cloneRoots(workspaceOf(real), { env }))) {
    throw new Error('referral-findings refuses daemon clones; run from a lane');
  }
  readRulingContext ??= createRecordReferralRulingReader({ root: real, env,
    // Never fetch in or re-exec from cwd's checkout, even if fallback is enabled by settings/env.
    assertFresh: () => assertOperatorCliFresh(real, { label: 'referral-findings',
      env: { ...env, WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } }),
  });
  const declaration = referralFindingsOperation({ readRulingContext });
  const registry = createRegistry();
  registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv, sinks: {}, store: createMemoryRunStore(),
    newRunId: () => newRunId(declaration.name) });
  if (result.code === 0 && result.stopped === 'complete' && !argv.includes('--json') && !argv.includes('--json=true')) {
    const { head, findings } = result.run.verdict;
    const counts = ['open', 'ruled', 'disputed'].map((group) =>
      `${findings.filter((f) => f.group === group).length} ${group} finding(s)`);
    result.lines.push(`Live head: ${head}; ${counts.join('; ')}.`,
      ...findings.flatMap((f) => [`[${f.group}] ${f.file}:${f.line} — ${f.summary}`,
        `--finding=${f.finding}`,
        `standing rulings (newest first): ${f.standing.map((r) => `${r.id} (${r.result})`).join(', ') || 'none'}`,
        ...(f.group === 'disputed' ? [`blockIds: ${f.blockIds.join(', ')}`] : []), f.command, f.cardCommand]));
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { code, lines } = await runReferralFindingsCli(process.argv.slice(2));
    writeAllSync(1, `${lines.join('\n')}\n`);
    process.exitCode = code;
  } catch (e) {
    writeAllSync(1, `error: ${String(e?.message ?? e)}\n`);
    process.exitCode = 1;
  }
}
