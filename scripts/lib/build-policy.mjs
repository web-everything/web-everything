/** Shared build safeguards: standard → platform → tool → environment. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';

export function resolveBuildPolicy({ env = process.env, tool, platform, readFile = readFileSync, log } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(join(HERE, '../settings/build.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const bool = v => v === undefined ? undefined : v === 'true' ? true : v === 'false' ? false : v;
  platform ??= platformPreference('build', { env });
  const gate = cascadePolicy('build.finalGate', tool?.finalGate, {
    standard: 'full', platform: platform?.finalGate, env,
    envValues: { '': env.WE_BUILD_FINAL_GATE }, valid: v => ['full', 'related', 'none'].includes(v),
  });
  const selfReview = cascadePolicy('build.selfReview', tool?.selfReview, {
    standard: { enabled: true, maxRounds: 2 }, platform: platform?.selfReview, env,
    envValues: { enabled: bool(env.WE_BUILD_SELF_REVIEW_ENABLED), maxRounds: env.WE_BUILD_SELF_REVIEW_MAX_ROUNDS === undefined ? undefined : Number(env.WE_BUILD_SELF_REVIEW_MAX_ROUNDS) },
    valid: { enabled: v => typeof v === 'boolean', maxRounds: v => Number.isSafeInteger(v) && v >= 0 && v <= 10 },
  });
  const checklist = cascadePolicy('build.reviewerExpectations', tool?.reviewerExpectations, {
    standard: { enabled: true }, platform: platform?.reviewerExpectations, env,
    envValues: { enabled: bool(env.WE_BUILD_REVIEWER_EXPECTATIONS_ENABLED) }, valid: { enabled: v => typeof v === 'boolean' },
  });
  const result = { finalGate: gate.value, selfReview: selfReview.value, reviewerExpectations: checklist.value,
    sources: { finalGate: gate.sources[''], 'selfReview.enabled': selfReview.sources.enabled, 'selfReview.maxRounds': selfReview.sources.maxRounds, 'reviewerExpectations.enabled': checklist.sources.enabled } };
  // Use the common formatter; callers can capture the same line in dispatch receipts.
  const line = formatCascadeSourcesLine('build', { value: result, sources: result.sources });
  if (log) log(line);
  return result;
}

export function renderBuildRequirements({ policy = resolveBuildPolicy(), selfReview = true } = {}) {
  const blocks = [];
  if (policy.finalGate === 'full') blocks.push('You are not done until `node scripts/verify-lane.mjs` is green (the whole unit tier plus standards, through the heavy queue); if a pre-existing test fails because your change altered a default or behaviour, update its callers and tests explicitly, never weaken an assertion.');
  if (policy.reviewerExpectations.enabled) blocks.push(readFileSync(join(HERE, '../../docs/agent/reviewer-expectations.md'), 'utf8').trim());
  if (selfReview && policy.selfReview.enabled) blocks.push(`This configured self-check replaces earlier pre-PR converge/self-review instructions while enabled. After the gate is green and before opening a PR, run one cheap correctness and security self-review on the net diff. Return findings to the same builder for at most ${policy.selfReview.maxRounds} repair rounds. Re-run the gate after edits. Never loop beyond the cap; open the PR with remaining notes in its body. The mechanical wrapper owns this step when present.`);
  return blocks.join('\n\n');
}

/** The one composer every brief uses: appends the requirements once, and never to a brief that already has them. */
export function appendBuildRequirements(text, options) {
  const requirements = renderBuildRequirements(options);
  if (!requirements || String(text).includes(requirements)) return text;
  return `${text}\n\n${requirements}`;
}
