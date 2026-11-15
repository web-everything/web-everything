/** PR #6832: reclaim must stop the discovered B fixer before releasing its claims. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'dispatch-account-session-stop',
  title: 'PR #6832: stuck-fixer reclamation stops the same account that discovery uses',
  card: 'PR #6832 red-team send-back 3 item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/auth-split-pr2', paths: ['scripts/operations/dispatch-abort.mjs', 'scripts/conveyor/fixer-stuck-reclaim.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/dispatch-abort.mjs'), 'utf8').includes('env = accountSessionEnv(env, accountOptions)');
  },
  async run({ root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url)), invalidProfile = false } = {}) {
    const { defaultListAgents } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane-io.mjs')).href);
    const { stopSession } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-abort.mjs')).href);
    const { runFixerStuckReclaimPass } = await import(pathToFileURL(join(root, 'scripts/conveyor/fixer-stuck-reclaim.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-account-stop-'));
    const violations = [];
    try {
      const bin = join(dir, 'bin');
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      for (const path of [bin, a, b]) mkdirSync(path);
      writeFileSync(join(b, '.claude.json'), '{}');
      writeFileSync(join(a, 'jobs.json'), '[]');
      const cli = join(bin, 'claude');
      writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, 'jobs.json');
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv[2] === 'agents') process.stdout.write(JSON.stringify(rows));
else if (process.argv[2] === 'stop') {
  if (!rows.some(r => r.sessionId === process.argv[3])) {
    process.stderr.write('No job matching'); process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(rows.filter(r => r.sessionId !== process.argv[3])));
} else process.exit(2);
`);
      chmodSync(cli, 0o700);
      for (const label of ['com.we.build-dispatch-daemon', 'com.we.fix-dispatch-daemon']) {
        const row = { name: 'fix-6832', sessionId: 'session-b', state: 'working' };
        writeFileSync(join(b, 'jobs.json'), JSON.stringify([row]));
        const accountOptions = { map: { accounts: { b: { configDir: b } }, daemons: { [label]: 'b' }, routing: { accountB: true } } };
        const env = { PATH: bin, HOME: a, XPC_SERVICE_NAME: label, WE_WORKER_WRAPPER: 'off', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0', WE_FIXER_STUCK_RECLAIM: '1' };
        const discovered = defaultListAgents({ env, accountOptions })[0];
        if (discovered?.sessionId !== row.sessionId) violations.push(`${label}: discovery missed B`);
        if (invalidProfile) rmSync(join(b, '.claude.json'));
        const alive = () => JSON.parse(readFileSync(join(b, 'jobs.json'), 'utf8')).length > 0;
        const effects = [];
        const result = await runFixerStuckReclaimPass({
          env, nowMs: 3_600_000, orphanPass: null,
          readEvents: () => [{ type: 'session-watchdog.fixer-stuck', key: 'stuck-b', repo: 'we', pr: 6832, session: { id: discovered?.sessionId, sessionId: row.sessionId, name: row.name }, classification: 'stalled', at: new Date(1_000).toISOString() }],
          readAcked: () => new Set(), readComments: async () => [],
          listClaims: () => [{ meta: { repo: 'we', pr: 6832, who: row.name, sessionId: row.sessionId } }],
          awaitFor: () => null, prHeadFor: () => 'head', lastActivityMsFor: () => 1_000, verifyRunningFor: () => false,
          // Pin the executable even on the broken tree; never stop a host session during a replay.
          stopSession: (options) => stopSession({ ...options, accountOptions,
            exec: (_cmd, argv, opts) => execFileSync(cli, argv, { ...opts, env: opts.env ?? env, stdio: ['ignore', 'pipe', 'pipe'] }),
          }),
          endFix: async () => { effects.push('fix-end'); if (alive()) violations.push(`${label}: fix claim released while B still alive`); return { ok: true }; },
          releaseDispatch: () => { effects.push('release'); if (alive()) violations.push(`${label}: dispatch claim released while B still alive`); return { released: [] }; },
          clearAwait: () => { effects.push('clear'); return true; }, appendAck: () => effects.push('ack'),
        });
        if (invalidProfile) {
          if (result.rows[0]?.result !== 'stop-failed' || effects.length || !alive()) violations.push(`${label}: invalid profile did not preserve ownership and session`);
          writeFileSync(join(b, '.claude.json'), '{}');
        } else {
          if (result.rows[0]?.result !== 'reclaimed') violations.push(`${label}: reclaim did not finish: ${JSON.stringify(result.rows)}`);
          if (alive()) violations.push(`${label}: B session survived reclamation`);
          if (effects.join(',') !== 'fix-end,release,clear,ack') violations.push(`${label}: incomplete closeout`);
        }
        if (env.CLAUDE_CONFIG_DIR !== undefined) violations.push(`${label}: daemon env mutated`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
