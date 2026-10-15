import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedLaneDependencies } from './sim/dependencies.mjs';

// In-memory filesystem: no git repositories, npm installs or network access needed.
function fixture({ lock = true, installed = true } = {}) {
  const lane = join('fixture', 'lane-1');
  const modules = join('fixture', 'installed', 'node_modules');
  const files = new Map([
    [join(lane, 'package.json'), '{"name":"sim"}'],
    [join(lane, '.git', 'info', 'exclude'), '# fixture\n'],
    ...(lock ? [[join(lane, 'package-lock.json'), '{"lockfileVersion":3}']] : []),
    ...(installed ? [[modules, 'directory']] : []),
  ]);
  const io = {
    exists: path => files.has(path),
    read: path => Buffer.from(files.get(path)),
    link: (source, target) => files.set(target, source),
    append: (path, text) => files.set(path, files.get(path) + text),
    write: (path, text) => files.set(path, text),
  };
  return { lane, modules, files, io };
}

describe('simulator lane dependencies', () => {
  it('makes an ordinary acquire see dependencies as ready without installing', () => {
    const { lane, modules, files, io } = fixture();
    seedLaneDependencies(lane, modules, io);
    expect(files.get(join(lane, 'node_modules'))).toBe(modules);
    expect(files.get(join(lane, '.git', 'info', 'exclude')).split('\n')).toContain('node_modules');
    expect(files.get(join(lane, '.git', '.lane-pool-deps'))).toBe(
      createHash('sha256').update(files.get(join(lane, 'package-lock.json'))).digest('hex'),
    );
    // Resetting the tracked tree keeps these ignored dependencies and the .git marker.
    seedLaneDependencies(lane, modules, { ...io, link: () => { throw new Error('already linked'); } });
    expect(files.get(join(lane, 'node_modules'))).toBe(modules);
  });

  it('uses package.json when the fixture has no lockfile, like depsReady', () => {
    const { lane, modules, files, io } = fixture({ lock: false });
    seedLaneDependencies(lane, modules, io);
    expect(files.get(join(lane, '.git', '.lane-pool-deps'))).toBe(
      createHash('sha256').update(files.get(join(lane, 'package.json'))).digest('hex'),
    );
  });

  it('fails before marking a lane ready when the installed dependencies are missing', () => {
    const { lane, modules, files, io } = fixture({ installed: false });
    const before = [...files];
    expect(() => seedLaneDependencies(lane, modules, io)).toThrow('dependencies are missing');
    expect([...files]).toEqual(before);
  });
});
