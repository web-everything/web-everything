/** Hooks must run the pinned guard-main copy of a guard, never the lane's own (possibly modified or old) script. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = /scripts\/(guard-[\w-]+|lint-[\w-]+|check-memory|backlog-guard)\.mjs/;
const SECURITY_EVENTS = ['PreToolUse', 'Stop', 'SubagentStop'];

export default {
  id: 'lane-local-guard-loaded-as-hook',
  card: '6665',
  title: 'a lane\'s own guard-bash.mjs is loaded as the hook instead of the pinned guard-main copy',
  fixedBy: { sha: '11d8089322', where: 'lane/pinned-hook-guard', paths: [
    'scripts/hooks/run-pinned-guard.mjs', '.claude/settings.json',
  ] },
  fixPresent(root) { return existsSync(join(root, 'scripts/hooks/run-pinned-guard.mjs')); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    // Every security event is pinned, not only PreToolUse (PostToolUse hooks are advisory).
    const groups = SECURITY_EVENTS.flatMap((event) => settings.hooks?.[event] ?? []);
    if (!SECURITY_EVENTS.every((event) => (settings.hooks?.[event] ?? []).length)) {
      violations.push('a security hook event (PreToolUse, Stop or SubagentStop) has no hooks to inspect');
    }
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const cmd = hook.command ?? '';
        if (GUARD.test(cmd) && !cmd.includes('.guard-main/scripts/hooks/run-pinned-guard.mjs')) {
          violations.push(`hook runs the lane-local script: ${cmd.slice(0, 80)}`);
        }
      }
    }
    if (!this.fixPresent(root)) return { violations: [...violations, 'no pinned launcher exists'] };
    // A launcher copied outside a guard clone, next to a lane-owned guard, must refuse and never run that guard.
    const lane = mkdtempSync(join(tmpdir(), 'soak-lane-guard-'));
    try {
      mkdirSync(join(lane, 'scripts/hooks'), { recursive: true });
      copyFileSync(join(root, 'scripts/hooks/run-pinned-guard.mjs'), join(lane, 'scripts/hooks/run-pinned-guard.mjs'));
      writeFileSync(join(lane, 'scripts/guard-bash.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(lane, 'RAN'))}, '1');\n`);
      const r = spawnSync(process.execPath, [join(lane, 'scripts/hooks/run-pinned-guard.mjs'), 'scripts/guard-bash.mjs'], { cwd: lane, encoding: 'utf8', input: '{}' });
      if (existsSync(join(lane, 'RAN'))) violations.push('the lane-owned guard-bash.mjs ran as the hook');
      if (r.status !== 2 || !/Pinned guard: cannot load dedicated clone guard; denying/.test(r.stderr)) violations.push('the launcher did not refuse a non-guard-clone location with exit 2 (fail-open)');
    } finally { rmSync(lane, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
