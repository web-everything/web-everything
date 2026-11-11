/**
 * Replay a legacy finished red team whose exact-head seat row holds a confirmed break while the posted comment says
 * "no break found". One sweep pass must plan red-team:blocked (never red-team:clear) and strip a clear label, and a
 * reader that runs BEFORE the publisher's first pass (the status not sealed yet) must hold too.
 * Production modules come from sourceRoot; the seat row and the comments are injected, the status file lives in a
 * temp runs dir so the planner's fresh read of the stored evidence is exercised for real.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'c'.repeat(40);
const PR = 6622;

export default {
  id: 'red-team-stored-break-cleared-by-comment',
  title: 'a stored confirmed break is never planned red-team:clear because a posted comment shows none',
  card: '#6622 — sealed red-team evidence is the single hold authority',
  fixedBy: {
    sha: 'dba185ffa7', where: 'lane/redteam-ran-verdict',
    // Prove it with `red-green.mjs --break=<id> --at-parent` (the sealed-status leaf is new, so it has no parent version).
    paths: ['scripts/lib/red-team-gate.mjs', 'scripts/lib/red-team-withheld-publish.mjs',
      'scripts/lib/red-team-status-labels.mjs', 'scripts/conveyor/advisory-label-sweep.mjs'],
  },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/lib/red-team-gate.mjs'), 'utf8').includes('red-team-sealed-status'); } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-rt-stored-'));
    const saved = process.env.WE_SHARED_RUNS_DIR;
    process.env.WE_SHARED_RUNS_DIR = join(dir, 'runs');
    try {
      const { CONSTELLATION_REPOS: { we: { slug: REPO } } } = await load('scripts/lib/constellation-repos.mjs');
      const { sweepAdvisoryLabels } = await load('scripts/conveyor/advisory-label-sweep.mjs');
      const { redTeamMarker, readRedTeamDisposition } = await load('scripts/lib/red-team-gate.mjs');
      const { publishStoredRedTeamResult } = await load('scripts/lib/red-team-withheld-publish.mjs');
      const statusFile = join(dir, 'red-team-status', `${encodeURIComponent(REPO)}-${PR}-${HEAD}.json`);
      const clear = { author: { login: 'web-everything' }, createdAt: '2026-11-10T12:00:00Z',
        body: `${redTeamMarker(PR, HEAD)}\n### Post-accept red team — no break found` };
      const row = { rev: HEAD, foldedVerdict: 'changes', confirmedMissCount: 1, provider: 'claude', model: 'm', callId: 'c',
        recheckStatus: 'ok', findings: [{ category: 'correctness', file: 'scripts/example.mjs', line: 1,
          summary: 'A confirmed break', impactIfUnfixed: 'broken', confirmedByRecheck: true }] };
      for (const start of ['red-team:pending', 'red-team:clear']) {
        mkdirSync(join(dir, 'red-team-status'), { recursive: true });
        writeFileSync(statusFile, JSON.stringify({ repo: REPO, pr: PR, head: HEAD, status: 'finished', result: 'ran' }));
        let labels = [start];
        const live = () => ({ number: PR, state: 'OPEN', headRefOid: HEAD, labels: labels.map(name => ({ name })), comments: [clear], reviews: [] });
        const provider = { currentRepo: () => REPO, readComments: () => [clear], postComment: () => {}, ensureLabel: () => {},
          setLabels: (_repo, _pr, { add, remove }) => {
            labels = labels.filter(l => !remove.includes(l));
            if (add && !labels.includes(add)) labels.push(add);
          } };
        const read = () => JSON.parse(readFileSync(statusFile, 'utf8'));
        // Live case (#6622 head dc813a2ca): BEFORE the publisher's first pass the status is not sealed yet, and a reader
        // such as the merge gate must still hold on it instead of trusting the posted "no break found" comment.
        check(readRedTeamDisposition({ comments: [clear], pr: PR, head: HEAD, repo: REPO }).held.length >= 1,
          `from ${start}: before the publisher ran, a reader cleared the unsealed stored status on the posted comment`);
        sweepAdvisoryLabels({ repo: REPO, listPrs: () => [live()], readPr: live, provider, log: line => log?.(line),
          listUnpublishedStatuses: () => [read()], readStatusEvidence: () => ({ status: read() }),
          publishStored: input => publishStoredRedTeamResult({ ...input, readSeatRow: () => row, publishNeedsYou: () => {} }) });
        check(!labels.includes('red-team:clear'), `from ${start}: one sweep pass planned red-team:clear for a stored confirmed break`);
        check(labels.includes('red-team:blocked'), `from ${start}: one sweep pass did not plan red-team:blocked`);
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    } finally {
      if (saved === undefined) delete process.env.WE_SHARED_RUNS_DIR; else process.env.WE_SHARED_RUNS_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: r => r.violations,
};
