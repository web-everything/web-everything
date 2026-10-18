import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { lintBacklogItemRendering } from '../check-standards-rules.mjs';
import { renderWorkerBrief } from '../worker-brief.mjs';
import { buildMandate } from '../lib/review-core.mjs';

import { readTestsFirstPolicy, applyTestsFirstPolicy, redFirstWarning } from '../lib/tests-first-policy.mjs';
afterEach(() => vi.unstubAllEnvs());

const body = '## Acceptance\n\n- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.\n';
const lint = (item, text = body) => lintBacklogItemRendering({ item: { id: 'x123456-test', kind: 'story', status: 'open', ...item }, body: text });
describe('tests-first delivery guarantees', () => {
  it('refuses placeholder acceptance on prepared open cards without requiring a proof claim', () => {
    expect(lint({ preparedDate: '2026-10-17' }).errors.join('\n')).toContain('build.requireExecutableAcceptance');
  });
  it('exempts unprepared and resolved cards', () => {
    expect(lint({}).errors).toEqual([]);
    expect(lint({ preparedDate: '2026-10-17', status: 'resolved' }).errors).toEqual([]);
  });
  it('accepts a prepared card naming a concrete acceptance command', () => {
    expect(lint({ preparedDate: '2026-10-17' }, body.replace('TODO: a command', '`node scripts/probe.mjs`')).errors).toEqual([]);
  });
  it('requires the first builder commit to contain only acceptance tests and reports red then green test names', () => {
    const brief = renderWorkerBrief({ purpose: 'test', files: ['scripts/x.mjs'] });
    expect(brief).toContain('FIRST commit');
    expect(brief).toContain('only new or updated acceptance tests');
    expect(brief).toContain('red-then-green evidence');
  });
  it('maps each stated guarantee to a named test in the review mandate', () => {
    expect(buildMandate()).toContain("each stated guarantee in the card's Acceptance has a named test; list any guarantee without one as a finding");
  });
  it.each(['prepare-item-agent-brief.md', 'prepare-item-worker-brief.md'])('prepare brief %s requires executable acceptance per guarantee', file => {
    expect(readFileSync(`skills-src/conveyor/${file}`, 'utf8')).toContain('one [A<n>] Executable line per stated guarantee');
  });
});

describe('tests-first policy and advisory', () => {
  const resolve = options => readTestsFirstPolicy({ env: {}, read: () => ({}), platform: {}, ...options });
  it('defaults all parts ON and names their sources', () => {
    const policy = resolve();
    expect(policy.value).toEqual({ requireExecutableAcceptance: true, redFirst: true, guaranteesMapToTests: true });
    expect(Object.values(policy.sources)).toEqual(['standard', 'standard', 'standard']);
  });
  it('resolves each leaf independently through platform, tool and environment', () => {
    const policy = resolve({ platform: { requireExecutableAcceptance: false, redFirst: false },
      read: () => ({ build: { redFirst: true, guaranteesMapToTests: false } }),
      env: { WE_BUILD_GUARANTEES_MAP_TO_TESTS: 'true' } });
    expect(policy.value).toEqual({ requireExecutableAcceptance: false, redFirst: true, guaranteesMapToTests: true });
    expect(policy.sources).toEqual({ requireExecutableAcceptance: 'platform', redFirst: 'tool', guaranteesMapToTests: 'env' });
  });
  it('logs each effective setting with its source', () => {
    const log = vi.fn();
    resolve({ env: { WE_POLICY_CASCADE_LOG: '1' }, platform: { redFirst: false }, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('redFirst=false (platform)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('requireExecutableAcceptance=true (standard)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('guaranteesMapToTests=true (standard)'));
  });
  it('ignores malformed overrides and retains enabled defaults', () => {
    expect(resolve({ platform: { redFirst: 'off' }, env: { WE_BUILD_RED_FIRST: 'nonsense' } }).value.redFirst).toBe(true);
  });
  it('disabling acceptance exempts prepared placeholder cards; disabling review removes its mandate', () => {
    vi.stubEnv('WE_BUILD_REQUIRE_EXECUTABLE_ACCEPTANCE', 'false');
    vi.stubEnv('WE_BUILD_GUARANTEES_MAP_TO_TESTS', 'false');
    expect(lint({ preparedDate: '2026-10-17' }).errors).toEqual([]);
    expect(buildMandate()).not.toContain("each stated guarantee in the card's Acceptance has a named test");
  });
  it('renders the live builder brief with red-first instructions and strips them when disabled', () => {
    const template = readFileSync('skills-src/conveyor/delivery-agent-brief.md', 'utf8');
    expect(applyTestsFirstPolicy(template, resolve())).toContain('FIRST commit must contain only new or updated acceptance tests');
    expect(applyTestsFirstPolicy(template, resolve())).toContain('red-then-green evidence with test names');
    expect(applyTestsFirstPolicy(template, resolve({ platform: { redFirst: false } }))).not.toContain('FIRST commit');
  });
  it('removes disabled instructions from worker and dispatch briefs', () => {
    vi.stubEnv('WE_BUILD_RED_FIRST', 'false');
    expect(renderWorkerBrief({ purpose: 'test', files: ['scripts/x.mjs'] })).not.toContain('FIRST commit');
    const text = '<!-- tests-first:redFirst -->\nFIRST commit\n<!-- /tests-first -->';
    expect(applyTestsFirstPolicy(text, resolve())).toContain('build.redFirst=true (standard)');
    expect(applyTestsFirstPolicy(text, resolve({ platform: { redFirst: false } }))).toBe('');
  });
  const git = files => vi.fn(args => args[0] === 'branch' ? 'lane/x123456-build-example'
    : args[0] === 'rev-list' ? 'abcdef123456\nsecond' : files);
  it('warns when the first build commit contains no added or updated tests', () => {
    const probe = git('scripts/feature.mjs');
    expect(redFirstWarning({ git: probe, policy: resolve() })).toContain('adds or updates no tests');
    expect(probe.mock.calls[2][0]).toContain('abcdef123456');
  });
  it('accepts an updated test and skips non-build branches or disabled policy', () => {
    expect(redFirstWarning({ git: git('scripts/x.test.mjs'), policy: resolve() })).toBeNull();
    expect(redFirstWarning({ git: () => 'lane/x123456-prepare-item-test', policy: resolve() })).toBeNull();
    const probe = vi.fn();
    expect(redFirstWarning({ git: probe, policy: resolve({ platform: { redFirst: false } }) })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it('checks a leased builder on local main before the build PR branch is published', () => {
    const probe = git('scripts/feature.mjs');
    probe.mockImplementationOnce(() => 'main');
    expect(redFirstWarning({ git: probe, lease: { purpose: 'conveyor-delivery' }, policy: resolve() }))
      .toContain('adds or updates no tests');
  });
  it('reports unreadable history as unknown', () => {
    expect(redFirstWarning({ git: () => { throw Error('unreadable'); }, policy: resolve() })).toContain('unknown');
  });
});
