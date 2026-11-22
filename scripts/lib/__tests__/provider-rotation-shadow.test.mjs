import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendScorecard } from '../../conveyor/run-scorecard-store.mjs';
import { appendRotationShadow } from '../provider-rotation-shadow.mjs';
import { drawArm, composePanel, routeFor } from '../provider-rotation.mjs';

const policy = JSON.parse(readFileSync('scripts/settings/provider-rotation.json', 'utf8')).providerRotation;
const capacity = Object.fromEntries(['codex', 'claude', 'agy-gemini'].map(p => [p,
  { available: true, usedPct: 20, hoursToReset: 4, manualResetsHeld: 0 }]));
const builders = [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { provider: 'agy-gemini', model: 'gemini-4-carbon', effort: 'high' }];
const family = provider => ({ codex: 'openai', claude: 'anthropic', 'agy-gemini': 'google' })[provider];
const row = (dispatchKind = 'build') => ({ rubricVersion: 'test', provider: 'codex', model: 'gpt-6.1-sol',
  effort: 'high', dispatchKind, repo: 'org/repo', pr: 42, item: '17', handle: `run-${dispatchKind}`,
  subjectClass: 'work-agent', criteriaEvaluated: 1, score: 100, deductions: [], scoredAt: '2026-11-22T00:00:00Z' });
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rotation-shadow-')); dirs.push(dir);
  let stored = '{"version":1,"records":[]}';
  return { path: join(dir, 'run-scorecards.json'), read: () => stored, exists: () => true,
    write: (_path, text) => { stored = text; }, bytes: () => stored,
    rotationShadow: { policy, capacity } };
}

