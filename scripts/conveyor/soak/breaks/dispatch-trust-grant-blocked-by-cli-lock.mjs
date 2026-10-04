/** PR #3850 (2026-10-04): the dispatch trust grant locked on Claude Code's own `~/.claude.json.lock` dir and was silently skipped. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'dispatch-trust-grant-blocked-by-cli-lock',
  title: 'PR #3850: while the CLI held its ~/.claude.json.lock directory, the dispatch trust grant timed out and every fresh scratch cwd was refused "Workspace not trusted"',
  card: 'conveyor gap A — dispatch trust (PR #3850, 151 refusals)',
  fixedBy: { sha: 'b35bec432', where: 'lane/dispatch-trust-parent', paths: ['scripts/operations/dispatch-lane-io.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('export function dispatchTrustLockPath'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { grantDispatchTrust } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane-io.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-trust-'));
    const violations = [];
    try {
      const trustFile = join(dir, 'claude.json');
      const scratchRoot = join(dir, 'dispatch');
      writeFileSync(trustFile, JSON.stringify({ projects: {} }));
      mkdirSync(`${trustFile}.lock`); // the CLI's own config lock, held
      grantDispatchTrust(join(scratchRoot, '3e7c5b54'), { trustPath: trustFile, env: {}, scratchRoot });
      const projects = JSON.parse(readFileSync(trustFile, 'utf8')).projects ?? {};
      const trusted = Object.keys(projects).some((k) => projects[k]?.hasTrustDialogAccepted === true
        && (join(scratchRoot, '3e7c5b54') === k || join(scratchRoot, '3e7c5b54').startsWith(`${k}/`)));
      if (!trusted) violations.push(`scratch cwd left untrusted while the CLI lock dir existed: ${JSON.stringify(projects)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
