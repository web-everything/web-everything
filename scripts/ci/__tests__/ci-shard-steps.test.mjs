// @vitest-environment node
// PR #4285 review — the `test-shard` steps hand vitest a file list built by `shard-assign.mjs`. If that script
// fails, the step must fail and vitest must NOT run: an empty list would silently run the whole suite (a full
// run under coverage per shard, or a green job with the partition rejected). This runs the real `run:` blocks
// from ci.yml under `bash -e` with stub `node` / `npm` binaries and asserts the runner is never invoked.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const steps = yaml.load(raw).jobs['test-shard'].steps;
const stepRun = (prefix) => {
  const s = steps.find((x) => typeof x.name === 'string' && x.name.startsWith(prefix));
  if (!s) throw new Error(`no test-shard step named "${prefix}…"`);
  return s.run.replaceAll('${{ matrix.shard }}', '2');
};

const STEPS = [
  ['coverage shard step', 'Unit suite shard', 'covered'],
  ['no-coverage group step', 'Unit suite no-coverage group', 'nocov'],
];

function runStep(run, nodeStub, npmExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-shard-steps-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const marker = join(dir, 'npm-invoked');
    writeFileSync(join(bin, 'node'), `#!/bin/bash\n${nodeStub}\n`);
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "$@" > "${marker}"\nexit ${npmExit}\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const r = spawnSync('bash', ['-e', '-c', run], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, npmInvoked: existsSync(marker), npmArgs: existsSync(marker) ? readFileSync(marker, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(STEPS)('ci.yml test-shard %s', (_label, prefix, mode) => {
  it('uses the JSON producer that preserves global errors', () => {
    expect(stepRun(prefix)).toContain('--reporter=./scripts/ci/unit-json-reporter.mjs');
  });

  it.each([0, 1])('failed first run calls retry and propagates its exit %s', retryExit => {
    const r = runStep(stepRun(prefix), `
      case "$1" in
        *shard-assign*) echo scripts/a.test.mjs ;;
        *quarantine-skip*) echo --exclude=quarantined.test.mjs ;;
        *rerun-failed-once*) echo "retry-invoked:$*"; exit ${retryExit} ;;
      esac`, 1);
    expect(r.status).toBe(retryExit);
    expect(r.out).toContain(`retry-invoked:scripts/ci/rerun-failed-once.mjs --shard=2 --mode=${mode} --first-exit=1 -- --exclude=quarantined.test.mjs`);
    expect(r.npmArgs).toContain('--exclude=quarantined.test.mjs');
  });

  it('a successful first run never calls retry', () => {
    const r = runStep(stepRun(prefix), `case "$1" in *shard-assign*) echo scripts/a.test.mjs ;; *rerun-failed-once*) echo unexpected-retry; exit 1 ;; esac`);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('unexpected-retry');
  });

  it('assignment failure prevents the Vitest invocation', () => {
    const r = runStep(stepRun(prefix), 'echo "ambiguous filter" >&2; exit 2');
    expect(r.status).not.toBe(0);
    expect(r.npmInvoked).toBe(false);
  });

  it('an empty assignment prevents the Vitest invocation', () => {
    const r = runStep(stepRun(prefix), 'exit 0');
    expect(r.status).not.toBe(0);
    expect(r.npmInvoked).toBe(false);
  });

  it('blank lines in the assignment are dropped, never passed as an empty filter', () => {
    const r = runStep(stepRun(prefix), 'printf "\\nscripts/a.test.mjs\\n\\nscripts/b.test.mjs\\n\\n"');
    expect(r.status).toBe(0);
    expect(r.npmArgs.trim().endsWith('scripts/a.test.mjs scripts/b.test.mjs')).toBe(true);
  });

  it('a good assignment hands every file to Vitest as its own argument', () => {
    const r = runStep(stepRun(prefix), 'printf "%s\\n" scripts/a.test.mjs scripts/b.test.mjs');
    expect(r.status).toBe(0);
    expect(r.npmInvoked).toBe(true);
    expect(r.npmArgs).toContain('scripts/a.test.mjs scripts/b.test.mjs');
  });
});

describe('ci.yml test-shard steps — no fail-open list construction', () => {
  it.each(STEPS)('%s does not build the file list from a process substitution', (_label, prefix) => {
    expect(stepRun(prefix)).not.toMatch(/<\s*<\(/);
  });
});

it('covered first runs retain coverage on failure, with always-uploaded flake evidence', () => {
  expect(stepRun('Unit suite shard')).toContain('--coverage.reportOnFailure=true');
  const upload = steps.find(s => s.name === 'Upload shard flake records');
  // Uploaded even after a red step, but skipped on card-only PRs like every other expensive shard step.
  expect(upload.if).toBe("${{ always() && needs.changes.outputs.light != 'true' }}");
  expect(upload.with['if-no-files-found']).toBe('ignore');
  expect(upload.with.path).toBe('web-everything/coverage/flaky-unit-*.json');
});
