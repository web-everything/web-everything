import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import b, { scenario } from './smoke-queue-behind-priority.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('detects the fix by rebuild admission behaviour in the tree under test', () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
});

it.each([0, 600001])('behind priority preserves holder and routine aging at age %s', async ageMs => {
  expect((await scenario({ ageMs })).violations).toEqual([]);
});

it.each([null, {sha: 'bad', ruling: 'R1', quote: 'operator'}, {sha: 'c'.repeat(40), quote: 'operator'}, {sha: 'c'.repeat(40), ruling: 'R1'}])('behind priority never validates a missing or invalid force request: %j', async forceRequest => {
  expect((await scenario({ forceRequest })).violations).toEqual([]);
});

it('fix detection fails closed on absent and incomplete helpers', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-behind-missing-'));
  try {
    expect(b.fixPresent(root)).toBe(false);
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    const path = join(root, 'scripts/lib/daemon-smoke-slots.mjs');
    writeFileSync(path, 'export const priority = false;');
    expect(b.fixPresent(root)).toBe(false);
    writeFileSync(path, 'export const behindMainPriority = () => false;');
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(['probe', 'wiring', 'always'])('removing rebuild %s makes both detection and replay fail', async mutation => {
  const root = mkdtempSync(join(tmpdir(), 'soak-behind-wiring-'));
  try {
    mkdirSync(join(root, 'scripts/lib/daemon-rebuild'), { recursive: true });
    writeFileSync(join(root, 'scripts/lib/daemon-smoke-slots.mjs'),
      `export * from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-smoke-slots.mjs')).href)};
       ${mutation === 'always' ? 'export const behindMainPriority = () => true;' : ''}`);
    const source = readFileSync('scripts/lib/daemon-rebuild/rebuild.mjs', 'utf8');
    writeFileSync(join(root, 'scripts/lib/daemon-rebuild/rebuild.mjs'), mutation === 'probe'
      ? source.replace("behind = Number(raw)", "behind = undefined")
      : mutation === 'wiring' ? source.replace('now, sleep, priority,', 'now, sleep, priority: false,') : source);
    expect(b.fixPresent(root)).toBe(false);
    expect((await scenario({ sourceRoot: root, behind: mutation === 'always' ? 4 : 5 })).violations).not.toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
