/** Active fixer #6770: liveness and infrastructure retries must not hide 180 minutes without progress. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'fixer-live-claim-no-progress-never-reclaimed',
  title: 'an active fixer holding an unmoved claim for 180m with only infrastructure failures emits one no-progress escalation',
  card: 'PR #6770',
  fixedBy: { sha: 'uncommitted', where: 'lane/no-progress-fix-claims', paths: ['scripts/conveyor/session-watchdog.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/session-watchdog.mjs'), 'utf8').includes("const classification = 'no-progress'");
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { runSessionWatchdogPass, summarizeTail } = await import(pathToFileURL(join(root, 'scripts/conveyor/session-watchdog.mjs')).href);
    const nowMs = Date.parse('2026-11-14T23:47:00Z');
    const ago = (minutes) => new Date(nowMs - minutes * 60_000).toISOString();
    const head = 'a'.repeat(40);
    const agent = { name: 'fix-6770', sessionId: 'sid-fix-6770', id: 'f6770001', kind: 'background',
      state: 'working', startedAt: nowMs - 200 * 60_000, pid: 6770, cwd: 'fixture-lane' };
    const claim = { owner: 'fixer:fix-6770', heartbeatAt: ago(1), meta: {
      repo: 'we', pr: 6770, kind: 'fixing', who: agent.name, sessionId: agent.sessionId,
      headSha: head, claimedAt: ago(180),
    } };
    const tail = summarizeTail([
      { kind: 'assistant', ts: ago(2), blocks: [{ kind: 'tool_use', id: 'edit', name: 'Edit', rawInput: { file_path: 'fixture.mjs' } }] },
      { kind: 'user', ts: ago(1), blocks: [{ kind: 'tool_result', toolUseId: 'edit', isError: false, content: '' }] },
    ], { nowMs });
    const written = [];
    const emitted = new Set();
    const options = {
      nowMs, act: true, agents: [agent], processes: [{ pid: agent.pid, command: 'claude' }],
      readTail: () => tail, readHeavy: () => null, completionFor: () => null,
      listClaims: () => [claim], prHeadFor: () => head,
      progressFor: () => ({ known: true, lastCommitMs: nowMs - 190 * 60_000, awaitRecord: null,
        verifyMarker: { status: 'infrastructure-failure', sha: head, startedAt: ago(8), finishedAt: ago(1) } }),
      readLedger: () => ({ emitted: new Set(emitted), acked: new Set() }),
      appendEvent: (event) => { written.push(event); emitted.add(event.key); },
      readRmLedger: () => ({}), writeRmLedger: () => {}, rm: () => {},
      releaseFixing: () => {}, releaseDispatch: () => {},
    };
    const first = runSessionWatchdogPass(options);
    runSessionWatchdogPass(options);
    const violations = [];
    if (first.rows[0]?.class !== 'active-progress') violations.push('fixture holder was not active-progress');
    if (written.length !== 1 || written[0]?.classification !== 'no-progress'
      || written[0]?.reason !== 'no-new-head-or-verdict' || written[0]?.headSha !== head) {
      violations.push('active fixer was never escalated exactly once for no progress on its claimed head');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
