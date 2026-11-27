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
  ['coverage shard step', 'Unit suite shard'],
  ['no-coverage group step', 'Unit suite no-coverage group'],
];

function runStep(run, nodeStub) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-shard-steps-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const marker = join(dir, 'npm-invoked');
    writeFileSync(join(bin, 'node'), `#!/bin/bash
case "$1" in
  scripts/ci/job-profile.mjs)
    shift
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
    [ "$#" -gt 0 ] || exit 2
    shift
    exec "$@" ;;
  scripts/ci/quarantine-skip.mjs) exit 0 ;;
esac
${nodeStub}\n`);
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "$@" > "${marker}"\n`);
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

describe.each(STEPS)('ci.yml test-shard %s', (_label, prefix) => {
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

describe('ci.yml job profile', () => {
  it.each(STEPS)('%s prefixes only the final npm invocation and preserves guards and arguments', (_label, prefix) => {
    const step = steps.find(x => x.name?.startsWith(prefix));
    const lines = step.run.split('\n');
    const wrapped = lines.filter(line => line.startsWith('node scripts/ci/job-profile.mjs '));
    expect(wrapped).toHaveLength(1);
    const task = prefix === 'Unit suite shard' ? 'test:coverage:shard' : 'test:unit';
    const job = '--job="test-shard (${{ matrix.shard }})"';
    expect(wrapped[0]).toBe(`node scripts/ci/job-profile.mjs ${job} --out=job-profile.jsonl -- npm run ${task} -- --reporter=default --reporter=json --outputFile.json=coverage/timing-unit-\${{ matrix.shard }}.json "\${files[@]}" $(node scripts/ci/quarantine-skip.mjs) # red-main quarantine (xx7ckd6): skip args from ops/quarantine, empty unless redMainMode=quarantine`);
    const group = prefix === 'Unit suite shard' ? 'covered --shard=${{ matrix.shard }}/9' : 'nocov --shard=1/1';
    expect(lines).toContain(`list=$(node scripts/ci/shard-assign.mjs --suite=unit --group=${group}) || { echo "::error::shard-assign failed; refusing to run an unfiltered suite"; exit 1; }`);
    expect(lines).toContain('[ -n "$list" ] || { echo "::error::shard-assign returned an empty file list"; exit 1; }');
    expect(lines).toContain('while IFS= read -r f; do [ -z "$f" ] || files+=("$f"); done <<< "$list"');
  });

  it('uploads a unique optional artifact even when the shard failed', () => {
    expect(steps.find(x => x.name === 'Upload job profile')).toEqual({
      name: 'Upload job profile', if: 'always()', 'continue-on-error': true, uses: 'actions/upload-artifact@v4',
      with: { name: 'job-profile-unit-${{ matrix.shard }}', path: 'web-everything/job-profile.jsonl', 'if-no-files-found': 'ignore' },
    });
  });
});
