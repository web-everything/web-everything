/** Lean fix/ci-heal --bg launches must retain the restricted boundary and repo guards. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/operations/dispatch-lane-io.mjs';
const KINDS = ['fix', 'ci-heal'];
const GUARDS = {
  Bash: ['guard-bash.mjs'],
  'Edit|Write': ['guard-lane.mjs', 'lint-locus-prefix.mjs --pre', 'lint-invisible-characters.mjs',
    'check-memory.mjs --pre', 'backlog-guard.mjs --pre', 'guard-backward-edge.mjs'],
};
// A fresh process both permits dynamic import in the synchronous fixPresent contract and avoids
// caching a different tree's builder or settings. No agent is spawned by buildAgentArgv.
const PROBE = `
const { buildAgentArgv } = await import(process.argv[1]);
const observations = ['fix', 'ci-heal'].map(launchKind => {
  try {
    return { launchKind, argv: buildAgentArgv({
      payload: { launchKind, num: '3037', sessionSlug: 'repair-3037', prompt: 'Repair this PR.' },
      settingsEnv: { PATH: '/fixture/bin' }, worktreeSettings: { bgIsolation: 'none' },
    }) };
  } catch (error) { return { launchKind, error: error.message }; }
});
process.stdout.write(JSON.stringify({ observations }));
`;

function probe(root) {
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE,
      pathToFileURL(join(root, SOURCE)).href], {
      cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    return { error: `builder probe unavailable; restore the checkout/settings and retry: ${error.message}` };
  }
}

function judge(report) {
  const violations = [...(report?.selfCheckViolations ?? [])];
  if (!Array.isArray(report?.observations) || report.observations.length !== KINDS.length) {
    return [...violations, report?.error ?? 'missing fix/ci-heal builder observations'];
  }
  for (const kind of KINDS) {
    const rows = report.observations.filter(row => row?.launchKind === kind);
    const argv = rows[0]?.argv;
    if (rows.length !== 1 || !Array.isArray(argv) || !argv.every(arg => typeof arg === 'string')) {
      violations.push(`${kind}: missing argv; ${rows[0]?.error ?? 'incomplete builder evidence'}`);
      continue;
    }
    for (const flag of ['--bg', '--restricted', '--strict-mcp-config']) {
      if (!argv.includes(flag)) violations.push(`${kind}: missing ${flag}`);
    }
    // Count equals-form overrides as well: a second settings argument can erase the guards.
    const settingsFlags = argv.filter(arg => arg === '--settings' || arg.startsWith('--settings='));
    if (settingsFlags.length !== 1 || !argv.includes('--settings')) {
      violations.push(`${kind}: expected a single --settings JSON argument`);
      continue;
    }
    try {
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
      const pre = settings?.hooks?.PreToolUse;
      for (const [matcher, guards] of Object.entries(GUARDS)) {
        const hooks = Array.isArray(pre)
          ? pre.filter(entry => entry?.matcher === matcher).flatMap(entry => entry.hooks ?? []) : [];
        for (const guard of guards) {
          if (!hooks.some(hook => hook?.type === 'command' && typeof hook.command === 'string'
              && hook.command.includes(`scripts/${guard};`))) {
            violations.push(`${kind}: missing ${matcher} guard ${guard}`);
          }
        }
      }
    } catch { violations.push(`${kind}: unreadable --settings JSON`); }
  }
  return violations;
}

function fixPresent(root) {
  return judge(probe(root)).length === 0;
}

export default {
  id: 'fix-bg-argv-lean-restricted',
  title: 'fix and ci-heal background argv retains restricted flags and guard hooks',
  card: 'lane/daemon-lean-fix lean repair background argv regression',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-lean-fix',
    paths: [SOURCE, 'scripts/operations/minimal-context-provider.mjs'] },
  fixPresent,
  async run({ log, sourceRoot = ROOT } = {}) {
    const report = probe(sourceRoot);
    report.selfCheckViolations = [];
    const check = (name, accepted) => {
      if (accepted) report.selfCheckViolations.push(`negative control accepted: ${name}`);
    };
    check('missing builder evidence fails closed', judge({}).length === 0);
    if (judge(report).length === 0) {
      for (const kind of KINDS) {
        for (const fault of ['--restricted', '--strict-mcp-config', 'Bash', 'Edit|Write', 'duplicate settings', 'invalid JSON']) {
          const broken = structuredClone(report);
          const row = broken.observations.find(entry => entry.launchKind === kind);
          if (fault.startsWith('--')) row.argv = row.argv.filter(arg => arg !== fault);
          else if (fault === 'duplicate settings') row.argv.push('--settings={}');
          else {
            const index = row.argv.indexOf('--settings') + 1;
            const settings = JSON.parse(row.argv[index]);
            settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry => entry.matcher !== fault);
            row.argv[index] = fault === 'invalid JSON' ? '{' : JSON.stringify(settings);
          }
          check(`${kind}: ${fault}`, judge(broken).length === 0);
        }
      }
      // Exercise fixPresent against an actual other tree whose ci-heal builder lacks the fix.
      const dir = mkdtempSync(join(tmpdir(), 'soak-lean-repair-'));
      try {
        mkdirSync(join(dir, 'scripts/operations'), { recursive: true });
        const argvByKind = Object.fromEntries(report.observations.map(row => [row.launchKind, row.argv]));
        argvByKind['ci-heal'] = ['--bg', '--settings', '{}', 'Repair this PR.'];
        writeFileSync(join(dir, SOURCE), `const argv = ${JSON.stringify(argvByKind)};\n`
          + 'export function buildAgentArgv({ payload }) { return argv[payload.launchKind]; }\n');
        check('other tree without ci-heal boundary', fixPresent(dir));
        rmSync(join(dir, SOURCE));
        check('unreadable builder fails closed', fixPresent(dir));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    log?.(JSON.stringify(report));
    return report;
  },
  judge,
};
