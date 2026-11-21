/** Draft promotion must preserve an operator park until a later explicit release. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const RULE = 'scripts/conveyor/draft-promotion-rule.mjs';

export function exercise(isDraftOwedPromotion) {
  const violations = [];
  const head = 'a'.repeat(40);
  const pr = { number: 7101, state: 'OPEN', headRefName: 'lane/operator-park', headRefOid: head,
    isDraft: true, labels: [], comments: [{ author: { login: 'web-everything' }, body: '<!-- operator-park -->\nOperator converted this open PR to draft.' }] };
  const checks = { state: 'green', sha: head };
  const parked = isDraftOwedPromotion({ pr, checks });
  if (parked.owed !== false || parked.reason !== 'operator-parked') violations.push('operator-parked draft was not refused');
  const released = isDraftOwedPromotion({ pr: { ...pr, comments: [...pr.comments, { author: { login: 'web-everything' }, body: '<!-- operator-park-release -->' }] }, checks });
  if (released.owed !== true) violations.push('released draft was not owed promotion');
  const ordinary = isDraftOwedPromotion({ pr: { ...pr, comments: [{ body: 'Please park this later.' }] }, checks });
  if (ordinary.owed !== true) violations.push('prose mentioning park blocked promotion');
  return { violations };
}

export default {
  id: 'promoter-ignores-operator-park',
  title: 'draft promoter preserves operator parks until explicit release',
  card: 'promoter-ignores-operator-park',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [RULE] },
  fixPresent(root) {
    const probe = `import { exercise } from ${JSON.stringify(import.meta.url)};
      import { isDraftOwedPromotion } from ${JSON.stringify(pathToFileURL(join(root, RULE)).href)};
      process.stdout.write(JSON.stringify(exercise(isDraftOwedPromotion)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    try { return r.status === 0 && JSON.parse(r.stdout).violations.length === 0; } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { isDraftOwedPromotion } = await import(pathToFileURL(join(sourceRoot, RULE)).href);
    return exercise(isDraftOwedPromotion);
  },
  judge: report => report.violations,
};
