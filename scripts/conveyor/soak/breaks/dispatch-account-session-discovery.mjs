/** PR #6832: an unwrapped B fixer must remain discoverable beyond its dispatch claim's TTL. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'dispatch-account-session-discovery',
  title: 'PR #6832: account B discovery renews an unwrapped fixer claim and prevents duplicate dispatch',
  card: 'PR #6832 red-team send-back 2 item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/auth-split-pr2', paths: ['scripts/operations/session-role.mjs', 'scripts/operations/dispatch-lane-io.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('env = accountSessionEnv(env, accountOptions)');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { defaultListAgents } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane-io.mjs')).href);
    const { markWorkerEnv } = await import(pathToFileURL(join(root, 'scripts/operations/session-role.mjs')).href);
    const { acquireFixDispatchClaim, refreshLiveFixDispatchClaims } = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-dispatch-claim.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-account-discovery-'));
    const violations = [];
    try {
      const bin = join(dir, 'bin');
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      for (const path of [bin, a, b]) mkdirSync(path);
      writeFileSync(join(b, '.claude.json'), '{}');
      writeFileSync(join(a, 'jobs.json'), '[]');
      const row = { name: 'fix-6832', sessionId: 'session-b', state: 'working', startedAt: new Date(1_000).toISOString() };
      writeFileSync(join(b, 'jobs.json'), JSON.stringify([row]));
      const cli = join(bin, 'claude');
      writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'agents' || process.argv[3] !== '--json') process.exit(2);
const profile = process.env.CLAUDE_CONFIG_DIR || process.env.HOME;
process.stdout.write(fs.readFileSync(path.join(profile, 'jobs.json'), 'utf8'));
`);
      chmodSync(cli, 0o700);
      for (const label of ['com.we.build-dispatch-daemon', 'com.we.fix-dispatch-daemon']) {
        const map = { accounts: { b: { configDir: b } }, daemons: { [label]: 'b' }, routing: { accountB: true } };
        const env = { PATH: bin, HOME: a, XPC_SERVICE_NAME: label, WE_WORKER_WRAPPER: 'off', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
        const accountOptions = { map };
        if (markWorkerEnv(env, accountOptions).CLAUDE_CONFIG_DIR !== b) violations.push(`${label}: launch did not select B`);
        const list = (all = false) => defaultListAgents({ env, all, accountOptions });
        if (list()[0]?.sessionId !== row.sessionId) violations.push(`${label}: active discovery missed B`);
        if (list(true)[0]?.sessionId !== row.sessionId) violations.push(`${label}: resume discovery missed B`);
        const lockRoot = join(dir, label);
        acquireFixDispatchClaim({ repo: 'we', pr: 6832, owner: 'first', sessionId: row.sessionId, lockRoot, nowMs: 1_000 });
        const renewed = refreshLiveFixDispatchClaims({ lockRoot, nowMs: 541_000, nowIso: () => new Date(541_000).toISOString(),
          listAgentsAll: () => list(true), hungInfoFor: () => null, awaitingVerifyFor: () => null, idleRelease: { enabled: false },
        });
        if (renewed.refreshed.length !== 1) violations.push(`${label}: working B claim was not renewed`);
        if (acquireFixDispatchClaim({ repo: 'we', pr: 6832, owner: 'second', lockRoot, nowMs: 661_000 }).ok) {
          violations.push(`${label}: duplicate fixer admitted after original TTL`);
        }
        if (env.CLAUDE_CONFIG_DIR !== undefined) violations.push(`${label}: daemon environment was mutated`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
