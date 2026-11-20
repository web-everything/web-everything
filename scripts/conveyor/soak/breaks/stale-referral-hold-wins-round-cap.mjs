/** A stale referral hold (older head) won over at-round-limit, so the judge trigger mismatched and the PR parked as "not an object". */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PROBE = `
const [a, b] = process.argv.slice(1);
const { detectRoundCap } = await import(a); const { AUTOMATION_LOGINS } = await import(b);
const comments = [{ author: { login: AUTOMATION_LOGINS[0] }, createdAt: '2026-11-19T22:05:00Z',
  body: 'review paused: head ' + 'a'.repeat(40) + ' was already reviewed\\n\\nWaiting on your ruling (block, card or not-real):\\n- \`src/a.mjs:5\` — x\\n\\n<!-- review-referral-hold: a1b5166bcd74 -->' }];
const cap = detectRoundCap({ comments, pr: 14, head: 'b'.repeat(40), state: 'at-round-limit', repo: 'web-everything/web-everything' });
process.stdout.write(JSON.stringify(cap));`;

function probe(root) {
  const urls = ['scripts/lib/round-judge.mjs', 'scripts/lib/marker-authorship.mjs'].map(p => pathToFileURL(join(root, p)).href);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, ...urls], { encoding: 'utf8' });
  return JSON.parse(out);
}

export default {
  id: 'stale-referral-hold-wins-round-cap',
  title: 'a referral hold naming an older head does not win over at-round-limit',
  card: 'roundcap-stale-hold: detectRoundCap ignores a settled referral hold',
  fixedBy: { sha: 'lane/roundcap-stale-hold', where: 'main' },
  // Behaviour, not markers: the fix is present when the stale hold no longer wins.
  fixPresent(root) { try { return probe(root)?.trigger === 'review-cap'; } catch { return false; } },
  async run({ sourceRoot = ROOT } = {}) {
    try {
      const cap = probe(sourceRoot);
      return { violations: cap?.trigger === 'review-cap' ? [] : [`stale hold won: ${JSON.stringify(cap)}`] };
    } catch (error) { return { violations: [error.message] }; }
  },
  judge: report => report.violations,
};
