// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { checkTimingsBotOnly } from '../check-timings-bot-only.mjs';

const file = 'scripts/ci/test-timings.json';
const check = (changedFiles, headRef = 'lane/test') => checkTimingsBotOnly({ changedFiles, headRef, author: 'developer' });
const script = new URL('../check-timings-bot-only.mjs', import.meta.url);
const cli = env => spawnSync(process.execPath, [script.pathname], {
  env: { ...process.env, BASE_SHA: '', HEAD_REF: '', ...env }, encoding: 'utf8', timeout: 5000,
});

describe('bot-owned timings', () => {
  it('rejects a non-bot PR editing timings and names the owner workflow', () => {
    expect(check([file])).toMatchObject({ ok: false, message: expect.stringContaining('ci-timings-refresh.yml') });
    expect(check([file]).message).toContain(file);
  });
  it('permits the exact bot branch', () => expect(check([file], 'ci/refresh-test-timings').ok).toBe(true));
  it('permits unrelated PR changes', () => expect(check(['scripts/ci/shard-assign.mjs']).ok).toBe(true));
  it('permits a nested lookalike path', () => expect(check([`foo/${file}`]).ok).toBe(true));
  it('fails closed on incomplete changed-file evidence', () => expect(check(undefined).ok).toBe(false));
  it.each(['push', 'merge_group', 'workflow_dispatch'])('CLI skips %s without PR evidence', event => {
    expect(cli({ GITHUB_EVENT_NAME: event }).status).toBe(0);
  });
  it('CLI refuses missing PR evidence with a recovery message', () => {
    const result = cli({ GITHUB_EVENT_NAME: 'pull_request' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ci-timings-refresh.yml.*rerun CI/);
  });
  it('CLI refuses an unavailable merge base', () => {
    expect(cli({ GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: '0'.repeat(40), HEAD_REF: 'lane/test' }).status).toBe(1);
  });
  it('CLI fails closed on an oversized diff and asks a maintainer to inspect it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-diff-'));
    try {
      // Fake git isolates the output bound without creating an enormous repository.
      writeFileSync(join(dir, 'git'), `#!${process.execPath}
const { writeSync } = require('node:fs');
const chunk = Buffer.alloc(1024 * 1024, 97);
for (let i = 0; i < 17; i++) writeSync(1, chunk);
`, { mode: 0o755 });
      const result = cli({
        GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: 'a'.repeat(40), HEAD_REF: 'lane/test',
        PATH: `${dir}:${process.env.PATH}`,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/over 16 MiB.*maintainer.*full diff/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('CI runs the script only for pull_request with full history and env event values', () => {
    const workflow = yaml.safeLoad(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const steps = workflow.jobs.changes.steps;
    const step = steps.find(step => step.run === 'node scripts/ci/check-timings-bot-only.mjs');
    expect(step.if).toBe("github.event_name == 'pull_request'");
    expect(step.env).toEqual({
      GITHUB_EVENT_NAME: '${{ github.event_name }}',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_REF: '${{ github.event.pull_request.head.ref }}',
    });
    expect(steps[0].with['fetch-depth']).toBe(0);
    expect(steps.indexOf(step)).toBeGreaterThan(0);
  });
  it('the writer allowlist matches the refresh workflow name', () => {
    const workflow = yaml.safeLoad(readFileSync(new URL('../../../.github/workflows/ci-timings-refresh.yml', import.meta.url), 'utf8'));
    expect(workflow.name).toBe('Refresh CI test timings');
  });
});
