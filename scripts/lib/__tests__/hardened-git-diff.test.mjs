import { describe, expect, it } from 'vitest';
import { hardenedGitDiff, hardenedGitDiffCommand, verifyRenderedDiff } from '../hardened-git-diff.mjs';

const oid = n => String(n).repeat(40);
const record = (path = 'x', { oldMode = '100644', newMode = '100644', oldOid = oid(1), newOid = oid(2) } = {}) =>
  `:${oldMode} ${newMode} ${oldOid} ${newOid} M\0${path}\0`;
const patch = path => `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

describe('raw oid rendering backstop', () => {
  it('refuses a successful empty renderer with changed raw oids', () => {
    const exec = (_cmd, args) => args.includes('--raw') ? record() : '';
    expect(() => hardenedGitDiff(exec, ['diff', '--end-of-options', 'base', 'head'])).toThrow(/human review required/);
  });

  it('requires a hunk in every changed path, not just somewhere in the patch', () => {
    expect(() => verifyRenderedDiff(() => record('x') + record('y'), 'base', 'head', patch('x') + 'diff --git a/y b/y\n'))
      .toThrow(/without reviewable blob hunks/);
  });

  it.each(['', ':100644 broken\0x\0', record().slice(0, -1)])('refuses incomplete or inconsistent raw evidence %j', raw => {
    expect(() => verifyRenderedDiff(() => raw, 'base', 'head', patch('x'))).toThrow(/human review required/);
  });

  it('requires listed paths to equal raw paths', () => {
    expect(() => verifyRenderedDiff(() => record(), 'base', 'head', patch('x'), { paths: ['other'] })).toThrow(/listed\/raw paths differ/);
    expect(verifyRenderedDiff(() => record(), 'base', 'head', patch('x'), { paths: ['x'] })).toEqual(['x']);
  });

  it('accepts mode-only changes with an unchanged oid and a rendered section', () => {
    expect(verifyRenderedDiff(() => record('x', { newMode: '100755', newOid: oid(1) }), 'base', 'head',
      'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual(['x']);
  });

  it('requires symlink hunks and refuses changed submodules', () => {
    const symlink = () => record('x', { oldMode: '120000', newMode: '120000' });
    expect(verifyRenderedDiff(symlink, 'base', 'head', patch('x'))).toEqual(['x']);
    expect(() => verifyRenderedDiff(symlink, 'base', 'head', 'diff --git a/x b/x\n')).toThrow();
    expect(() => verifyRenderedDiff(() => record('x', { oldMode: '160000', newMode: '160000' }), 'base', 'head', patch('x'))).toThrow();
  });

  it('refuses binary summaries even if another hunk is present', () => {
    expect(() => verifyRenderedDiff(() => record(), 'base', 'head', patch('x') + 'Binary files a/x and b/x differ\n')).toThrow();
  });

  it('keeps empty trees scored and rejects duplicate or unknown rendered sections', () => {
    expect(verifyRenderedDiff(() => '', 'base', 'head', '')).toEqual([]);
    expect(() => verifyRenderedDiff(() => record(), 'base', 'head', patch('x') + patch('x'))).toThrow(/duplicate/);
    expect(() => verifyRenderedDiff(() => '', 'base', 'head', 'renderer says nothing changed')).toThrow(/unknown/);
  });

  it('propagates bounded raw-read failures for callers to invalidate the whole result', () => {
    expect(() => verifyRenderedDiff(() => { throw new Error('ENOBUFS'); }, 'base', 'head', patch('x'))).toThrow('ENOBUFS');
  });

  it('removes inherited configuration and repository injection while retaining ordinary environment', () => {
    const { args, opts } = hardenedGitDiffCommand(['diff', 'base', 'head'], {}, {
      PATH: 'tools', GIT_CONFIG_GLOBAL: 'hostile', GIT_CONFIG_SYSTEM: 'hostile', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bigFileThreshold', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_PARAMETERS: 'hostile',
      GIT_DIR: 'other', GIT_WORK_TREE: 'other', GIT_COMMON_DIR: 'other', GIT_INDEX_FILE: 'other',
      GIT_OBJECT_DIRECTORY: 'other', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'other', GIT_EXTERNAL_DIFF: 'hide', GIT_DIFF_OPTS: '-U0',
    });
    expect(opts.env).toMatchObject({ PATH: 'tools', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' });
    for (const key of ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS']) expect(opts.env).not.toHaveProperty(key);
    expect(args).toEqual(expect.arrayContaining(['core.bigFileThreshold=2g', 'diff.algorithm=myers', 'diff.context=3', 'core.quotepath=false', '--text', '--no-textconv', '--no-ext-diff']));
  });
});
