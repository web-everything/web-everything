import { describe, it, test, expect, afterEach, mock } from 'bun:test';
import { stubEnv, unstubAllEnvs } from '../../env-stub.ts';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildDelegationMarker, parseDelegationMarker } from '../../../scripts/lib/delegation-marker.mjs';
import { parseAuthorActorId } from '../../../scripts/lib/review-independence.mjs';

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  unstubAllEnvs();
  mock.restore();
  mock.clearAllMocks();
});
const triple = { provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' };
let loadN = 0;
async function load(args = []) {
  // NO bun equivalent of vi.resetModules(): the ESM registry cannot be cleared, so bust it with a unique query.
  stubEnv('CLAUDE_CODE_SESSION_ID', 'author-session');
  process.argv = ['node', 'test-import', ...args];
  return import(`../../../scripts/pr-land.mjs?fresh=${++loadN}`);
}

describe('pr-land --delegation', () => {
  it('valid flag composes both author and delegation stamps into the PR body', async () => {
    const { composePrBody } = await load(['--delegation=codex:gpt-6-astra:bugfix']);
    const body = composePrBody('Fix the launch wrapper.');
    expect(parseAuthorActorId(body)).toBe('author-session');
    expect(parseDelegationMarker(body)).toEqual(triple);
  });
  it('absent flag preserves the author stamp without any delegation marker', async () => {
    const { composePrBody } = await load();
    const body = composePrBody('Ordinary work.');
    expect(parseAuthorActorId(body)).toBe('author-session');
    expect(body).not.toContain('delegation:');
  });
  it('stamps idempotently, including malformed/conflicting existing stamps and empty bodies', async () => {
    const { withDelegationStamp } = await load(['--delegation=codex:gpt-6-astra:bugfix']);
    const once = withDelegationStamp('body');
    expect(withDelegationStamp(once)).toBe(once);
    for (const body of ['', '  ', null, undefined, '<!-- delegation: broken -->', `${once}\n${buildDelegationMarker({ ...triple, model: 'other' })}`]) {
      expect(withDelegationStamp(body)).toBe(body);
    }
    expect(withDelegationStamp('body', '')).toBe('body');
  });
  it.each(['codex:gpt-6-astra:invalid', 'codex:gpt-6-astra', 'codex:gpt-6-astra:bugfix:extra', ':gpt-6-astra:bugfix', 'codex:bad model:bugfix', 'codex:bad\nmodel:bugfix', '', null])('fails closed for malformed flag %j before creating a PR', (value) => {
    // A child Node process preserves file: import.meta URLs. Both external binaries are inert,
    // recording stubs: a validation regression cannot push or open a real PR during this test.
    const dir = mkdtempSync(join(tmpdir(), 'pr-land-delegation-'));
    const calls = join(dir, 'calls');
    try {
      for (const name of ['git', 'gh']) {
        const binary = join(dir, name);
        writeFileSync(binary, '#!/bin/sh\necho called >> "$DELEGATION_TEST_CALLS"\nexit 1\n');
        chmodSync(binary, 0o755);
      }
      const result = spawnSync(process.execPath, [resolve('scripts/pr-land.mjs'), value === null ? '--delegation' : `--delegation=${value}`], {
        cwd: dir, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PATH: dir, DELEGATION_TEST_CALLS: calls },
      });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('invalid --delegation');
      expect(existsSync(calls)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
