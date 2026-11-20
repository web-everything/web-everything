// @vitest-environment node
import { expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const recorded = readFileSync(new URL('./fixtures/main-push-runs.json', import.meta.url), 'utf8');
const sha = 'a'.repeat(40), fui = 'b'.repeat(40);
it('CLI emits exactly output lines with PATH-stubbed GitHub/git, and fails closed on bad arguments/API/records/ancestry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-skip-'));
  try {
    writeFileSync(join(dir, 'runs.json'), recorded);
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
if (process.env.API_ERROR) process.exit(1);
if (process.env.OVERSIZED) { console.log(JSON.stringify({total_count:1001,workflow_runs:[]})); process.exit(0); }
if (process.env.TRUNCATED) { console.log(JSON.stringify({total_count:1,workflow_runs:[]})); process.exit(0); }
const endpoint = process.argv.slice(2).find(x => x.startsWith('repos/')) || '';
if (endpoint.includes('/check-suites/')) console.log(JSON.stringify({app:{id:15368}}));
else if (endpoint.includes('/artifacts')) console.log(JSON.stringify({total_count:process.env.MULTIPLE ? 2 : 1,artifacts:[{name:'fui-sibling-${fui}'}, ...(process.env.MULTIPLE ? [{name:'fui-sibling-${fui}'}] : [])]}));
else console.log(require('node:fs').readFileSync(process.env.RUN_FIXTURE,'utf8'));
`);
    writeFileSync(join(dir, 'git'), `#!/usr/bin/env node
if (process.env.BAD_TIP) process.exit(0);
if (process.argv.includes('ls-remote')) console.log('${fui}\tHEAD');
else process.exit(process.env.BAD_ANCESTRY ? 1 : 0);
`);
    for (const name of ['gh', 'git']) chmodSync(join(dir, name), 0o755);
    const args = [`--sha=${sha}`, `--before=${'c'.repeat(40)}`, '--run-id=101', '--event=push', '--ref=refs/heads/main', '--repo=fixture/repo'];
    const run = (extra = [], env = {}) => spawnSync(process.execPath, [fileURLToPath(new URL('../main-push-skip.mjs', import.meta.url)), ...args, ...extra], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_FIXTURE: join(dir, 'runs.json'),
        FUI_TOKEN: 'fixture-token', WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'), ...env } });
    const good = run(); expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toMatch(/^skip=true\nreason=[^\n]*100[^\n]*\n$/);
    for (const [extra, env] of [[['--unknown=yes'], {}], [['--sha=bad'], {}], [[], { API_ERROR: '1' }], [[], { MULTIPLE: '1' }], [[], { BAD_ANCESTRY: '1' }], [[], { OVERSIZED: '1' }], [[], { TRUNCATED: '1' }], [[], { BAD_TIP: '1' }]]) {
      const result = run(extra, env); expect(result.stdout).toMatch(/^skip=false\nreason=[^\n]+\n$/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
