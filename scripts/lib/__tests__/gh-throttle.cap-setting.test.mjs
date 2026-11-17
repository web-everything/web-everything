import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_SLOT_WAIT_TOOL_FILE, resolveGhCap, resolveGhCapDetailed } from '../gh-throttle.mjs';
import { loadGhThrottleSettings } from '../gh-throttle-holders.mjs';

describe('gh concurrency cap setting', () => {
  let dir, toolFile, stderr;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gh-cap-setting-'));
    toolFile = join(dir, 'settings.json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const save = (file, cap) => writeFileSync(file, JSON.stringify({ ghThrottle: { cap } }));

  it('returns default 6 and its source with no file or env', () => {
    expect(resolveGhCapDetailed({}, { toolFile })).toEqual({ cap: 6, source: 'default' });
    expect(resolveGhCap({}, { toolFile })).toBe(6);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('reads file 12 with tool source and rereads changes without caching', () => {
    save(toolFile, 12);
    expect(resolveGhCapDetailed({}, { toolFile })).toEqual({ cap: 12, source: 'tool' });
    save(toolFile, 14);
    expect(resolveGhCap({}, { toolFile })).toBe(14);
  });

  it('allows injected tool contents without reading the file', () => {
    writeFileSync(toolFile, 'bad JSON');
    expect(resolveGhCapDetailed({}, { toolFile, tool: { cap: 12 } })).toEqual({ cap: 12, source: 'tool' });
    expect(resolveGhCapDetailed({}, { tool: {} })).toEqual({ cap: 6, source: 'default' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('env overrides file and reports env source while the legacy export returns a number', () => {
    save(toolFile, 12);
    const env = { WE_GH_THROTTLE_CAP: '20' };
    expect(resolveGhCapDetailed(env, { toolFile })).toEqual({ cap: 20, source: 'env' });
    expect(resolveGhCap(env, { toolFile })).toBe(20);
  });

  it.each([0, -1, 51, 1.5, 'x', '12', null, true, NaN])('invalid tool cap %s warns and falls back to default', cap => {
    save(toolFile, cap);
    expect(resolveGhCapDetailed({}, { toolFile })).toEqual({ cap: 6, source: 'default' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid tool ghThrottle.cap'));
  });

  it.each(['0', '-1', '51', '1.5', 'x', 'NaN', '', ' ', 'Infinity'])('invalid env cap %s warns and falls back to file', cap => {
    save(toolFile, 12);
    expect(resolveGhCapDetailed({ WE_GH_THROTTLE_CAP: cap }, { toolFile })).toEqual({ cap: 12, source: 'tool' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid env ghThrottle.cap'));
  });

  it('falls through both invalid layers to default and warns for each', () => {
    save(toolFile, 51);
    expect(resolveGhCapDetailed({ WE_GH_THROTTLE_CAP: '1.5' }, { toolFile })).toEqual({ cap: 6, source: 'default' });
    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it.each([1, 50])('accepts the inclusive bound %s from tool and env', cap => {
    expect(resolveGhCapDetailed({}, { tool: { cap } })).toEqual({ cap, source: 'tool' });
    expect(resolveGhCapDetailed({ WE_GH_THROTTLE_CAP: String(cap) }, { tool: {} })).toEqual({ cap, source: 'env' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('tolerates malformed and unreadable files with a warning and lower-layer fallback', () => {
    writeFileSync(toolFile, '{');
    expect(resolveGhCapDetailed({}, { toolFile })).toEqual({ cap: 6, source: 'default' });
    expect(resolveGhCapDetailed({}, { toolFile: dir })).toEqual({ cap: 6, source: 'default' });
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(resolveGhCapDetailed({ WE_GH_THROTTLE_CAP: '9' }, { toolFile })).toEqual({ cap: 9, source: 'env' });
  });

  it('ignores an absent cap while preserving other ghThrottle settings', () => {
    writeFileSync(toolFile, JSON.stringify({ ghThrottle: { maxHoldSeconds: 90 } }));
    expect(resolveGhCapDetailed({}, { toolFile })).toEqual({ cap: 6, source: 'default' });
    expect(stderr).not.toHaveBeenCalled();
    const settings = JSON.parse(readFileSync(GH_SLOT_WAIT_TOOL_FILE, 'utf8'));
    expect(settings.ghThrottle).toEqual({ cap: 12, maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 });
    expect(loadGhThrottleSettings({ file: settings, env: { WE_PLATFORM_PREFERENCES_FILE: toolFile } }).value)
      .toMatchObject({ maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 });
    expect(resolveGhCapDetailed({})).toEqual({ cap: 12, source: 'tool' });
  });
});
