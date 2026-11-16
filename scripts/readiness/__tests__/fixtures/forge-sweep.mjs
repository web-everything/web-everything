import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Run the production sweeper in a fresh process. Only host UID/process evidence
// and explicitly requested ownership/read faults are substituted; filesystem
// operations, inode checks, flock leases and deletion remain real.
export function runSweepFixture(root, {before = '', after = '', pythonBefore = '',
  pythonMatch = 'import pwd', apply = true, runRoot = join(root, 'runs')} = {}) {
  const cli = new URL('../../forge-exec-sweep.mjs', import.meta.url);
  const source = `
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const originalSpawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  if (args?.[0] === '-I' && args[1] === '-c' && args[2].includes(${JSON.stringify(pythonMatch)})) {
    args = [...args];
    args[2] = ${JSON.stringify(pythonBefore)} + '\\n' + args[2];
  }
  return originalSpawn(file, args, options);
};
syncBuiltinESMExports();
${before}
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))},
  ${JSON.stringify('--root=' + runRoot)}, ${JSON.stringify('--receipts=' + join(root, 'receipts'))},
  ${JSON.stringify(apply ? '--apply' : '--dry-run')}];
await import(${JSON.stringify(cli.href)});
${after}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source],
    {encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024});
  return {...result, summary: result.stdout ? JSON.parse(result.stdout) : null};
}

export function idleWorkerEvidence(root, {live = false} = {}) {
  const proc = join(root, 'proc');
  return `import os, pwd, types
original_scandir, original_stat = os.scandir, os.stat
worker_uid = os.getuid() + 1000
pwd.getpwnam = lambda _: types.SimpleNamespace(pw_uid=worker_uid)
def fixture_scandir(path):
    return original_scandir(${JSON.stringify(proc)} if path == '/proc' else path)
def fixture_stat(path, *args, **kwargs):
    st = original_stat(path, *args, **kwargs)
    if ${live ? 'True' : 'False'} and isinstance(path, str) and path.startswith(${JSON.stringify(proc + '/')}):
        values = list(st)
        values[4] = worker_uid
        return os.stat_result(values)
    return st
os.scandir, os.stat = fixture_scandir, fixture_stat
`;
}
