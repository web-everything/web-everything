/**
 * R618: merged/closed PRs kept their owed resumes ahead of a live waiter forever.
 * Replay the real slot-aware pass with the injected ports from stale-owed-resumes.test.mjs.
 * Eight stale waits (busy sessions) precede a live wait; cap 8 minus 2 working claims
 * leaves six admissions. Before cleanup the same stale waits take those six every pass.
 * With cleanup all eight disappear and the live session wakes exactly once.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const LOOP = 'scripts/conveyor/await-verify-loop.mjs';
const T0 = Date.parse('2026-10-08T19:30:00Z');

export default {
  id: 'stale-owed-resumes-starve-live',
  title: 'merged and closed PR owed resumes are cleared before admitting a live waiter at cap 8 with 2 working',
  card: 'R618 — stale owed resumes',
  fixedBy: { sha: 'R618', where: 'HEAD', paths: [LOOP, 'scripts/conveyor/fixer-slot-rules.mjs'] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, LOOP), 'utf8').includes('classifyStaleOwed({ owed: allOwed');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { runSlotAwareAwaitPass } = await load(LOOP);
      const { runAwaitVerifyPass } = await load('scripts/conveyor/await-verify-pass.mjs');
      const entries = Array.from({ length: 9 }, (_, i) => {
        const key = i === 8 ? 'r618-live' : `r618-stale-${i}`;
        return { key, record: {
          v: 1, sessionId: key, who: key, repo: 'we', pr: i + 1,
          sha: 'a'.repeat(40), kind: 'fix', requestedAt: new Date(T0 + i * 1000).toISOString(),
          lane: join(sourceRoot, 'soak', 'lanes', key), ref: `lane/${key}`, attempt: 1, pendingResume: { kind: 'green' },
        } };
      });
      const staleKeys = entries.slice(0, 8).map(e => e.key);
      const store = new Map(entries.map(e => [e.key, e.record]));
      const resumed = [];
      const cleaned = [];
      const io = {
        listRecords: () => [...store].map(([key, record]) => ({ key, record })),
        clearRecord: key => { store.delete(key); },
        clearStoredRecordIf: (key, expected) => {
          if (!isDeepStrictEqual(store.get(key), expected)) return { cleared: false };
          store.delete(key); cleaned.push(key); return { cleared: true };
        },
        writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
        listSessions: () => entries.map(({ key }) => ({ sessionId: key, name: key,
          status: key === 'r618-live' ? 'idle' : 'working', kind: 'background' })),
        resume: ({ session }) => { resumed.push(session.sessionId); return { resumed: true }; },
        prState: (_repo, pr) => pr === 9 ? { open: true }
          : { open: false, state: pr % 2 ? 'MERGED' : 'CLOSED' },
      };
      const claims = [100, 101].map(pr => ({ meta: { repo: 'we', pr, kind: 'fix', sessionId: `working-${pr}` } }));
      for (let tick = 0; tick < 3; tick++) {
        const out = await runSlotAwareAwaitPass({ io, runPass: runAwaitVerifyPass,
          allowResume: true, settings: { parkedReleasesSlot: true }, claims,
          nowMs: T0 + 60_000 + tick * 1000, ttlMs: 3_600_000, cap: 8 });
        check(isDeepStrictEqual(out.cleared, tick === 0 ? staleKeys : []),
          `tick ${tick}: stale merged/closed waits must be cleared before admission`);
        check(isDeepStrictEqual(out.admitted, tick === 0 ? ['r618-live'] : []),
          `tick ${tick}: only the live waiter may be admitted, once`);
        check(isDeepStrictEqual(out.deferred, []), `tick ${tick}: live waiter must not remain deferred`);
        check(store.size === 0, `tick ${tick}: stale waits and the resumed live wait must leave the store`);
      }
      check(isDeepStrictEqual(cleaned, staleKeys), 'all eight stale waits must use conditional cleanup');
      check(isDeepStrictEqual(resumed, ['r618-live']), 'only the live session must resume, exactly once');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
