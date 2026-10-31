/** PR #6138: scratch test inventories must survive the Forge command boundary. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as worker from '../../../lib/daemon-rebuild/auto-rebase.mjs';
import { runRemote } from '../../../readiness/remote-exec.mjs';
import { allowedCommand } from '../../../readiness/forge-exec-run.mjs';

// Real command validation, snapshot construction and receipt verification; only transport is fake.
export async function runScratchForgeCase() {
  const root = fs.mkdtempSync(join(tmpdir(), 'soak-scratch-forge-'));
  try {
    const file = 'worker.test.mjs', files = ['package-lock.json', file];
    fs.writeFileSync(join(root, files[0]), '{"lockfileVersion":3,"packages":{}}\n');
    fs.writeFileSync(join(root, file), '// selected test\n');
    const invocation = worker.buildHeavyTestInvocation({ root, scratch: root, selected: [file],
      testReport: join(root, 'inventory.json'), env: {} });
    const argv = invocation.args.slice(invocation.args.indexOf('--') + 1);
    if (!allowedCommand(argv)) return { violations: ['scratch command rejected before transport'] };
    const { TapReporter } = await import('vitest/reporters');
    const lines = [], reporter = new TapReporter();
    reporter.onInit({ logger: { log: text => lines.push(text) }, getProjectByTaskId: () => ({}) });
    const titles = ['carriage\rreturn', 'line\u2028separator', 'paragraph\u2029separator', 'line\nbreak', 'line\r\nbreak'];
    await reporter.onFinished([{ type: 'suite', name: file, mode: 'run', result: { state: 'pass', duration: 1 }, tasks: [
      { type: 'test', name: 'assertion', mode: 'run', result: { state: 'pass', duration: 1 } },
      ...titles.map(name => ({ type: 'suite', name, mode: 'run', result: { state: 'pass', duration: 1 }, tasks: [
        { type: 'test', name, mode: 'run', result: { state: 'pass', duration: 1 } },
      ] })),
    ] }]);
    const tap = lines.join('\n') + '\n';
    let state, remote, runs = 0;
    const exec = async call => {
      if (call.file === 'git') {
        if (call.args.includes('-i')) return { code: 0, stdout: Buffer.alloc(0) };
        const records = call.args.includes('--stage') ? files.map(name => {
          const content = fs.readFileSync(join(root, name));
          const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
          return `100644 ${oid} 0\t${name}`;
        }) : files;
        return { code: 0, stdout: Buffer.from(records.join('\0') + '\0') };
      }
      if (call.file === 'rsync' || call.args.at(-1) === 'true') return { code: 0, stdout: '' };
      if (call.args.at(-1).endsWith(' bases')) return { code: 254, stdout: '' };
      if (call.args.at(-1).endsWith(' prepare')) {
        state = JSON.parse(call.input); state.run = 'r-' + state.nonce;
        return { code: 0, stdout: JSON.stringify({ run: state.run, capabilities: { siblings: 1, commandClasses: 1, gitWorktree: 2 } }) };
      }
      if (call.args.at(-1).endsWith(' run')) {
        state = { ...state, ...JSON.parse(call.input) }; runs++;
        return { code: 0, stdout: tap };
      }
      if (call.args.at(-1).endsWith(' finish')) return { code: 0, stdout: JSON.stringify({ v: 1, nonce: state.nonce, run: state.run,
        inputDigest: state.inputDigest, argvDigest: state.argvDigest, lock: state.lock, manifestDigest: state.manifestDigest, phase: 'test', code: 0 }) };
      throw new Error('unexpected transport command');
    };
    await worker.runHeavyTests(invocation, { exec: async () => {
      remote = await runRemote({ argv, cwd: root, env: {}, exec, listFiles: async () => files, log: () => {} });
      return { status: remote.mode === 'remote' ? remote.code : 1, stdout: tap, stderr: '' };
    } });
    const report = fs.existsSync(invocation.testReport) ? JSON.parse(fs.readFileSync(invocation.testReport, 'utf8')) : null;
    const violations = [];
    if (remote.mode !== 'remote' || remote.code !== 0 || runs !== 1) violations.push(`offload failed: ${JSON.stringify(remote)}, runs=${runs}`);
    if (report?.testResults?.[0]?.name !== join(fs.realpathSync(root), file)
      || report.testResults[0].assertionResults.length !== titles.length + 1
      || report.testResults[0].assertionResults.some(assertion => assertion.status !== 'passed')) violations.push('local inventory missing');
    return { violations, mode: remote.mode, runs };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export default {
  id: 'scratch-tests-forge-command',
  title: 'scratch tests offload to Forge and return executed-file inventory',
  card: 'PR #6138 send-back item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/forge-daemon-heavy-xz5f6n4-s2', paths: [
    'scripts/lib/daemon-rebuild/auto-rebase.mjs', 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs',
  ] },
  fixPresent(root) { return fs.readFileSync(join(root, 'scripts/lib/daemon-rebuild/auto-rebase.mjs'), 'utf8').includes("'--reporter=tap'"); },
  run: runScratchForgeCase,
  judge(report) { return report.violations; },
};
