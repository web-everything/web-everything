// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { checkTimingsBotOnly } from '../check-timings-bot-only.mjs';

const file = 'scripts/ci/test-timings.json';
const SHA = 'a'.repeat(40);
const check = (changedFiles, headRef = 'lane/test', author = 'developer') => checkTimingsBotOnly({ changedFiles, headRef, author, headRepo: 'o/r', repo: 'o/r' });
const script = new URL('../check-timings-bot-only.mjs', import.meta.url);
const cli = env => spawnSync(process.execPath, [script.pathname], {
  env: { ...process.env, BASE_SHA: '', HEAD_REF: '', ...env }, encoding: 'utf8', timeout: 5000,
});

describe('bot-owned timings', () => {
  it('rejects a non-bot PR editing timings and names the owner workflow', () => {
    expect(check([file])).toMatchObject({ ok: false, message: expect.stringContaining('ci-timings-refresh.yml') });
    expect(check([file]).message).toContain(file);
  });
  it('permits the exact bot branch from the bot author', () => expect(check([file], 'ci/refresh-test-timings', 'web-everything[bot]').ok).toBe(true));
  it('refuses the bot branch name from a human author', () => expect(check([file], 'ci/refresh-test-timings').ok).toBe(false));
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
  it('CLI fails closed when the GitHub API call fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
      expect(cli({ GITHUB_EVENT_NAME: 'pull_request', REPO: 'o/r', PR_NUMBER: '1', HEAD_REF: 'lane/test', HEAD_SHA: SHA, PATH: `${dir}:${process.env.PATH}` }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('CLI reads the file list from the API and rejects a non-bot edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst a = process.argv.join(' ');\nprocess.stdout.write(a.includes('.head.sha') ? '${SHA}\\n' : a.includes('.base.ref') ? 'main\\n' : 'a.txt\\0\\n${file}\\0\\n');\n`, { mode: 0o755 });
      const env = { GITHUB_EVENT_NAME: 'pull_request', REPO: 'o/r', PR_NUMBER: '1', HEAD_SHA: SHA, HEAD_REPO: 'o/r', PATH: `${dir}:${process.env.PATH}` };
      expect(cli({ ...env, HEAD_REF: 'lane/test', AUTHOR: 'developer' }).status).toBe(1);
      // The bot branch name alone is not enough: a human author or a fork is refused.
      expect(cli({ ...env, HEAD_REF: 'ci/refresh-test-timings', AUTHOR: 'developer' }).status).toBe(1);
      expect(cli({ ...env, HEAD_REF: 'ci/refresh-test-timings', AUTHOR: 'web-everything[bot]', HEAD_REPO: 'fork/r' }).status).toBe(1);
      expect(cli({ ...env, HEAD_REF: 'ci/refresh-test-timings', AUTHOR: 'web-everything[bot]' }).status).toBe(0);
      // A moved head (newer push) fails closed.
      expect(cli({ ...env, HEAD_SHA: 'b'.repeat(40), HEAD_REF: 'ci/refresh-test-timings', AUTHOR: 'web-everything[bot]' }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // Fake gh: the pulls/files answer is stale (carries a bot refresh already in main); the compare answer is the merge-base diff.
  const MB = 'c'.repeat(40);
  const fakeGh = (dir, { compare, pullFiles = `a.txt\\0\\n${file}\\0\\n`, compareFails = false, blobs = ['x', 'x'] }) => writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const a = process.argv.join(' ');
if (a.includes('.head.sha')) process.stdout.write('${SHA}\\n');
else if (a.includes('.base.ref')) process.stdout.write('main\\n');
else if (a.includes('.merge_base_commit.sha')) process.stdout.write('${MB}\\n');
else if (a.includes('/contents/')) process.stdout.write(a.includes('ref=${MB}') ? '${blobs[0]}\\n' : '${blobs[1]}\\n');
else if (a.includes('/compare/')) { ${compareFails ? 'process.exit(1);' : `process.stdout.write('${compare}');`} }
else process.stdout.write('${pullFiles}');
`, { mode: 0o755 });
  const stale = { GITHUB_EVENT_NAME: 'pull_request', REPO: 'o/r', PR_NUMBER: '1', HEAD_SHA: SHA, HEAD_REPO: 'o/r', HEAD_REF: 'lane/test', AUTHOR: 'developer' };
  it('ignores a timings change that is only in main since the PR base (stale base after a bot refresh)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      fakeGh(dir, { compare: 'a.txt\\0\\n' });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('still rejects a PR that itself edits the timings file (merge-base diff)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      fakeGh(dir, { compare: `a.txt\\0\\n${file}\\0\\n`, pullFiles: 'a.txt\\0\\n' });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails closed when the merge-base compare is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      fakeGh(dir, { compare: '', compareFails: true, pullFiles: 'a.txt\\0\\n' });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails closed on an empty compare answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    try {
      fakeGh(dir, { compare: '' });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a truncated 300-file compare falls back to the timings blob at merge-base vs head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-gh-'));
    const many = Array.from({ length: 300 }, (_, i) => `f${i}.txt\\0\\n`).join('');
    try {
      fakeGh(dir, { compare: many, blobs: ['x', 'x'] });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(0);
      fakeGh(dir, { compare: many, blobs: ['x', 'y'] });
      expect(cli({ ...stale, PATH: `${dir}:${process.env.PATH}` }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails closed at the API file cap', () => {
    expect(checkTimingsBotOnly({ changedFiles: Array.from({ length: 3000 }, (_, i) => `f${i}`), headRef: 'lane/test', author: 'developer' }).ok).toBe(false);
  });
  it('CLI fails closed on an oversized diff and asks a maintainer to inspect it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timings-diff-'));
    try {
      // Fake git isolates the output bound without creating an enormous repository.
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const { writeSync } = require('node:fs');
if (process.argv.includes('.head.sha')) { writeSync(1, '${SHA}\\n'); process.exit(0); }
if (process.argv.includes('.base.ref')) { writeSync(1, 'main\\n'); process.exit(0); }
const chunk = Buffer.alloc(1024 * 1024, 97);
for (let i = 0; i < 17; i++) writeSync(1, chunk);
`, { mode: 0o755 });
      const result = cli({
        GITHUB_EVENT_NAME: 'pull_request', REPO: 'o/r', PR_NUMBER: '1', HEAD_REF: 'lane/test', HEAD_SHA: SHA,
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
      GH_TOKEN: '${{ github.token }}',
      REPO: '${{ github.repository }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      HEAD_REF: '${{ github.event.pull_request.head.ref }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      AUTHOR: '${{ github.event.pull_request.user.login }}',
      HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
    });
    expect(workflow.jobs.changes.permissions['pull-requests']).toBe('read');
    expect(steps[0].with['fetch-depth']).toBe(50);
    expect(steps.indexOf(step)).toBeGreaterThan(0);
  });
  it('the writer allowlist matches the refresh workflow name', () => {
    const workflow = yaml.safeLoad(readFileSync(new URL('../../../.github/workflows/ci-timings-refresh.yml', import.meta.url), 'utf8'));
    expect(workflow.name).toBe('Refresh CI test timings');
  });
});
