/**
 * @file breaks/empty-fix-round-no-rearm.mjs — LIVE incident, #6713 (2026-11-13): fixer session fix-6713 posted
 * "🔧 conveyor fix — re-armed for re-review … repaired and re-pushed", but the PR head stayed 4288acd6: no commit
 * was pushed and the owed test was never added. The empty round still counted toward the round limit and the PR
 * sat at status:at-round-limit.
 *
 * Fix: `scripts/conveyor/rearm-review.mjs` compares the live PR head with the head the latest trusted `fix-begin`
 * claim recorded; an unchanged head refuses the re-arm BEFORE any label write and posts "no change made — fix
 * still owed" instead.
 *
 * Scenario: a PATH-faked `gh` (logs every argv) reports a PR whose head equals the sha in a trusted `fix-begin`
 * comment, then the real CLI runs `rearm-review.mjs <pr>` in a child process. Invariants: the CLI exits non-zero,
 * posts the no-change comment, and issues NO label write.
 */
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const HEAD = '4288acd6a1b2c3d4e5f60718293a4b5c6d7e8f90';
const COMMENTS = JSON.stringify([[{
  id: 1, node_id: 'IC_1', created_at: '2026-11-13T22:12:33Z', user: { login: 'web-everything' },
  body: `🔒 conveyor fix-begin — fix claim held\n\n**Who:** \`fix-6713\`\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-6713 -->`,
}]]);

export default {
  id: 'empty-fix-round-no-rearm',
  title: 'a fix round that left the PR head unchanged still re-armed review and burned a round (#6713)',
  card: 'we:backlog/xsy1qis',
  fixedBy: { sha: '0a6cea101', where: 'lane/empty-fix-round-no-rearm', paths: ['scripts/conveyor/rearm-review.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/rearm-review.mjs');
    return existsSync(p) && /decideEmptyFixRound/.test(readFileSync(p, 'utf8'));
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-empty-fix-round-'));
    const argvLog = join(dir, 'argv.log');
    writeFileSync(join(dir, 'comments.json'), COMMENTS);
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" | tr '\\n' ' ' >> '${argvLog}'; printf '\\n' >> '${argvLog}'`,
      'case "$*" in',
      `  "api "*) cat '${join(dir, 'comments.json')}' ;;`,
      `  "pr view"*) echo '{"headRefOid":"${HEAD}","labels":[{"name":"review:changes"}],"comments":[],"state":"OPEN","isDraft":false,"number":99}' ;;`,
      '  *) echo "{}" ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/conveyor/rearm-review.mjs'), '99', '--repo=o/r'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const calls = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : [];
    const violations = [];
    if (r.status === 0) violations.push({ invariant: 'rearmed-empty-round', detail: `CLI exited 0 on an unchanged head; stdout=${String(r.stdout).slice(0, 200)}` });
    if (!calls.some((c) => /^pr comment/.test(c))) violations.push({ invariant: 'no-note', detail: 'no "no change made" comment was posted' });
    const writes = calls.filter((c) => /^(pr edit|label|api .*--method (PATCH|POST|PUT|DELETE))/.test(c) || /--add-label|--remove-label/.test(c));
    if (writes.length) violations.push({ invariant: 'label-write', detail: `label/state writes on an empty round: ${writes.join(' | ').slice(0, 300)}` });
    return { violations, calls };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
