import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RED_TEAM_SETTINGS_FILE, readRedTeamProbes } from '../red-team-gate.mjs';
import { redTeamOwedOnHead, redTeamPanelSeatOwed } from '../review-red-team-policy.mjs';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const card = { netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] };
const code = { netChangedFiles: ['scripts/a.mjs'] };

describe('panel-seat card-only policy', () => {
  let root, env, actualRead;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'panel-seat-policy-'));
    const platformPath = join(root, 'platform.json');
    writeFileSync(platformPath, JSON.stringify({}));
    env = { WE_RED_TEAM_TIMING: 'panel-seat', WE_PLATFORM_PREFERENCES_FILE: platformPath };
    actualRead = vi.mocked(readFileSync).getMockImplementation();
    // Exercise the real cascade, isolating its optional layers from operator preferences.
    vi.mocked(readFileSync).mockImplementation((path, ...args) => path === RED_TEAM_SETTINGS_FILE
      ? JSON.stringify({ redTeam: {} }) : actualRead(path, ...args));
  });
  afterEach(() => {
    vi.mocked(readFileSync).mockImplementation(actualRead);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'pinned card-only head is exempt by default', read: card, setting: undefined, owed: false },
    { name: 'pinned card-only head is exempt when skipCardOnly is enabled', read: card, setting: 'true', owed: false },
    { name: 'pinned card-only head remains owed when skipCardOnly is disabled', read: card, setting: 'false', owed: true },
    { name: 'pinned code head remains owed by default', read: code, setting: undefined, owed: true },
    { name: 'pinned code head remains owed when skipCardOnly is enabled', read: code, setting: 'true', owed: true },
    { name: 'pinned code head remains owed when skipCardOnly is disabled', read: code, setting: 'false', owed: true },
  ])('$name', ({ read, setting, owed }) => {
    if (setting !== undefined) env.WE_RED_TEAM_SKIP_CARD_ONLY = setting;
    expect(readRedTeamProbes({ env })).toMatchObject({ value: { skipCardOnly: setting !== 'false' },
      sources: { skipCardOnly: setting === undefined ? 'standard' : 'env' } });
    const payload = { findings: { read: { ...read, netBasis: { rev: 'a'.repeat(40) } } } };
    expect(redTeamPanelSeatOwed(payload, env)).toBe(owed);
  });
});

describe('redTeamOwedOnHead attempt evidence', () => {
  it.each([
    [card, { attempted: true }, true, false],
    [card, { attempted: true, scheduled: true }, true, false],
    [card, { attempted: true, inFlight: true }, true, true],
    [card, { attempted: true, recorded: true }, true, true],
    [card, { attempted: true }, false, true],
    [card, { attempted: true, skipCardOnly: false }, true, true],
    [card, { attempted: true, skipCardOnly: true }, false, false],
    [code, { attempted: true, scheduled: false }, true, true],
    [null, { attempted: true }, true, true],
    [code, { scheduled: true }, true, true],
    [code, {}, true, false],
  ])('read %j evidence %j skip %s owes %s', (read, evidence, skipCardOnly, owed) => {
    expect(redTeamOwedOnHead({ read, evidence, skipCardOnly })).toBe(owed);
  });
});
