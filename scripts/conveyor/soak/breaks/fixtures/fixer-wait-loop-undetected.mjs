/**
 * @file breaks/fixtures/fixer-wait-loop-undetected.mjs — the child-process half of the
 * `fixer-wait-loop-undetected` break. Replays fix-3771's recorded transcript (11 `verify-lane check --wait=540000`
 * waits, 2026-10-04) at the 09:20 ET manual check through every detector the tree under test has, and prints one
 * JSON line: `{hung, episodes, detected}`.
 *
 * argv: <repoRoot> <tmpDir>. The caller sets `CLAUDE_PROJECTS_DIR` and `OPERATION_COMPLETIONS_DIR` to `tmpDir`
 * paths, so nothing on the real host is read or written.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, tmp] = process.argv.slice(2);
const mod = (rel) => import(pathToFileURL(join(root, rel)).href);

const NOW = Date.parse('2026-10-04T13:20:00Z');
const SID = 'f29aeb29-30cc-40eb-b82f-e711f974b24f';
const CWD = '/Users/operator/workspace/.operations/dispatch/74b1cbbf';
const agent = { id: 'f29aeb29', name: 'fix-3771', kind: 'background', state: 'working', startedAt: Date.parse('2026-10-04T11:53:10.915Z'), cwd: CWD, sessionId: SID, pid: 2009 };
const HEAD = '75b8199a815e7fa4b264b1dc222572c20ed31c7c';

const projectDir = join(process.env.CLAUDE_PROJECTS_DIR, CWD.replaceAll('/', '-'));
mkdirSync(projectDir, { recursive: true });
copyFileSync(join(root, 'scripts/conveyor/soak/breaks/fixtures/fix-3771-wait-loop.jsonl'), join(projectDir, `${SID}.jsonl`));
const files = {
  agents: join(tmp, 'agents.json'), claims: join(tmp, 'claims.json'), heads: join(tmp, 'heads.json'),
};
writeFileSync(files.agents, JSON.stringify([agent]));
writeFileSync(files.claims, JSON.stringify([{ owner: 'fixer:fix-3771', meta: { repo: 'we', pr: 3771, kind: 'fixing', who: 'fix-3771', sessionId: SID, headSha: HEAD, claimedAt: '2026-10-04T11:53:20.000Z' } }]));
writeFileSync(files.heads, JSON.stringify({ 'we#3771': HEAD }));

// The detector every tree has: the hung-transcript axis the reaper and the reconcile pass both consume.
const { readHungInfo, resolveHungThresholdMs } = await mod('scripts/conveyor/hung-session.mjs');
const hung = readHungInfo(agent, NOW, resolveHungThresholdMs({}));

// Every health smell the tree has, fed by every session probe the health watch exposes.
const hw = await mod('scripts/conveyor/health-watch.mjs');
const { SMELLS } = await mod('scripts/conveyor/health-smells/index.mjs');
const { runHealthTick, emptyHealthState } = await mod('scripts/conveyor/health-watch-core.mjs');
const probes = { processes: [{ pid: 2009, command: 'claude --bg fix-3771' }] };
if (typeof hw.probeSessionWatchdog === 'function') {
  probes.sessionWatchdog = hw.probeSessionWatchdog({
    dir: tmp, now: NOW, processes: probes.processes,
    flags: { 'watchdog-agents-fixture': files.agents, 'watchdog-claims-fixture': files.claims, 'watchdog-heads-fixture': files.heads },
  });
}
const { state } = runHealthTick(emptyHealthState(), probes, SMELLS, NOW);
const episodes = Object.values(state.episodes).filter((e) => e.status !== 'pending' && /3771/.test(String(e.subject)))
  .map((e) => ({ smell: e.smell, subject: e.subject, summary: e.summary }));
process.stdout.write(`${JSON.stringify({ hung, episodes, detected: hung.hung === true || episodes.length > 0 })}\n`);
