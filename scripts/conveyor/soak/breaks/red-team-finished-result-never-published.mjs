/**
 * Replay a finished red team whose result comment was withheld or failed to post.
 * Production modules come from sourceRoot; all command and state IO is injected.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'b'.repeat(40);
const PR = 5759;

export default {
  id: 'red-team-finished-result-never-published',
  title: 'a finished red-team result is published or escalated once and leaves pending',
  card: '#5759 / #5762 — finished red-team publication recovery',
  fixedBy: {
    sha: 'HEAD', where: 'lane/redteam-publish-withheld',
    paths: ['scripts/lib/red-team-withheld-publish.mjs', 'scripts/conveyor/advisory-label-sweep.mjs',
      'scripts/lib/red-team-status-labels.mjs', 'scripts/lib/drain-red-team-evidence.mjs'],
  },
  fixPresent(root) {
    try {
      return existsSync(join(root, 'scripts/lib/red-team-withheld-publish.mjs'))
        && readFileSync(join(root, 'scripts/conveyor/advisory-label-sweep.mjs'), 'utf8')
          .includes('red-team-withheld-publish.mjs');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    try {
      const { CONSTELLATION_REPOS: { we: { slug: REPO } } } = await load('scripts/lib/constellation-repos.mjs');
      const { sweepAdvisoryLabels } = await load('scripts/conveyor/advisory-label-sweep.mjs');
      const { redTeamMarker } = await load('scripts/lib/red-team-gate.mjs');
      // Load lazily through the injected publisher: a pre-fix sweep still runs
      // and exposes the missing comment/label recovery even without this module.
      let publishStoredRedTeamResult;
      if (existsSync(join(sourceRoot, 'scripts/lib/red-team-withheld-publish.mjs'))) {
        ({ publishStoredRedTeamResult } = await load('scripts/lib/red-team-withheld-publish.mjs'));
      }
      for (const comment of ['withheld', 'error']) {
        for (const failPosts of [false, true]) {
          const mode = `${comment}, ${failPosts ? 'failed posts' : 'successful post'}`;
          let stored = { repo: REPO, pr: PR, head: HEAD, status: 'finished',
            result: { status: 'ran', comment, foldedVerdict: 'changes', confirmedMissCount: 1,
              findings: [{ category: 'correctness', file: 'scripts/example.mjs', line: 1,
                summary: 'A confirmed finding', confirmed: true }] } };
          let labels = ['red-team:pending'];
          const comments = [], posts = [], notes = [];
          const live = () => ({ number: PR, state: 'OPEN', headRefOid: HEAD,
            labels: [...labels], comments: [...comments] });
          const provider = {
            currentRepo: () => REPO,
            readComments: () => [...comments],
            postComment: (repo, pr, body) => {
              posts.push({ repo, pr, body });
              if (failPosts) throw Error('injected post failure');
              comments.push({ author: { login: 'web-everything' }, body });
            },
            ensureLabel: () => {},
            setLabels: (_repo, _pr, { add, remove }) => {
              labels = labels.filter(label => !remove.includes(label));
              if (add && !labels.includes(add)) labels.push(add);
            },
          };
          const sweep = () => sweepAdvisoryLabels({
            repo: REPO, listPrs: () => [live()], readPr: live, provider,
            listUnpublishedStatuses: () => [structuredClone(stored)],
            readStatusEvidence: () => ({ status: structuredClone(stored), scheduled: true,
              recorded: true, inFlight: false, queued: false }),
            publishStored: input => publishStoredRedTeamResult({ ...input,
              statusDir: '/injected/red-team-status', withLock: (_path, fn) => fn(),
              readStatus: () => structuredClone(stored),
              writeStatus: next => { stored = structuredClone(next); },
              publishNeedsYou: item => notes.push(item), now: () => '2026-10-24T16:00:00.000Z',
            }),
            log: line => log?.(line),
          });
          sweep();
          check(!labels.includes('red-team:pending'), `${mode}: finished result still labelled red-team:pending`);
          if (!failPosts) {
            check(comments.some(c => c.body.includes(redTeamMarker(PR, HEAD))),
              `${mode}: no head-bound marker comment was posted`);
          } else {
            check(notes.length === 0, `${mode}: escalated before two failed posts`);
            sweep();
            sweep(); // Later ticks must neither retry beyond the bound nor repeat the escalation.
            check(posts.length === 2, `${mode}: expected two failed posts, observed ${posts.length}`);
            check(notes.length === 1 && notes[0].kind === 'red-team-publish-failed'
              && notes[0].repo === REPO && notes[0].pr === PR && notes[0].head === HEAD,
            `${mode}: two failed posts did not emit exactly one head-bound needs-you event`);
            check(!labels.includes('red-team:pending'), `${mode}: later sweep restored red-team:pending`);
          }
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: r => r.violations,
};
