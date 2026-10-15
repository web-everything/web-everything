/**
 * @file breaks/codex-prepare-pr-redispatched-as-unstamped.mjs — live 2026-10-14/15: Codex prepared #5028
 * on lane/5028d-prepare-x, titled `WE #5028: prepare — x`. The daemon missed the suffixed branch and
 * re-dispatched the card as unstamped, opening another prepare PR each time.
 *
 * Fix: recognise suffixed prepare PRs and refuse a new prepare while an OPEN prepare PR exists (card 347).
 * The scenario runs the REAL status reader with in-memory git/gh responses, then the REAL live dispatch tick
 * with no surviving claim: the launch guard must independently discover the PR and log its refusal.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';

export default {
  id: 'codex-prepare-pr-redispatched-as-unstamped',
  title: 'Codex suffixed prepare PR is read as unstamped and the same card is dispatched again',
  card: '347',
  fixedBy: { sha: '74aa60e9c', where: 'main', paths: [DAEMON] },
  fixPresent(root) {
    const p = join(root, DAEMON);
    if (!existsSync(p)) return false;
    const source = readFileSync(p, 'utf8');
    return source.includes('isPreparePrFor(p, { num, bornAs })') && source.includes('prepareLaunchRefusal({');
  },
  async run({ log } = {}) {
    const { createPrepareStatusReader, runBuildDispatchTick } = await import(resolve(REPO_ROOT, DAEMON));
    const dir = mkdtempSync(join(tmpdir(), 'soak-codex-prepare-'));
    const previousCache = process.env.WE_PR_SNAPSHOT_DIR;
    const previousError = console.error;
    process.env.WE_PR_SNAPSHOT_DIR = dir;
    const messages = [];
    console.error = (...args) => { messages.push(args.join(' ')); };
    try {
      const card = Buffer.from('---\nstatus: open\n---\nCodex prepare #5028, no stamp yet.\n');
      const sha = createHash('sha1').update(`blob ${card.length}\0`).update(card).digest('hex');
      const pr = { number: 91, state: 'OPEN', headRefName: 'lane/5028d-prepare-x',
        title: 'WE #5028: prepare — x', headRefOid: 'd'.repeat(40),
        createdAt: '2026-10-14T23:00:00Z', isCrossRepository: false };
      const reader = createPrepareStatusReader({ exec(cmd, args) {
        if (cmd === 'git' && args[0] === 'fetch') return '';
        if (cmd === 'git' && args[0] === 'ls-tree') return `100644 blob ${sha}\tbacklog/5028-card.md\n`;
        if (cmd === 'git' && args[0] === 'cat-file') {
          return Buffer.concat([Buffer.from(`${sha} blob ${card.length}\n`), card, Buffer.from('\n')]);
        }
        if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify([pr]);
        if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ content: card.toString('base64') });
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      } });
      const status = reader.read({ num: '5028' });
      const dispatched = [];
      const claims = new Map();
      const tick = await runBuildDispatchTick({ live: true, effects: {
        now: () => Date.parse('2026-10-15T00:00:00Z'),
        planTick: () => ({ decisions: { itemPrepareSpawns: [{ num: '5028' }] }, nextState: {} }),
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
        killSwitch: () => ({ engaged: false }),
        listPrepareInFlight: () => [], listPrepareClaims: () => [...claims.values()],
        listPreparePrs: () => [pr],
        readPreparedStamp: args => reader.stamp(args),
        acquirePrepareClaim: ({ num }) => { claims.set(num, { meta: { num } }); return { ok: true }; },
        releasePrepareClaim: ({ num }) => { claims.delete(num); },
        dispatch: ({ num }) => { dispatched.push(num); return { dispatching: true }; },
      } });
      const report = { status, planned: tick.prepare.planned, launched: tick.prepare.launched,
        refused: tick.prepare.refused ?? [], failures: tick.prepare.failures,
        dispatched, claims: [...claims.keys()], messages };
      log?.(`prepare: ${JSON.stringify(report)}`);
      return report;
    } finally {
      console.error = previousError;
      if (previousCache === undefined) delete process.env.WE_PR_SNAPSHOT_DIR;
      else process.env.WE_PR_SNAPSHOT_DIR = previousCache;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    const problems = [];
    if (report.status.pr?.headRefName !== 'lane/5028d-prepare-x' || report.status.pr?.state !== 'OPEN') {
      problems.push('prepare status reader missed the OPEN Codex suffixed prepare PR');
    }
    if (!report.planned.some(p => p.num === '5028')) problems.push('tick did not offer #5028 to the prepare launch guard');
    if (report.launched.length || report.dispatched.length || report.claims.length) problems.push('tick launched or claimed another prepare of #5028');
    const reason = 'open prepare PR #91 (lane/5028d-prepare-x)';
    if (!report.refused.some(r => r.num === '5028' && r.reason === reason)) problems.push('tick did not refuse #5028 for its open prepare PR');
    if (!report.messages.includes(`build-dispatch-daemon: prepare launch of #5028 refused: ${reason}`)) problems.push('tick did not log the open prepare PR refusal');
    if (report.failures.length) problems.push('tick failed instead of refusing the duplicate prepare');
    return problems;
  },
};