describe('provider rotation shadow', () => {
  it('shadow never changes the actual provider and cross-vendor holds for every pick', () => {
    const off = fixture(), on = fixture(); off.rotationShadow = { policy: { ...policy, mode: 'off' }, capacity };
    const input = row(); const before = JSON.stringify(input);
    expect(appendScorecard(input, on)).toEqual(appendScorecard(input, off));
    expect(on.bytes()).toBe(off.bytes()); expect(JSON.stringify(input)).toBe(before);
    for (const p of [undefined, null, {}, { mode: 'shadow' }, policy, { ...policy, kinds: null }]) {
      expect(routeFor({ kind: 'build', subject: 'org/repo#42', policy: p, capacity, legacyRoute: input }).route).toBe(input);
    }
    let picked = 0, panels = 0;
    for (const builder of builders) for (const lens of ['correctness', 'security', 'red-team']) for (let i = 0; i < 100; i++) {
      const kind = lens === 'red-team' ? lens : `review-${lens}`;
      const args = { policy, capacity, subject: `org/repo#${i}`, builder };
      const result = drawArm({ ...args, kind });
      expect(result.arm).not.toBeNull(); picked++;
      expect(family(result.arm.provider)).not.toBe(family(builder.provider));
      const panel = composePanel({ ...args, shape: 'normal', seats: [{ lens, counting: true }, { lens: 'style', counting: true }] });
      // Some builder families cannot yield two independent counting families before Carbon promotion.
      if (panel.ok) { panels++; expect(family(panel.panel[0].arm.provider)).not.toBe(family(builder.provider)); }
      else expect(panel.panel).toEqual([]);
      const refused = drawArm({ ...args, kind, capacity: { [builder.provider]: capacity[builder.provider] } });
      expect(refused.arm).toBeNull(); expect(refused.refusal).toBeTruthy();
    }
    expect(picked).toBe(900); expect(panels).toBeGreaterThan(0);
  });
  it('appends one sidecar row for every agentic dispatch kind without changing scorecards', () => {
    const io = fixture();
    for (const kind of ['build', 'fix', 'ci-heal', 'review-seat', 'review', 'red-team', 'audit', 'judge', 'advisory-review', 'prepare', 'probation-launch'])
      appendScorecard({ ...row(kind), builderProvider: 'codex', lens: kind === 'review-seat' ? 'security' : undefined }, io);
    const lines = readFileSync(join(dirs[0], 'rotation-shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(11);
    expect(new Set(lines.map(l => l.dispatchKind)).size).toBe(11);
    for (const line of lines) { expect(line.subject).toBe('org/repo#42'); expect(line.actual.provider).toBe('codex'); expect(line.mode).toBe('shadow'); }
    expect(lines.find(l => l.dispatchKind === 'review-seat').crossVendor).toMatchObject({ required: true, builderFamily: 'openai', ok: true });
  });
  it('unreadable policy, thrown draw and failed sidecar append leave append results unchanged', () => {
    const baseline = fixture(); baseline.rotationShadow = { policy: { ...policy, mode: 'off' }, capacity };
    const expected = appendScorecard(row(), baseline);
    for (const failure of [{ readPolicy: () => { throw new Error('unreadable-policy'); } },
      { draw: () => { throw new Error('thrown-draw'); } }, { append: () => { throw new Error('disk-full'); } }]) {
      const io = fixture(); io.rotationShadow = { policy, capacity, ...failure };
      if (failure.readPolicy) delete io.rotationShadow.policy;
      expect(appendScorecard(row(), io)).toEqual(expected); expect(io.bytes()).toBe(baseline.bytes());
      if (!failure.append) {
        const line = JSON.parse(readFileSync(join(io.path, '..', 'rotation-shadow.jsonl'), 'utf8'));
        expect(line.shadowPick).toBeNull(); expect(line.refusal).toMatch(/unreadable-policy|thrown-draw/);
      }
    }
    expect(() => appendRotationShadow(row(), { storePath: baseline.path, policy, capacity, append: () => { throw new Error('full'); } })).not.toThrow();
  });
  it('real policy reads fail closed on missing, malformed, oversized and invalid files', () => {
    for (const content of [undefined, '{broken', ' '.repeat(256 * 1024 + 1), '{}', '{"providerRotation":{"mode":"shadow"}}']) {
      const io = fixture(); const policyPath = join(io.path, '..', 'policy.json');
      const platformPath = join(io.path, '..', 'platform.json'); writeFileSync(platformPath, '{}');
      if (content !== undefined) writeFileSync(policyPath, content);
      io.rotationShadow = { policyPath, env: { WE_PLATFORM_PREFERENCES_FILE: platformPath }, capacity };
      const stored = appendScorecard(row(), io);
      expect(stored.provider).toBe('codex');
      const record = JSON.parse(readFileSync(join(io.path, '..', 'rotation-shadow.jsonl'), 'utf8'));
      expect(record.shadowPick).toBeNull(); expect(record.refusal).toBeTruthy();
      if (content?.length > 256 * 1024) expect(record.refusal).toContain('operator must repair policy');
    }
  });
  it('reads the shadow policy through the cascade and observes live capacity without rereading scorecards', () => {
    const io = fixture(), policyPath = join(io.path, '..', 'policy.json'), platformPath = join(io.path, '..', 'platform.json');
    writeFileSync(policyPath, JSON.stringify({ providerRotation: policy })); writeFileSync(platformPath, '{}');
    const now = Date.parse('2026-11-22T00:00:00Z'); let observations = 0;
    io.rotationShadow = { policyPath, env: { WE_PLATFORM_PREFERENCES_FILE: platformPath }, now,
      routing: () => ({ capacity: {} }), observe: ({ records }) => {
        observations++; expect(records).toHaveLength(1);
        return [{ provider: 'codex', known: true, health: 1, tier: 10, active: true, held: false,
          windowModel: 'fixed', windows: [{ usedPercent: 20, resetsAt: now + 3600000, lengthHours: 4 }] }];
      } };
    appendScorecard(row(), io);
    const record = JSON.parse(readFileSync(join(io.path, '..', 'rotation-shadow.jsonl'), 'utf8'));
    expect(observations).toBe(1); expect(record.refusal).toBeNull(); expect(record.shadowPick.provider).toBe('codex');
  });
  it('keeps go-live inactive and refuses on-mode logging without changing dispatches', () => {
    expect(policy.goLive).toEqual({ subjectKey: 'same PR (repo#pr) or card always the same provider',
      sharesFollow: 'projected capacity', afterRunsPerKind: 30, winnerWithinPoints: 5,
      winnerShare: 60, otherMinShare: 10, shadowCleanHours: 24, active: false });
    const io = fixture(); io.rotationShadow.policy = { ...policy, mode: 'on', goLive: { active: true } };
    expect(appendScorecard(row(), io).provider).toBe('codex');
    const record = JSON.parse(readFileSync(join(io.path, '..', 'rotation-shadow.jsonl'), 'utf8'));
    expect(record).toMatchObject({ shadowPick: null, refusal: 'shadow-only: unsupported-mode' });
    expect(drawArm({ kind: 'build', subject: 'repo#42', capacity, policy })).toEqual(
      drawArm({ kind: 'build', subject: 'repo#42', capacity, policy: { ...policy, goLive: { active: true } } }));
  });
  it('refuses missing or inconsistent builder identity for key seats', () => {
    for (const fields of [{}, { builderProvider: 'codex', builderFamily: 'anthropic' },
      { builder: { provider: 'codex', model: 'claude-sonnet-5-5' }, builderFamily: 'openai' }]) {
      const io = fixture(); const stored = appendScorecard({ ...row('review-security'), ...fields }, io);
      expect(stored.provider).toBe('codex');
      const record = JSON.parse(readFileSync(join(io.path, '..', 'rotation-shadow.jsonl'), 'utf8'));
      expect(record).toMatchObject({ shadowPick: null, crossVendor: { required: true, ok: false } });
      expect(record.refusal).toMatch(/builder-family/);
    }
  });
});
