// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const script = fileURLToPath(new URL('../fetch-main-history.sh', import.meta.url));
const fetchArgs = '-c http.version=HTTP/1.1 fetch --no-tags --filter=blob:none --depth=1000000 origin +refs/heads/main:refs/remotes/origin/main';

// Execute the production shell, replacing only git and sleep. No network or Git writes.
function runFetch(failures) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fetch-history-'));
  try {
    writeFileSync(join(dir, 'git'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FETCH_TEST_CALLS"
attempt=0
if [ -f "$FETCH_TEST_COUNT" ]; then read -r attempt < "$FETCH_TEST_COUNT"; fi
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "$FETCH_TEST_COUNT"
if [ "$attempt" -le "$FETCH_TEST_FAILURES" ]; then
  echo 'fatal: unable to access remote: Error in the HTTP2 framing layer' >&2
  exit 128
fi
`, { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$FETCH_TEST_SLEEPS"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'sleeps'), '');
    const result = spawnSync('sh', [script], {
      cwd: dir, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`,
        FETCH_TEST_CALLS: join(dir, 'calls'), FETCH_TEST_COUNT: join(dir, 'count'),
        FETCH_TEST_SLEEPS: join(dir, 'sleeps'), FETCH_TEST_FAILURES: String(failures),
      },
    });
    if (result.error) throw result.error;
    return {
      ...result,
      calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
      sleeps: readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CI main history fetch transport recovery', () => {
  it('uses HTTP/1.1 and preserves blobless deep main history without retrying success', () => {
    const result = runFetch(0);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([fetchArgs]);
    expect(result.sleeps).toEqual([]);
  });

  it.each([1, 2])('recovers after %i framing failures and stops as soon as the fetch succeeds', (failures) => {
    const result = runFetch(failures);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(Array(failures + 1).fill(fetchArgs));
    expect(result.sleeps).toEqual(['5', '10'].slice(0, failures));
    expect(result.stderr).toContain('Error in the HTTP2 framing layer');
    expect(result.stderr).not.toContain('refusing unavailable history');
  });

  it('fails closed with the git exit status after three failures and never sleeps after exhaustion', () => {
    const result = runFetch(10);
    expect(result.status).toBe(128);
    expect(result.calls).toEqual(Array(3).fill(fetchArgs));
    expect(result.sleeps).toEqual(['5', '10']);
    expect(result.stderr).toContain('failed after 3 attempts; refusing unavailable history');
  });

  it('wires every CI history fetch to the bounded helper before dependency installation', () => {
    for (const name of ['ci.yml', 'test-selection-measure.yml']) {
      const raw = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');
      const { jobs } = yaml.load(raw);
      expect(raw).not.toMatch(/git fetch --no-tags --filter=blob:none/);
      for (const job of Object.values(jobs)) {
        for (const [index, step] of job.steps.entries()) {
          if (step.name !== 'Fetch main history (blobless)' && step.name !== 'Is this a card-only PR?') continue;
          expect(step.run).toContain('sh scripts/ci/fetch-main-history.sh');
          expect(step['timeout-minutes']).toBe(4);
          expect(step['continue-on-error']).toBeUndefined();
          expect(job.steps.slice(0, index).some((s) => s.name === 'Install')).toBe(false);
          if (step.name === 'Is this a card-only PR?') {
            expect(step.run).toContain('if sh scripts/ci/fetch-main-history.sh; then');
            expect(step.run).toContain('main fetch failed; full suite');
          }
        }
      }
    }
  });
});
