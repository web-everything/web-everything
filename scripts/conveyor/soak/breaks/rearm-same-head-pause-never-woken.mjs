/** Live #6844: `rearm` did nothing for a review:pending PR held by a spent same-head "no verdict" pause. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/operations/operator-controls.mjs';
const input = { repo: CONSTELLATION_REPOS.we.slug, pr: 6844, actor: 'chalbert', channel: 'operator-session', reason: 'wake the paused review', kind: 'fix', n: 1 };

export default {
  id: 'rearm-same-head-pause-never-woken',
  title: 'rearm gives zero effects for a review:pending PR paused by a spent same-head no-verdict hold',
  card: 'live PR #6844 same-head pause; PR lane/rearm-same-head-pause-v2',
  fixedBy: { sha: '03c98f33bd', where: 'lane/rearm-same-head-pause-v2', paths: [PATH] },
  fixPresent(root) {
    try { return /sameHeadHold/.test(readFileSync(join(root, PATH), 'utf8')); } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planOperatorControl } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
    const violations = [];
    const head = 'a'.repeat(40);
    const base = { state: 'OPEN', labels: ['review:pending'], head, comments: [], now: '2026-11-15T11:43:00Z' };
    const cases = [
      ['same-head no-verdict hold on the live head', { sameHeadHold: { kind: 'same-head', head, noVerdict: { exhausted: true } } }, 'apply'],
      ['referral hold is never woken', { sameHeadHold: { kind: 'referral', head } }, 'noop'],
      ['hold on an older head is never woken', { sameHeadHold: { kind: 'same-head', head: 'b'.repeat(40), noVerdict: { exhausted: true } } }, 'noop'],
    ];
    for (const [name, extra, expected] of cases) {
      let plan;
      try { plan = planOperatorControl('rearm', { ...base, ...extra }, input); } catch (error) { plan = { action: `threw: ${error.message}` }; }
      log?.(`${name}: action=${plan.action}, wake=${plan.wake === true}\n`);
      if (plan.action !== expected) violations.push(`${name}: action=${plan.action}, expected=${expected}`);
      if (expected === 'apply' && plan.wake !== true) violations.push(`${name}: no wake comment planned`);
      if (plan.addLabel || /review:accepted/.test(JSON.stringify(plan.steps ?? []))) violations.push(`${name}: the wake must not change labels`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
