/**
 * @file breaks/red-team-round-cap-never-rulable.mjs — #5768's operator card path at the round cap.
 * A confirmed cap-held break had no existing-card writer. Replay the production admission/label readers and
 * standalone CLI with injected IO, then repeat reads and reconstruct the thread across a restart. No network.
 * RED: main keeps the break held and blocked, with no CLI to record the operator's existing-card ruling.
 * GREEN: the CLI records the human ruling; red-team admission clears and stays clear across ticks/restart.
 * Other admission gates remain the caller's responsibility; this replay exercises the red-team gate only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CLI = 'scripts/operations/record-red-team-ruling-cli.mjs';
const IO = 'scripts/operations/record-red-team-ruling-io.mjs';

export default {
  id: 'red-team-round-cap-never-rulable',
  title: 'an operator can card a confirmed round-cap break without a new push; admission stays released after restart',
  card: 'PR #5768 round-cap existing-card ruling',
  fixedBy: { sha: 'slices-1-2', where: 'lane/red-team-ruling-cmd-5', paths: [
    'scripts/lib/red-team-gate.mjs', 'scripts/operations/record-red-team-ruling.mjs', IO, CLI,
  ] },
  fixPresent(root) {
    try {
      return existsSync(join(root, CLI)) && existsSync(join(root, IO))
        && readFileSync(join(root, 'scripts/lib/red-team-gate.mjs'), 'utf8').includes("['operator-card', new RegExp");
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [], observations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug;
      const { AUTOMATION_LOGINS, OPERATOR_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
      const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
      const { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, readRedTeamDisposition, redTeamGateMarker } = await load('scripts/lib/red-team-gate.mjs');
      const { redTeamEnqueueHold } = await load('scripts/lib/drain-queue-safety.mjs');
      const { syncRedTeamStatusLabels } = await load('scripts/lib/red-team-status-labels.mjs');
      const pr = 5768, head = 'b'.repeat(40), actor = OPERATOR_LOGINS[0];
      const cardPath = 'backlog/5768-prepare-runs-an-earned-design-review-and-every-design-keeps.md';
      const card = `we:${cardPath}`;
      const bot = body => ({ author: { login: AUTOMATION_LOGINS[0], type: 'Bot' }, createdAt: '2026-10-21T12:00:00Z', body });
      const human = body => ({ author: { login: actor, type: 'User' }, createdAt: '2026-10-21T13:00:00Z', body });
      const result = rev => bot(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
        findings: [{ summary: 'an earned design decision is lost', category: 'edge-case', impactIfUnfixed: 'broken',
          file: 'scripts/conveyor/prepare-item.mjs', line: 24, confirmedByRecheck: true }] }));
      const first = result(head), rid = liveResultGateState([first], pr, head).resultId;
      const cap = bot(`${redTeamGateMarker(pr, head, 'round-cap', rid)}\n**Red-team gate** on head \`${head.slice(0, 12)}\`:\n- 1 confirmed break(s) NOT sent back: round cap (#1).`);
      cap.createdAt = '2026-10-21T12:01:00Z';
      let state = { headRefOid: head, labels: ['accepted', 'ready-to-merge', 'review:changes'], comments: [first, cap] };
      const original = JSON.parse(JSON.stringify(state));
      const tick = (s = state) => {
        const provider = { readPrState: () => s, readComments: () => s.comments, ensureLabel: () => {},
          setLabels: (_repo, _pr, { add, remove }) => { s.labels = s.labels.filter(l => !remove.includes(l)); if (add) s.labels.push(add); } };
        syncRedTeamStatusLabels({ repo, pr, head: s.headRefOid, env: {}, provider, standingRuling: null, savedResult: null });
        const hold = redTeamEnqueueHold({ repo, pr, head: s.headRefOid, comments: s.comments, confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} });
        const d = readRedTeamDisposition({ repo, pr, head: s.headRefOid, comments: s.comments, setting: CONFIRMED_BREAKS_DEFAULTS });
        return { hold, held: d.held.length + d.sendBack.length, blocked: s.labels.includes('red-team:blocked'), clear: s.labels.includes('red-team:clear') };
      };
      const before = tick();
      check(before.hold && before.held === 1 && before.blocked, 'before: the confirmed round-cap break must hold admission and derive blocked');
      observations.push({ phase: 'before', ...before });
      const record = id => `${redTeamGateMarker(pr, head, 'operator-card', id)}\n**Red-team gate** operator ruling:\n- 1 finding(s) carded by the operator to \`${card}\` (#1).`;
      for (const [name, comment] of [['forged author', bot(record(rid))], ['wrong result', human(record('0123456789abcdef'))]]) {
        const trial = { ...original, labels: [...original.labels], comments: [...original.comments, comment] };
        const d = tick(trial);
        check(d.held === 1 && d.hold && d.blocked, `${name}: must never release admission or clear blocked`);
      }
      // Probe the reader independently too: on main even the correctly authored/cited action is unreadable.
      const cited = tick({ ...original, labels: [...original.labels], comments: [...original.comments, human(record(rid))] });
      check(cited.held === 0 && cited.hold === null && cited.clear, 'a human card record bound to this result must release the cap-held break');
      if (!existsSync(join(sourceRoot, CLI)) || !existsSync(join(sourceRoot, IO))) {
        violations.push('the standalone existing-card CLI is missing; the cap-held break has no operator card writer');
      } else {
        const { main } = await load(CLI);
        const { createRecordRedTeamRulingReader, createRecordRedTeamRulingSinks } = await load(IO);
        const { recordRedTeamRulingOperation } = await load('scripts/operations/record-red-team-ruling.mjs');
        const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
        const { createMemoryCallLogStore } = await load('scripts/operations/call-log-store.mjs');
        const readThread = () => JSON.parse(JSON.stringify(state));
        const resolveIdentity = () => ({ login: actor, type: 'User' });
        const reader = createRecordRedTeamRulingReader({ assertFresh: () => {}, readThread, resolveIdentity,
          readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), now: () => '2026-10-21T13:00:00Z',
          resolveCard: requested => ({ requested, ref: card, readable: requested === card && existsSync(join(sourceRoot, cardPath)), reason: 'fixture card on main' }) });
        const sinks = createRecordRedTeamRulingSinks({ readThread, resolveIdentity,
          post: (_repo, _pr, body) => state.comments.push(human(body)), syncLabels: () => tick(), warn: () => {} });
        const code = await main([`--pr=${pr}`, `--repo=${repo}`, '--break=1', '--ruling=card', `--card=${card}`,
          `--actor=${actor}`, '--channel=soak-replay', '--reason=card the confirmed break and release this head'], {
          entry: () => ({ declaration: recordRedTeamRulingOperation({ readRulingContext: reader }), sinks }),
          stores: { store: createMemoryRunStore(), callLog: createMemoryCallLogStore() },
        });
        check(code === 0 && state.comments.length === original.comments.length + 2, 'write-mode CLI must post one release record and the operator reason');
      }
      for (let n = 0; n < 3; n++) {
        if (n === 1) state = JSON.parse(JSON.stringify(state)); // restart: only the persisted thread/labels survive
        const after = tick();
        observations.push({ phase: n === 1 ? 'restart' : `tick-${n}`, ...after });
        check(after.hold === null && after.held === 0 && after.clear && !after.blocked, `tick ${n}: release must persist and red-team admission must allow the ready head`);
      }
      const next = { ...state, headRefOid: 'c'.repeat(40), labels: [...state.labels], comments: [...state.comments, result('c'.repeat(40))] };
      next.comments.at(-1).createdAt = '2026-10-21T14:00:00Z';
      const fresh = tick(next);
      check(fresh.hold && fresh.held === 1 && fresh.blocked && !fresh.clear, 'a fresh confirmed break on a new head must re-hold admission');
      observations.push({ phase: 'new-head', ...fresh });
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations, observations };
  },
  judge: report => report.violations,
};
