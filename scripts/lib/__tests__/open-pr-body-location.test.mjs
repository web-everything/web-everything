import { describe, it, expect, vi } from 'vitest';
import { checkBodyFileLocation, isWorkerScratchDir, workerScratchDir } from '../open-pr-body-location.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const defaults = { cwd: '/lanes/worker', home: '/home/operator', tmp: '/tmp', isTracked: () => false };
const check = (bodyFile, extra = {}) => checkBodyFileLocation({ ...defaults, bodyFile, ...extra });
const privateTemp = { uid: 123, stat: () => ({ uid: 123, mode: 0o40700, isDirectory: () => true }) };

describe('workerScratchDir', () => {
  it('keeps case-distinct owners separate on case-insensitive filesystems', () => {
    const upper = workerScratchDir('fix', 'Alice1');
    const lower = workerScratchDir('fix', 'alice1');
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
    expect(upper).toMatch(/_alice1-[0-9a-f]{6}$/);
    expect(isWorkerScratchDir(upper.slice('/tmp/'.length))).toBe(true);
    expect(isWorkerScratchDir(lower.slice('/tmp/'.length))).toBe(true);
  });

  it('encodes purpose and owner boundaries uniquely, including repeated and trailing hyphens', () => {
    const purposes = ['fix', 'fix-widget', 'fix-', 'fix--widget'];
    const owners = ['abc12345', 'widget-abc12345', 'widget-', 'A', 'a-b-'];
    const paths = purposes.flatMap(purpose => owners.map(owner => workerScratchDir(purpose, owner)));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(isWorkerScratchDir(path.slice('/tmp/'.length))).toBe(true);
      expect(check(`${path}/body.md`)).toEqual({ ok: true });
    }
  });

  it.each(['a_b', 'a/b', '../a', 'a\n', 'a\r', 'a\u2028', 'ａ', 'a\u200b', '`a`', '"a"', '--a'])('rejects token separators and invalid characters: %j', token => {
    expect(() => workerScratchDir(token, 'owner')).toThrow();
    expect(() => workerScratchDir('fix', token)).toThrow();
  });

  it.each(['we-scratch-fix_', 'we-scratch-_owner', 'we-scratch-fix_owner_extra', 'we-scratch-fix_owner\n'])('does not recognize malformed scratch encoding %j', segment => {
    expect(isWorkerScratchDir(segment)).toBe(false);
  });
});

