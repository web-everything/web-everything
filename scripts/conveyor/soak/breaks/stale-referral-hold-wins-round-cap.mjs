/** A stale referral hold (older head) won over at-round-limit, so the judge trigger mismatched and the PR parked as "not an object". */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PROBE = `
const [a, b, scenario] = process.argv.slice(1);
const { detectRoundCap } = await import(a); const { AUTOMATION_LOGINS } = await import(b);
const live = 'b'.repeat(40);
const mk = (body, t) => ({ author: { login: AUTOMATION_LOGINS[0] }, createdAt: t, body });
const named = scenario === 'later-verdict' ? live : 'a'.repeat(40);
const comments = [mk('review paused: head ' + named + ' was already reviewed\\n\\nWaiting on your ruling (block, card or not-real):\\n- \`src/a.mjs:5\` — x\\n\\n<!-- review-referral-hold: a1b5166bcd74 -->', '2026-11-19T22:05:00Z')];
if (scenario === 'later-verdict') comments.push(mk('🔁 review — changes requested\\n\\nhead ' + live + '\\n-\`src/a.mjs:5\` — not real', '2026-11-19T23:00:00Z'));
process.stdout.write(JSON.stringify(detectRoundCap({ comments, pr: 14, head: live, state: 'at-round-limit', repo: 'web-everything/web-everything' })));`;

function probe(root, scenario = 'stale-head') {
  const urls = ['scripts/lib/round-judge.mjs', 'scripts/lib/marker-authorship.mjs'].map(p => pathToFileURL(join(root, p)).href);
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, ...urls, scenario], { encoding: 'utf8' }));
}

export default {
  id: 'stale-referral-hold-wins-round-cap',
  title: 'a referral hold naming an older head does not win over at-round-limit',
  card: 'roundcap-stale-hold: detectRoundCap ignores a settled referral hold',
  fixedBy: { sha: 'lane/roundcap-stale-hold', where: 'main' },
  // A DIFFERENT scenario from run(): a later changes-requested for the live head settles the hold. A partial
  // regression of the stale-head rule leaves this true, so run() then fails and the soak test goes red.
  fixPresent(root) { try { return probe(root, 'later-verdict')?.trigger === 'review-cap'; } catch { return false; } },
  async run({ sourceRoot = ROOT } = {}) {
    try {
      const cap = probe(sourceRoot);
      return { violations: cap?.trigger === 'review-cap' ? [] : [`stale hold won: ${JSON.stringify(cap)}`] };
    } catch (error) { return { violations: [error.message] }; }
  },
  judge: report => report.violations,
};
