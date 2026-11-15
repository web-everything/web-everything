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
    return readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('function dispatchTrustRevokePaths(');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { ensureDispatchSessionCwd, defaultSpawnAgent, grantDispatchTrust, revokeDispatchTrust } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane-io.mjs')).href);
    const { markWorkerEnv } = await import(pathToFileURL(join(root, 'scripts/operations/session-role.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-account-trust-'));
    const previous = process.env.WE_DISPATCH_TRUST_PATH;
    const previousHome = process.env.HOME;
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousLabel = process.env.XPC_SERVICE_NAME;
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
      revokeDispatchTrust([cwd], { env });
      if (trusted()) violations.push('revoke left the dead scratch directory trusted in B');
      if (JSON.stringify(JSON.parse(readFileSync(join(b, '.claude.json'), 'utf8'))) !== original) violations.push('grant/revoke did not restore the B profile');
      // Exercise the actual reaper call shape: only dirs, with no worker env, after rollback.
      // HOME and all profile selectors are isolated before the production resolver runs.
      const home = join(dir, 'home');
      mkdirSync(home);
      writeFileSync(join(home, '.claude.json'), original);
      process.env.HOME = home;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.WE_DISPATCH_TRUST_PATH;
      delete process.env.XPC_SERVICE_NAME;
      grantDispatchTrust(cwd, { env });
      revokeDispatchTrust([cwd], { accountOptions: { map: { accounts: { b: { configDir: b } }, daemons: {}, routing: { accountB: false } } } });
      if (trusted()) violations.push('reaper default revoke missed B after rollback');
      if (JSON.stringify(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))) !== original) violations.push('reaper changed unrelated A profile data');
      // A broken B login (directory present, login file gone) must not stop the reaper cleaning A.
      grantDispatchTrust(cwd, { env: { HOME: home, WE_DISPATCH_TRUST_ROOT: 'off' } });
      if (!JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects?.[cwd]) violations.push('fixture: A grant did not land');
      rmSync(join(b, '.claude.json'));
      revokeDispatchTrust([cwd], { accountOptions: { map: { accounts: { b: { configDir: b } }, daemons: {}, routing: { accountB: false } } } });
      if (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects?.[cwd]) violations.push('a broken B profile blocked revoking A');
    } finally {
      if (previous === undefined) delete process.env.WE_DISPATCH_TRUST_PATH;
      else process.env.WE_DISPATCH_TRUST_PATH = previous;
      for (const [key, value] of [['HOME', previousHome], ['CLAUDE_CONFIG_DIR', previousConfig], ['XPC_SERVICE_NAME', previousLabel]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
