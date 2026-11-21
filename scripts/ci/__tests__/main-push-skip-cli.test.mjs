// @vitest-environment node
import { expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const recorded = readFileSync(new URL('./fixtures/main-push-runs.json', import.meta.url), 'utf8');
const sha = 'a'.repeat(40), fui = 'b'.repeat(40);
it.each([['mismatched artifact content', { WRONG_SHA: 'd'.repeat(40) }], ['expired artifact', { EXPIRED: '1' }], ['record from an older attempt', { OLD_ATTEMPT: '1' }]])('CLI reuses CI alongside foreign workflows and fails closed on %s', (_, negative) => {
  const dir = mkdtempSync(join(tmpdir(), 'main-skip-'));
  try {
    const fresh = JSON.parse(recorded); fresh.workflow_runs[0].run_started_at = new Date(Date.now() - 60000).toISOString();
    // Other workflows share the SHA inventory but cannot veto ci.yml reuse or
    // consume check-suite reads. Deliberately omit their check_suite_id.
    fresh.workflow_runs.push(
      { ...fresh.workflow_runs[1], id: 102, path: '.github/workflows/test-selection-measure.yml', check_suite_id: undefined },
      { ...fresh.workflow_runs[0], id: 103, path: '.github/workflows/merge-gate.yml', conclusion: 'skipped', check_suite_id: undefined },
      { ...fresh.workflow_runs[0], id: 104, path: '.github/workflows/soak-replay-gate.yml', conclusion: 'cancelled', check_suite_id: undefined },
    );
    fresh.total_count = fresh.workflow_runs.length;
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(fresh));
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
if (process.env.API_ERROR) process.exit(1);
if (process.env.OVERSIZED) { console.log(JSON.stringify({total_count:1001,workflow_runs:[]})); process.exit(0); }
if (process.env.TRUNCATED) { console.log(JSON.stringify({total_count:1,workflow_runs:[]})); process.exit(0); }
const endpoint = process.argv.slice(2).find(x => x.startsWith('repos/')) || '';
if (endpoint.includes('/check-suites/')) console.log(JSON.stringify({app:{id:15368}}));
else if (endpoint.endsWith('/7/zip')) console.log(JSON.stringify({sha:process.env.WRONG_SHA || '${sha}',run_id:100,run_attempt:1,job:'queue-reuse-record',conclusion:'success'}));
else if (endpoint.includes('/artifacts')) console.log(JSON.stringify({total_count:process.env.MULTIPLE ? 2 : 1,artifacts:[{id:7,expired:!!process.env.EXPIRED,name:'fui-sibling-${fui}'}, ...(process.env.MULTIPLE ? [{id:7,expired:!!process.env.EXPIRED,name:'fui-sibling-${fui}'}] : [])]}));
else { const runs=JSON.parse(require('node:fs').readFileSync(process.env.RUN_FIXTURE,'utf8')); if(process.env.OLD_ATTEMPT) runs.workflow_runs[0].run_attempt=2; console.log(JSON.stringify(runs)); }
`);
    writeFileSync(join(dir, 'git'), `#!/usr/bin/env node
if (process.env.BAD_TIP) process.exit(0);
if (process.argv.includes('ls-remote')) console.log('${fui}\tHEAD');
else process.exit(process.env.BAD_ANCESTRY ? 1 : 0);
`);
    writeFileSync(join(dir, 'funzip'), `#!/usr/bin/env node
process.stdout.write(require('node:fs').readFileSync(0));
`);
    for (const name of ['gh', 'git', 'funzip']) chmodSync(join(dir, name), 0o755);
    const args = [`--sha=${sha}`, `--before=${'c'.repeat(40)}`, '--run-id=101', '--event=push', '--ref=refs/heads/main', '--repo=fixture/repo'];
    const run = (extra = [], env = {}) => spawnSync(process.execPath, [fileURLToPath(new URL('../main-push-skip.mjs', import.meta.url)), ...args, ...extra], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_FIXTURE: join(dir, 'runs.json'),
        FUI_TOKEN: 'fixture-token', WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'), ...env } });
    const good = run(); expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toMatch(new RegExp(`^skip=true\\nreason=[^\\n]*100[^\\n]*\\nfui-sha=${fui}\\n$`));
    for (const [extra, env] of [[['--unknown=yes'], {}], [['--sha=bad'], {}], [[], { API_ERROR: '1' }], [[], { MULTIPLE: '1' }], [[], { BAD_ANCESTRY: '1' }], [[], { OVERSIZED: '1' }], [[], { TRUNCATED: '1' }], [[], { BAD_TIP: '1' }]]) {
      const result = run(extra, env); expect(result.stdout).toMatch(/^skip=false\nreason=[^\n]+\n$/);
    }
    expect(run([], negative).stdout).toMatch(/^skip=false\n/);
    // Probe a later rerun of an older run: the run id stays below the passing queue's id.
    const rerun = JSON.parse(recorded);
    rerun.workflow_runs.push({ ...rerun.workflow_runs[0], id: 99, run_attempt: 2, event: 'workflow_dispatch',
      status: 'in_progress', conclusion: null });
    rerun.total_count++;
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(rerun));
    expect(run().stdout).toMatch(/^skip=false\nreason=[^\n]+\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
