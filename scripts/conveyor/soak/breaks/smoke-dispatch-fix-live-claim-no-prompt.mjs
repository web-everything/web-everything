/**
 * A live sentinel fix claim made dispatch-dry-run report "no prompt captured".
 * The rebuild rejected the candidate, so the clone could never adopt it. Exercise
 * that smoke row directly, without a daemon world or any GitHub reads.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

/** Same real store and native-child setup as daemon-live-smoke's regression test.
 * restoreLiveClaimReader is the RED control: restore the dispatcher's default claim read.
 */
export function probe(root = ROOT, { restoreLiveClaimReader = false } = {}) {
  const dest = mkdtempSync(join(tmpdir(), 'soak-smoke-fix-claim-'));
  try {
    // A lane checkout cannot dispatch; copy only the runtime inputs to a non-lane root.
    for (const rel of ['scripts', 'skills-src', 'schemas', 'src/_data',
      'docs/agent/reviewer-expectations.md', 'package.json', '.gitignore']) {
      cpSync(join(root, rel), join(dest, rel), {
        recursive: true,
        filter: src => !src.includes(`${sep}node_modules`) && !src.includes(`${sep}.git${sep}`)
          && !src.endsWith(`${sep}.git`),
      });
    }
    symlinkSync(join(root, 'node_modules'), join(dest, 'node_modules'), 'dir');
    const child = `
const { DISPATCH_DRY_RUN_SCRIPT } = await import('./scripts/lib/daemon-live-smoke.mjs');
const { acquireFixClaim, readLiveFixClaim } = await import('./scripts/conveyor/fix-procedure.mjs');
const claim = acquireFixClaim({ repo: 'we', pr: 900002, who: 'soak-smoke-regression' });
if (!claim.ok) throw new Error('fixture claim acquisition failed: ' + claim.reason);
if (!readLiveFixClaim({ repo: 'we', pr: 900002 })) throw new Error('fixture claim is not live');
let script = DISPATCH_DRY_RUN_SCRIPT;
if (${restoreLiveClaimReader}) {
  script = script.replace('readFixClaim: () => null,', '');
  if (script === DISPATCH_DRY_RUN_SCRIPT) throw new Error('RED control did not restore the default claim reader');
}
await import('data:text/javascript;base64,' + Buffer.from(script).toString('base64'));
if (!readLiveFixClaim({ repo: 'we', pr: 900002 })) throw new Error('smoke consumed the live claim');
`;
    const rows = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: dest, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TMPDIR: dest, WE_COORDINATION_ROOT: join(dest, 'coordination'),
        WE_SMOKE_DISPATCH_PASSES: '0', WE_SMOKE_DRYRUN_ONLY: '', WE_WORKER_WRAPPER: 'off' },
    }));
    if (!Array.isArray(rows)) throw new Error('dispatch dry-run did not return rows');
    const fixes = rows.filter(row => row?.kind === 'fix' && row.pr === 900002);
    if (fixes.length !== 1) throw new Error('dispatch dry-run must return exactly one sentinel fix row');
    return { rows, fix: fixes[0] };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export default {
  id: 'smoke-dispatch-fix-live-claim-no-prompt',
  title: 'dispatch-dry-run fix row passes despite a real live sentinel fix claim',
  card: 'dispatch-dry-run sentinel fix isolation (f4d320db)',
  fixedBy: { sha: 'f4d320db', where: 'branch HEAD', paths: ['scripts/lib/daemon-live-smoke.mjs'] },
  fixPresent(root) {
    try { return probe(root).fix.ok === true; } catch { return false; }
  },
  run({ sourceRoot = ROOT } = {}) {
    try {
      const report = probe(sourceRoot);
      return { ...report, violations: report.fix.ok === true ? []
        : [`fix PR #900002: ${report.fix.error ?? 'missing successful row evidence'}`] };
    } catch (error) {
      return { violations: [`dispatch-dry-run probe incomplete: ${error.message}`] };
    }
  },
  judge(report) { return report.violations; },
};
