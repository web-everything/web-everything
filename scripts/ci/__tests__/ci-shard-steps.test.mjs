// @vitest-environment node
// PR #4285 review — the `test-shard` steps hand vitest a file list built by `shard-assign.mjs`. If that script
// fails, the step must fail and vitest must NOT run: an empty list would silently run the whole suite (a full
// run under coverage per shard, or a green job with the partition rejected). This runs the real `run:` blocks
// from both workflows under `bash -e` with stub `node` / `npm` binaries and asserts the runner is never invoked.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const WORKFLOWS = ['ci.yml', 'hetzner-jobs.yml'];
const stepRun = (workflow, prefix) => {
  const raw = readFileSync(new URL(`../../../.github/workflows/${workflow}`, import.meta.url), 'utf8');
  const steps = yaml.load(raw).jobs['test-shard'].steps;
  const s = steps.find((x) => typeof x.name === 'string' && x.name.startsWith(prefix));
  if (!s) throw new Error(`no test-shard step named "${prefix}…"`);
  return s.run.replaceAll('${{ matrix.shard }}', '2');
};

const STEPS = [
  ['coverage shard step', 'Unit suite shard'],
  ['no-coverage group step', 'Unit suite no-coverage group'],
];

function runStep(run, nodeStub) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-shard-steps-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const marker = join(dir, 'npm-invoked');
    writeFileSync(join(bin, 'node'), `#!/bin/bash\n${nodeStub}\n`);
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "$@" > "${marker}"\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const r = spawnSync('bash', ['-e', '-c', run], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (r.error) throw r.error;
    if (r.signal) throw new Error(`shard step terminated by ${r.signal}`);
    return { status: r.status, out: `${r.stdout}${r.stderr}`, npmInvoked: existsSync(marker), npmArgs: existsSync(marker) ? readFileSync(marker, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(WORKFLOWS.flatMap((workflow) => STEPS.map(([label, prefix]) => [workflow, label, prefix])))('%s test-shard %s', (workflow, _label, prefix) => {
  it('assignment failure prevents the Vitest invocation', () => {
    const r = runStep(stepRun(workflow, prefix), 'echo "ambiguous filter" >&2; exit 2');
    expect(r.status).not.toBe(0);
    expect(r.npmInvoked).toBe(false);
  });

  it('an empty assignment prevents the Vitest invocation', () => {
    const r = runStep(stepRun(workflow, prefix), 'exit 0');
    expect(r.status).not.toBe(0);
    expect(r.npmInvoked).toBe(false);
  });

  it('blank lines in the assignment are dropped, never passed as an empty filter', () => {
    const r = runStep(stepRun(workflow, prefix), 'printf "\\nscripts/a.test.mjs\\n\\nscripts/b.test.mjs\\n\\n"');
    expect(r.status).toBe(0);
    expect(r.npmArgs.trim().endsWith('scripts/a.test.mjs scripts/b.test.mjs')).toBe(true);
  });

  it('a good assignment hands every file to Vitest as its own argument', () => {
    const r = runStep(stepRun(workflow, prefix), 'printf "%s\\n" scripts/a.test.mjs scripts/b.test.mjs');
    expect(r.status).toBe(0);
    expect(r.npmInvoked).toBe(true);
    expect(r.npmArgs).toContain('scripts/a.test.mjs scripts/b.test.mjs');
  });

  it('does not build the file list from a process substitution', () => {
    expect(stepRun(workflow, prefix)).not.toMatch(/<\s*<\(/);
  });
});
