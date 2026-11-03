import { describe, it, expect, vi } from 'vitest';
import { checkBodyFileLocation } from '../open-pr-body-location.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const defaults = { cwd: '/lanes/worker', home: '/home/operator', tmp: '/tmp', isTracked: () => false };
const check = (bodyFile, extra = {}) => checkBodyFileLocation({ ...defaults, bodyFile, ...extra });

describe('checkBodyFileLocation', () => {
  it.each(['/tmp/body.md', '/tmp/pr-body.md', '/lanes/worker-other/body.md', '/home/operator/.claude-other/body.md', '/home/operator/workspace/.operations-other/body.md', '/tmp/task-abc12/body.md', '/tmp/task-abcdef.md', '/tmp/shared-reports/body.md', '/workspace/web-everything/body.md'])('refuses shared path %s with the scratch-dir fallback', path => {
    expect(check(path)).toMatchObject({ ok: false, code: 'body-file-shared-path' });
    expect(check(path).message).toContain(path);
    expect(check(path).message).toContain("brief's per-worker scratch dir");
  });

  it.each([() => { throw new Error('Git unavailable'); }, () => undefined])('refuses unavailable tracking evidence even inside the lane', isTracked => {
    const result = check('body.md', { isTracked });
    expect(result).toMatchObject({ ok: false, code: 'body-file-shared-path' });
    expect(result.message).toContain('unable to verify Git tracking');
    expect(result.message).toContain("brief's per-worker scratch dir");
  });

  it.each(['body.md' , './notes/body.md', '/lanes/worker/body.md'])('allows untracked lane file %s without requiring existence', path => {
    expect(check(path)).toEqual({ ok: true });
  });

  it('resolves relative paths before checking tracking and lane containment', () => {
    const isTracked = vi.fn(() => false);
    expect(check('notes/../body.md', { isTracked })).toEqual({ ok: true });
    expect(isTracked).toHaveBeenCalledWith('/lanes/worker/body.md');
    expect(check('../../tmp/body.md')).toMatchObject({ code: 'body-file-shared-path' });
  });

  it.each(['/lanes/worker/body.md', '/tmp/we-scratch-fix-widget-abcdef12/body.md', '/home/operator/.claude/body.md', '/tmp/task-abcdef/body.md'])('refuses tracked files before any directory exemption: %s', path => {
    const result = check(path, { isTracked: () => true });
    expect(result).toMatchObject({ ok: false, code: 'body-file-tracked' });
    expect(result.message).toContain('worker scratch dir');
    expect(result.message).toContain('git rm --cached');
  });

  it.each(['/tmp/we-scratch-fix-widget-abcdef12/body.md', '/tmp/we-scratch-fix-widget-fedcba98/notes/report.md', '/other/we-scratch-build-123abc/body.md'])('allows worker scratch directory %s', path => {
    expect(check(path)).toEqual({ ok: true });
  });

  it.each(['~/.claude/reports/body.md', '~/workspace/.operations/body.md', '/home/operator/.claude/body.md'])('allows daemon-owned directory %s and expands home', path => {
    expect(check(path)).toEqual({ ok: true });
  });

  it.each(['/tmp/task-abcdef/body.md', '/other/task-0123456789/nested/body.md', '/tmp/task-G7kP2z/body.md', '/tmp/task-gggggg/body.md'])('allows private directory %s', path => {
    expect(check(path)).toEqual({ ok: true });
  });

  it('accepts the codex-worker body path from a real mkdtempSync directory', () => {
    const caller = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../operations/codex-worker.mjs'), 'utf8');
    expect(caller).toContain("makeScratchDir = () => mkdtempSync(join(tmpdir(), 'codex-worker-'))");
    expect(caller).toContain("const bodyFile = join(scratchDir, 'pr-body.md')");
    const scratch = mkdtempSync(join(tmpdir(), 'codex-worker-'));
    try { expect(check(join(scratch, 'pr-body.md'))).toEqual({ ok: true }); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('accepts card-batch-extract UUID body files directly in the system temp directory', () => {
    const caller = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../operations/card-batch-extract.mjs'), 'utf8');
    expect(caller).toContain('join(tmpdir(), `card-batch-extract-${randomUUID()}.md`)');
    // A fixed temp root prevents another random ancestor from masking this exemption.
    expect(check('/tmp/card-batch-extract-12345678-1234-1234-1234-123456789abc.md')).toEqual({ ok: true });
    expect(check(join(tmpdir(), `card-batch-extract-${randomUUID()}.md`), { tmp: tmpdir() })).toEqual({ ok: true });
  });

  it('still refuses a tracked extraction body before the UUID temp-file exemption', () => {
    expect(check('/tmp/card-batch-extract-12345678-1234-1234-1234-123456789abc.md', { isTracked: () => true }))
      .toMatchObject({ ok: false, code: 'body-file-tracked' });
  });

  it.each(['/tmp/card-batch-extract-body.md', '/tmp/card-batch-extract-abcdef.md', '/other/card-batch-extract-12345678-1234-1234-1234-123456789abc.md', '/tmp/card-batch-extract-12345678-1234-1234-1234-123456789abc.md/body.md'])('keeps the temp-file exemption narrow: %s', path => {
    expect(check(path)).toMatchObject({ ok: false, code: 'body-file-shared-path' });
  });
});
