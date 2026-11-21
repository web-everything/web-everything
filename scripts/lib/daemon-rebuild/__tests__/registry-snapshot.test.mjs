import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { registrySnapshotHash } from '../prepare.mjs';
import { overlayFilePath } from '../../daemon-overlays.mjs';

let root, env, file, events;
const sha = 'a'.repeat(40);
const entry = { ref: 'lane/a', sha, edgeResolution: { by: 'operator', sha }, arbitrary: { b: 2, a: 1 } };
const git = () => ({ status: 0, stdout: sha });
const snapshot = (refs = {}, runner = git) => registrySnapshotHash({ root, env, git: runner, refs });
const registry = (overlays) => writeFileSync(file, JSON.stringify({ overlays }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-snapshot-'));
  env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  file = overlayFilePath(root, env);
  events = file.replace(/\.json$/, '.events.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  registry([entry]);
  writeFileSync(events, JSON.stringify({ kind: 'added', ref: entry.ref }) + '\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('hashes one canonical snapshot independently of object key insertion order', () => {
  const before = snapshot({ failed: { b: sha, a: 'failure' } });
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  registry([{ arbitrary: { a: 1, b: 2 }, edgeResolution: { sha, by: 'operator' }, sha, ref: entry.ref }]);
  expect(snapshot({ failed: { a: 'failure', b: sha } })).toBe(before);
});

it('includes every registration field and preserves overlay ordering', () => {
  const before = snapshot();
  registry([{ ...entry, arbitrary: { b: 3, a: 1 } }]);
  expect(snapshot()).not.toBe(before);
  const second = { ref: 'lane/b' };
  registry([entry, second]);
  const ordered = snapshot();
  registry([second, entry]);
  expect(snapshot()).not.toBe(ordered);
});

it.each(['readyFailed', 'failed', 'dropRefs'])('includes candidate %s SHAs', (key) => {
  expect(snapshot({ [key]: [{ ref: entry.ref, sha }] }))
    .not.toBe(snapshot({ [key]: [{ ref: entry.ref, sha: 'b'.repeat(40) }] }));
});

it('includes the resolved origin tip of every registered ref, including omitted refs', () => {
  registry([entry, { ref: 'lane/omitted' }]);
  expect(snapshot()).not.toBe(snapshot({}, (args) => ({ status: 0,
    stdout: args.at(-1).includes('omitted') ? 'b'.repeat(40) : sha })));
});

it.each(['registry', 'event log', 'event shape', 'origin tip', 'unreadable event log'])
('fails closed even on repeated unreadable %s snapshots', (source) => {
  const good = snapshot();
  let runner = git;
  if (source === 'registry') writeFileSync(file, '{');
  if (source === 'event log') writeFileSync(events, '{');
  if (source === 'event shape') writeFileSync(events, 'null');
  if (source === 'origin tip') runner = () => ({ status: 1, stdout: '' });
  if (source === 'unreadable event log') { rmSync(events); mkdirSync(events); }
  const unreadable = snapshot({}, runner);
  expect(typeof unreadable).toBe('symbol');
  expect(unreadable).not.toBe(good);
  expect(snapshot({}, runner)).not.toBe(unreadable);
});
