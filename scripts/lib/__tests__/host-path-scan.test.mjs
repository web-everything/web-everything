/** Host path policy and exact tracked-tree ratchet. Fixtures avoid literal host paths. */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { HOST_PATH_RE, PLACEHOLDER_NAMES, findHostPaths, scanHostPaths } from '../host-path-scan.mjs';
import { runHostPathLint } from '../../lint-host-paths.mjs';

const hostPath = '/Us' + 'ers/someone/';
const linuxPath = '/ho' + 'me/someone/';
const doc = content => [{ file: 'doc.md', content }];
const baseline = count => ({ files: { 'doc.md': count } });

describe('host path ratchet', () => {
  it('finds both home forms with names and one-based lines, and refuses new files', () => {
    expect(findHostPaths(`intro\n${hostPath}file\n${linuxPath}file`)).toEqual([
      { match: hostPath, name: 'someone', line: 2 },
      { match: linuxPath, name: 'someone', line: 3 },
    ]);
    const { errors } = scanHostPaths(doc(`intro\n${hostPath}\n${linuxPath}`), { files: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0].descriptor).toEqual({ kind: 'host-local-path', fix: 'model', file: 'doc.md', line: 2 });
    expect(errors[0].message).toMatch(/2 host-local.*NAME.*\$HOME/);
    expect(findHostPaths(hostPath)).toHaveLength(1);
    expect(findHostPaths(hostPath)).toHaveLength(1);
  });

  it('allows only obvious placeholders, home references, and dot-prefixed directories', () => {
    expect(Object.isFrozen(PLACEHOLDER_NAMES)).toBe(true);
    for (const name of PLACEHOLDER_NAMES) {
      expect(findHostPaths('/Users/' + name.toUpperCase() + '/')).toEqual([]);
    }
    expect(findHostPaths('/Users/x/ /Users/me/ /home/user/ $HOME/file ~/file /home/.codex/')).toEqual([]);
    expect(scanHostPaths(doc('/home/.codex/ $HOME/file ~/file'), { files: {} }).errors).toEqual([]);
    for (const name of ['someone', 'nic', 'real', 'runner', '_admin', '9name', '-admin', 'a.b']) {
      expect(findHostPaths('/home/' + name + '/')).toHaveLength(1);
    }
    expect(HOST_PATH_RE.source).toContain('Users|home');
  });

  it('accepts the exact baseline count and refuses increases', () => {
    expect(scanHostPaths(doc(hostPath), baseline(1)).errors).toEqual([]);
    const { errors } = scanHostPaths(doc(`${hostPath}\n${linuxPath}`), baseline(1));
    expect(errors).toHaveLength(1);
    expect(errors[0].descriptor.kind).toBe('host-local-path');
  });

  it('requires baseline shrinkage for decreases, zero hits, and missing files', () => {
    for (const docs of [doc(hostPath), doc('clean'), []]) {
      const { errors } = scanHostPaths(docs, baseline(2));
      expect(errors).toHaveLength(1);
      expect(errors[0].descriptor.kind).toBe('host-local-path-baseline-stale');
      expect(errors[0].message).toMatch(/Shrink the baseline entry/);
    }
  });

  it('refuses a new tracked-looking temp document through injected IO', () => {
    const root = '/tmp/host-path-fixture';
    const { errors } = runHostPathLint({
      root, listFiles: listedRoot => {
        expect(listedRoot).toBe(root);
        return ['new.md'];
      },
      readFile: path => {
        expect(path).toBe(resolve(root, 'new.md'));
        return Buffer.from(`intro\n${hostPath}file`);
      },
      baseline: { files: {} },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].descriptor.line).toBe(2);
  });

  it('skips invalid UTF-8, NUL content, symlink sentinels, and missing files', () => {
    const { errors } = runHostPathLint({
      root: '/tmp/host-path-fixture',
      listFiles: () => ['invalid', 'nul', 'symlink', 'missing', 'valid'],
      readFile: path => {
        if (path.endsWith('/invalid')) return Buffer.from([0xff]);
        if (path.endsWith('/nul')) return Buffer.from(`${hostPath}\0`);
        if (path.endsWith('/symlink')) return null;
        if (path.endsWith('/missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return 'clean';
      },
      baseline: { files: {} },
    });
    expect(errors).toEqual([]);
  });

  it('matches the exact baseline over the REAL tracked tree with real IO', () => {
    expect(runHostPathLint().errors).toEqual([]);
  });
});
