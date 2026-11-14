/** PR #6832: account B launches must prepare and repair trust in B's global config. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'dispatch-account-profile-trust',
  title: 'PR #6832: a fresh account B dispatch trusts its selected profile on preparation and retry',
  card: 'PR #6832 red-team send-back 1',
  fixedBy: { sha: 'HEAD', where: 'lane/auth-split-pr2', paths: ['scripts/operations/dispatch-lane-io.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('grantTrust(opts.cwd, { env: execOpts.env })');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { ensureDispatchSessionCwd, defaultSpawnAgent } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane-io.mjs')).href);
    const { markWorkerEnv } = await import(pathToFileURL(join(root, 'scripts/operations/session-role.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-account-trust-'));
    const previous = process.env.WE_DISPATCH_TRUST_PATH;
    const violations = [];
    try {
      const a = join(dir, 'a.json');
      const b = join(dir, 'b');
      const cwd = join(dir, 'scratch');
      const original = JSON.stringify({ projects: {}, accountMetadata: 'preserve' });
      mkdirSync(b);
      writeFileSync(a, original);
      writeFileSync(join(b, '.claude.json'), original);
      process.env.WE_DISPATCH_TRUST_PATH = a; // isolate the broken default-profile path too
      const env = markWorkerEnv({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon', WE_DISPATCH_TRUST_ROOT: 'off' }, {
        map: { accounts: { b: { configDir: b } }, daemons: { 'com.we.build-dispatch-daemon': 'b' }, routing: { accountB: true } },
      });
      const trusted = () => JSON.parse(readFileSync(join(b, '.claude.json'), 'utf8')).projects[cwd]?.hasTrustDialogAccepted === true;
      ensureDispatchSessionCwd(cwd, { env });
      if (!trusted()) violations.push('preparation left the selected B profile untrusted');
      writeFileSync(join(b, '.claude.json'), original); // an uncooperative CLI writer clobbers the grant
      let calls = 0;
      defaultSpawnAgent(['--bg'], { cwd, env }, { exec: (_cmd, _argv, opts) => {
        if (opts.env.CLAUDE_CONFIG_DIR !== b) violations.push('spawn did not select B');
        if (++calls === 1) throw Object.assign(new Error('refused'), { stderr: 'Workspace not trusted' });
        if (!trusted()) violations.push('retry left the selected B profile untrusted');
        return 'backgrounded';
      } });
      if (calls !== 2) violations.push('trust refusal did not retry exactly once');
      if (readFileSync(a, 'utf8') !== original) violations.push('trust was written to A instead of B');
      if (JSON.parse(readFileSync(join(b, '.claude.json'), 'utf8')).accountMetadata !== 'preserve') violations.push('profile metadata was lost');
    } finally {
      if (previous === undefined) delete process.env.WE_DISPATCH_TRUST_PATH;
      else process.env.WE_DISPATCH_TRUST_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
