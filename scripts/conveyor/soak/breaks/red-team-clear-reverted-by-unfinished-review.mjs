/**
 * A published clean result for the live head lost red-team:clear when the sweep
 * read an abandoned, undecided review as unknown and reverted the label to pending.
 * Replay the production sweep and comment renderer with injected evidence and IO.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SWEEP = 'scripts/conveyor/advisory-label-sweep.mjs';

export default {
  id: 'red-team-clear-reverted-by-unfinished-review',
  title: 'a published clean live-head result keeps red-team:clear despite a quiet unfinished review',
  card: 'HEAD fix: advisory label sweep settles unknown evidence by published result',
  fixedBy: { sha: '3aa359f7d6', where: 'HEAD', paths: [SWEEP] },
  // Always replay: missing modules or exports must fail rather than become expected failures.
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { sweepAdvisoryLabels } = await load(SWEEP);
      const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 42;
      const head = 'a'.repeat(40), old = 'b'.repeat(40);
      const startedAt = Date.parse('2026-10-10T10:00:00Z');
      const result = {
        author: { login: 'web-everything' }, createdAt: '2026-10-10T10:30:00Z',
        body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'soak',
          foldedVerdict: 'accept', findings: [] }),
      };
      const replay = ({ name, comments = [result], active = false, complete = true, blocked = false,
        expected = 'red-team:clear' }) => {
        const writes = [], reads = [], scans = [];
        // The stale snapshot only nominates; settlement must use the live head and thread.
        const listed = { number: pr, headRefOid: old, labels: ['red-team:clear'], comments: [] };
        const live = { ...listed, state: 'OPEN', headRefOid: head, comments };
        const evidence = { ok: false, reason: 'review-unfinished', settleBounds: {
          unfinishedStartedAt: startedAt, unfinishedActiveAt: startedAt,
          evaluatedAt: startedAt + (active ? 30 : 61) * 60_000, unfinishedUndecided: true,
          completeHeadRead: query => { scans.push(query); return { complete, blocked }; },
        } };
        const out = sweepAdvisoryLabels({ repo, listPrs: () => [listed],
          readPr: query => { reads.push(query); return live; },
          readStatusEvidence: query => {
            check(query.repo === repo && query.pr === pr && query.head === head,
              `${name}: evidence was not read for the live head`);
            return evidence;
          },
          listUnpublishedStatuses: () => [],
          publishStored: () => { throw Error('unexpected publication'); },
          provider: {
            ensureLabel: () => {},
            setLabels: (...args) => writes.push(args),
          }, log: () => {},
        });
        check(JSON.stringify(reads) === JSON.stringify([{ repo, number: pr }]), `${name}: missing live PR read`);
        if (expected === 'red-team:clear') {
          check(out.length === 0 && writes.length === 0, `${name}: clean clear result reverted or sweep failed`);
          check(scans.length === 1 && scans[0].pr === pr && scans[0].head === head,
            `${name}: did not verify complete live-head evidence`);
        } else {
          check(JSON.stringify(out) === JSON.stringify([{ num: pr, add: expected, remove: ['red-team:clear'] }]),
            `${name}: unknown evidence failed to retain a pending hold`);
          check(JSON.stringify(writes) === JSON.stringify([[repo, pr, { add: expected, remove: ['red-team:clear'] }]]),
            `${name}: pending hold targeted the wrong PR or labels`);
        }
      };
      replay({ name: 'published clean result after more than one quiet hour' });
      replay({ name: 'active unfinished review stays pending', active: true, expected: 'red-team:pending' });
      replay({ name: 'missing result stays pending', comments: [], expected: 'red-team:pending' });
      replay({ name: 'other-head result stays pending', comments: [{ ...result,
        body: renderRedTeamComment({ pr, rev: old, provider: 'codex', model: 'soak', foldedVerdict: 'accept', findings: [] }) }],
        expected: 'red-team:pending' });
      replay({ name: 'incomplete head read stays pending', complete: false, expected: 'red-team:pending' });
      replay({ name: 'blocking head evidence stays pending', blocked: true, expected: 'red-team:pending' });
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
