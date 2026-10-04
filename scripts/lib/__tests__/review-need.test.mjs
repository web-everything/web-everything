import { describe, it, expect } from 'vitest';
import { authorProvidersOfCommit, authorProvidersOfPr, deriveReviewNeed, reviewNeedFor } from '../review-need.mjs';

// Real origin/main messages: 3e4dd9ed4 (Claude), 58593faee (Codex trailer), a52162694 (Written by Codex).
const claude = { messageBody: 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>' };
const codex = { messageBody: 'Co-Authored-By: Codex <noreply@openai.com>' };
const written = { messageBody: 'Written by Codex (codex-direct-task, detached codex-job, no Claude wrapper).' };
const card = ['backlog/4874-example.md'];

describe('#4874 review need', () => {
  it.each([
    [card, 'haiku'], [['docs/guide.md'], 'haiku'], [['src/_data/blocks.json'], 'sonnet'], [['scripts/example.mjs'], 'sonnet'],
    [['scripts/lib/auto-land-seam.mjs'], 'opus'], [['docs/agent/testing.md'], 'opus'],
    [['.github/workflows/ci.yml'], 'opus'], [['config/secrets.json'], 'opus'], [[], 'opus'],
  ])('tiers %j as %s', (changedFiles, tier) => {
    expect(reviewNeedFor({ changedFiles }).tier).toBe(tier);
  });
  it.each([{ risk: 'high' }, { tags: ['security'] }])('honours critical metadata %j', (meta) => {
    expect(reviewNeedFor({ changedFiles: card, ...meta }).tier).toBe('opus');
  });
  it.each(['docs/agent/testing.md', 'AGENTS.md', 'skills-src/example/SKILL.md', 'src/_data/blocks.json', '.github/config.yml', 'config.json'])('only inert prose can be cheap: %s', (file) => {
    expect(reviewNeedFor({ changedFiles: [file] }).tier).not.toBe('haiku');
  });
  it('keeps tools on both mandatory code seats', () => {
    expect(reviewNeedFor({ changedFiles: card }).needsTools).toEqual({ correctness: false, security: false });
    expect(reviewNeedFor({ changedFiles: ['scripts/x.mjs'] }).needsTools).toEqual({ correctness: true, security: true });
  });
  it.each([
    [claude, ['claude']], [codex, ['codex']], [written, ['codex']],
    [{ messageBody: `${claude.messageBody}\n${codex.messageBody}` }, ['claude', 'codex']],
    [{ authors: [{ name: 'Codex' }] }, ['codex']],
    [{ authors: [{ email: 'noreply@openai.com' }] }, ['codex']],
    [{ messageHeadline: codex.messageBody }, ['codex']], [{}, ['unknown']],
  ])('recognizes commit %j', (commit, providers) => expect(authorProvidersOfCommit(commit)).toEqual(providers));
  it('skips merge and drain bookkeeping including GitHub-truncated headlines', () => {
    expect(authorProvidersOfPr([codex,
      { messageHeadline: "Merge branch 'main'" },
      { messageHeadline: 'Merge pull request #3810 from chalbert/lane/example', messageBody: 'PR title' },
      { messageHeadline: 'drain: resolve #2741 on land (#2748)' },
      { messageHeadline: 'drain: rebase lane/example ont…', messageBody: '…o origin/main, drop transient manifest.json' },
    ])).toEqual(['codex']);
    expect(authorProvidersOfPr([])).toEqual([]);
  });
  it.each([[codex], [written]])('Codex alone uses the Claude mandatory seats: %j', (commit) => {
    expect(reviewNeedFor({ changedFiles: card, commits: [commit] }).crossProvider).toMatchObject({ required: null, satisfiedBy: 'claude-mandatory-seats' });
  });
  it.each([[claude], [claude, codex], [{}], null, [], {}, 'bad'].map((commits) => [commits]))('requires Codex for uncertain or Claude authors: %j', (commits) => {
    expect(reviewNeedFor({ changedFiles: card, commits }).crossProvider.required).toBe('codex');
  });
  it.each([null, undefined, {}, 'bad', [], [null], [...card, 3], [' ']].map((files) => [files]))('fails closed on malformed scope %j', (changedFiles) => {
    const need = reviewNeedFor({ changedFiles, commits: [codex] });
    expect(need.tier).toBe('opus');
    expect(need.crossProvider.required).toBe('codex');
  });
  it('marks missing authors unknown', () => {
    expect(reviewNeedFor({ changedFiles: card, commits: null }).authorsKnown).toBe(false);
  });
  it.each([{ humanRequired: true }, { reasons: ['gate-derivation:test'] }])('honours independent opus triggers %j', (override) => {
    const need = deriveReviewNeed({ shapePlan: { subject: 'prose', careLevel: 'none', reasons: [], ...override }, critical: { critical: false } });
    expect(need.tier).toBe('opus');
  });
});
