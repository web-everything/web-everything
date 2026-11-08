/**
 * @file stall-sweep-informational-refusal.mjs
 * @description Live #6531 replay: the fix daemon's informational `reconcile-refused nothing-owed … phase `queued``
 * line became the PR's wait owner, so the stall sweep raised a false NEEDS-YOU `waiting-refused`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWaitState } from '../../pr-sweep-core.mjs';

export default {
  id: 'stall-sweep-informational-refusal',
  title: 'an informational nothing-owed / draft refusal must not become the PR wait owner, while a real refusal still does',
  card: 'false NEEDS-YOU waiting-refused (#6531, #6529)',
  fixedBy: { sha: 'lane/stall-sweep-informational-refusals', where: 'lane/stall-sweep-informational-refusals', paths: ['scripts/conveyor/pr-sweep-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/pr-sweep-core.mjs'), 'utf8').includes('INFORMATIONAL_REFUSAL_KINDS'); },
  async run({ log } = {}) {
    const now = Date.parse('2026-11-08T05:00:00Z');
    const at = new Date(now - 10 * 60000).toISOString();
    const pr = { number: 6531, headRefOid: 'abc', labels: ['review:accepted'], isDraft: false };
    const line = (kind, tail) => `reconcile-fix-dispatch-daemon: reconcile-refused ${kind} web-everything/web-everything PR #6531 — ${tail}`;
    const wait = (reason) => resolveWaitState(pr, { daemons: [{ kind: 'refusal', at, name: 'fix-dispatch-daemon', reason }] }, { now });
    const informational = wait(line('nothing-owed', 'phase `queued` — reviewed and queued, or already landed; this pass has nothing to dispatch'));
    const real = wait(line('no-lane', 'no free lane'));
    const report = { informational, real }; log?.(JSON.stringify(report)); return report;
  },
  judge(report) {
    const v = [];
    if (report.informational?.kind === 'refused') v.push('[informational-refusal-is-wait-owner] nothing-owed phase `queued` read as a refused wait owner');
    if (report.real?.kind !== 'refused') v.push('[real-refusal-hidden] a no-lane refusal no longer counts as a wait owner');
    return v;
  },
};
