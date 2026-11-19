/**
 * @file scripts/__tests__/fixtures/merge-ai-prs-fixtures.mjs
 * @description Shared commit/PR fixtures for the `merge-ai-prs.test.mjs` split
 *   (scripts/__tests__/merge-ai-prs-*.test.mjs). Extracted here because each is used by describe blocks that
 *   ended up in MORE THAN ONE of the split files — kept in one place rather than duplicated per file.
 */

export const claudeCommit = (extra = {}) => ({ authors: [{ name: 'Nicolas Gilbert', email: 'nic@x.com' }, { name: 'Claude Opus 4.8 (1M context)', email: 'noreply@anthropic.com' }], ...extra });
export const humanCommit = { authors: [{ name: 'Nicolas Gilbert', email: 'nic@x.com' }] };
export const greenRollup = [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'cla', conclusion: 'FAILURE' }];
// body defaults to a non-empty description (#2324) so every pre-existing 'merge' expectation below stays true
// without threading a body through each call; the empty-body gate has its own dedicated tests.
// Valid PRs target main; callers exercise branch guards by overriding baseRefName explicitly.
export const aiPr = (extra = {}) => ({ number: 1, baseRefName: 'main', title: 't', body: 'what changed and why', commits: [claudeCommit(), claudeCommit()], statusCheckRollup: greenRollup, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', ...extra });