describe('checkBodyFileLocation', () => {
  it.each(['pr-bodies', 'shared-report', 'team-shared', 'we-scratch-pr-body'])('refuses shared directory %s despite its suffix', name => {
    expect(check(`/tmp/${name}/body.md`, {
      uid: 123, stat: () => ({ uid: 123, mode: 0o40755, isDirectory: () => true }),
    })).toMatchObject({ ok: false, code: 'body-file-shared-path' });
  });

  it.each([
    { uid: 456, mode: 0o40700, isDirectory: () => true },
    { uid: 123, mode: 0o40750, isDirectory: () => true },
    { uid: 123, mode: 0o41700, isDirectory: () => true },
    { uid: 123, mode: 0o100700, isDirectory: () => false },
    undefined,
  ])('refuses missing or non-private stat evidence', evidence => {
    for (const name of ['task-abcdef', 'we-scratch-fix-abcdef']) {
      expect(check(`/tmp/${name}/body.md`, { uid: 123, stat: () => evidence }))
        .toMatchObject({ code: 'body-file-shared-path' });
    }
  });

  it('fails closed when stat throws', () => {
    expect(check('/tmp/task-abcdef/body.md', { stat: () => { throw new Error('EACCES'); } }))
      .toMatchObject({ code: 'body-file-shared-path' });
  });

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

  it('preserves relative traversal for tracking and resolves it for lexical lane containment', () => {
    const isTracked = vi.fn(() => false);
    expect(check('notes/../body.md', { isTracked })).toEqual({ ok: true });
    expect(isTracked).toHaveBeenCalledWith('/lanes/worker/notes/../body.md');
    expect(check('../../tmp/body.md')).toMatchObject({ code: 'body-file-shared-path' });
  });

  it('uses the physical target for directory exemptions after checking the original traversal', () => {
    const isTracked = vi.fn(() => false);
    const resolvePath = path => path === '/lanes/worker/body.md' ? '/tmp/body.md' : path;
    expect(check('body.md', { isTracked, resolvePath })).toMatchObject({ code: 'body-file-shared-path' });
    expect(isTracked).toHaveBeenCalledWith('/lanes/worker/body.md');
  });

  it('fails closed with a scratch fallback when physical resolution is unavailable', () => {
    const result = check('body.md', { resolvePath: () => { throw new Error('EACCES'); } });
    expect(result).toMatchObject({ code: 'body-file-shared-path' });
    expect(result.message).toContain('unable to resolve body location');
    expect(result.message).toContain("brief's per-worker scratch dir");
  });

  it.each(['/lanes/worker/body.md', '/tmp/we-scratch-fix-widget-abcdef12/body.md', '/home/operator/.claude/body.md', '/tmp/task-abcdef/body.md'])('refuses tracked files before any directory exemption: %s', path => {
    const result = check(path, { isTracked: () => true });
    expect(result).toMatchObject({ ok: false, code: 'body-file-tracked' });
    expect(result.message).toContain('worker scratch dir');
    expect(result.message).toContain('git rm --cached');
  });

  it.each(['/tmp/we-scratch-fix-widget-abcdef12/body.md', '/tmp/we-scratch-fix-widget-fedcba98/notes/report.md'])('allows legacy worker scratch directory only with private temp evidence: %s', path => {
    expect(check(path, privateTemp)).toEqual({ ok: true });
    expect(check(path, { stat: () => { throw new Error('ENOENT'); } })).toMatchObject({ code: 'body-file-shared-path' });
    expect(isWorkerScratchDir(path.split('/')[2])).toBe(false);
  });

  it.each(['~/.claude/reports/body.md', '~/workspace/.operations/body.md', '/home/operator/.claude/body.md'])('allows daemon-owned directory %s and expands home', path => {
    expect(check(path)).toEqual({ ok: true });
  });

  it.each(['/tmp/task-abcdef/body.md', '/tmp/task-G7kP2z/notes/body.md', '/tmp/task-gggggg/body.md'])('allows a stat-proven private directory %s', path => {
    const stat = vi.fn(privateTemp.stat);
    expect(check(path, { ...privateTemp, stat })).toEqual({ ok: true });
    expect(stat).toHaveBeenCalledWith(`/tmp/${path.split('/')[2]}`);
  });

  it.each(['/other/task-0123456789/nested/body.md', '/other/we-scratch-build-123abc/body.md'])('refuses private-looking directories outside tmp: %s', path => {
    const stat = vi.fn(privateTemp.stat);
    expect(check(path, { ...privateTemp, stat })).toMatchObject({ code: 'body-file-shared-path' });
    expect(stat).not.toHaveBeenCalled();
  });

  it('does not accept a private nested directory below a shared temp child', () => {
    const stat = vi.fn(path => ({ uid: 123, mode: path === '/tmp/shared' ? 0o40755 : 0o40700, isDirectory: () => true }));
    expect(check('/tmp/shared/task-abcdef/body.md', { uid: 123, stat })).toMatchObject({ code: 'body-file-shared-path' });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith('/tmp/shared');
  });

  it('resolves extra private roots and still checks tracking first', () => {
    const options = { extraPrivateRoots: ['/tmp/card-batch-state'] };
    expect(check('/tmp/card-batch-state/body.md', options)).toEqual({ ok: true });
    expect(check('/tmp/card-batch-state-other/body.md', options)).toMatchObject({ code: 'body-file-shared-path' });
    expect(check('/tmp/card-batch-state/body.md', { ...options, isTracked: () => true })).toMatchObject({ code: 'body-file-tracked' });
  });

  it('accepts the codex-worker body path from a real mkdtempSync directory', () => {
    const caller = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../operations/codex-worker.mjs'), 'utf8');
    expect(caller).toContain("makeScratchDir = () => mkdtempSync(join(tmpdir(), 'codex-worker-'))");
    expect(caller).toContain("const bodyFile = join(scratchDir, 'pr-body.md')");
    const scratch = mkdtempSync(join(tmpdir(), 'codex-worker-'));
    try { expect(check(join(scratch, 'pr-body.md'), { tmp: tmpdir() })).toEqual({ ok: true }); }
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
