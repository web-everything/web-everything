/**
 * @file agy-juror-shared-checkout-reset.mjs — PR #5260, card 84. In a live trial, 19 of 88 agy review seats
 * voided when the review daemon reset its shared checkout; two more voided on reads of their own brain folder.
 *
 * Replay the production juror runner against real temporary git checkouts and stream-json transcripts. The
 * judge port replaces the external agy process only: while a seat is running, the shared checkout resets to a
 * prepared main commit. A lane read and an own-session brain read must survive it. Controls still require a
 * void for a changed shared path named by an errored tool, missing attribution, completed outside writes,
 * another session's brain read, and changes to either of the two strict lanes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const RUNNER = 'scripts/lib/agy-review-juror.mjs';
const SESSION = 'soak-own-conversation';

const CASES = [
  { id: 'lane-read-shared-reset', reset: true, target: 'juror', status: 'ok' },
  { id: 'own-brain-read-shared-reset', reset: true, target: 'ownBrain', status: 'ok' },
  { id: 'errored-shared-access', reset: true, target: 'shared', error: true, status: 'voided',
    reason: 'change outside the juror lane touched by the juror: this checkout' },
  { id: 'missing-attribution', reset: true, target: 'juror', emptyTranscript: true, status: 'voided',
    reason: 'change outside the juror lane touched by the juror: this checkout' },
  { id: 'outside-write', target: 'outside', write: true, status: 'voided', reason: 'write_to_file' },
  { id: 'own-brain-write', target: 'ownBrain', write: true, status: 'voided', reason: 'write_to_file' },
  { id: 'other-brain-read', target: 'otherBrain', status: 'voided', reason: 'view_file (read outside the juror lane)' },
  { id: 'review-lane-change', target: 'juror', mutate: 'review', status: 'voided',
    reason: 'change outside the juror lane: the review lane' },
  { id: 'juror-lane-change', target: 'juror', mutate: 'juror', status: 'voided',
    reason: 'juror lane changed on a read-only seat' },
];

async function replayCase(runAgyReviewJuror, scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'soak-agy-reset-')));
  // No live git configuration, hooks, signing, login, or network is needed by the replay.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
  const exec = (bin, args) => {
    if (bin !== 'git') throw new Error(`unexpected replay command: ${bin}`);
    return execFileSync(bin, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 30_000,
    });
  };
  const git = (dir, ...args) => exec('git', ['-C', dir, ...args]);
  const commit = (dir) => {
    git(dir, 'add', 'file.txt');
    git(dir, '-c', 'user.name=soak', '-c', 'user.email=soak@example.com', 'commit', '-qm', 'fixture');
  };
  try {
    const review = join(root, 'review');
    const shared = join(root, 'shared');
    const home = join(root, 'home');
    mkdirSync(review);
    git(review, 'init', '-q');
    writeFileSync(join(review, 'file.txt'), 'reviewed revision\n');
    commit(review);
    const oldHead = git(review, 'rev-parse', 'HEAD').trim();
    exec('git', ['clone', '-q', review, shared]);
    writeFileSync(join(shared, 'file.txt'), 'next main revision\n');
    commit(shared);
    const mainHead = git(shared, 'rev-parse', 'HEAD').trim();
    git(shared, 'reset', '--hard', oldHead);
    const ownBrain = join(home, '.gemini', 'antigravity-cli', 'brain', SESSION, 'task.md');
    const otherBrain = join(home, '.gemini', 'antigravity-cli', 'brain', 'other-conversation', 'task.md');
    for (const path of [ownBrain, otherBrain]) {
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, 'session notes\n');
    }
    const transcriptFile = join(root, 'transcript.jsonl');
    return await runAgyReviewJuror({
      request: { mandate: 'Review the supplied diff read-only.', input: 'fixture diff', shape: {} },
      laneCwd: review, model: 'soak-fixture',
      deps: {
        exec, repoRoot: shared, home,
        mkTempDir: () => mkdtempSync(join(root, 'juror-')),
        spawnJudge: async ({ cwd }) => {
          if (scenario.reset) git(shared, 'reset', '--hard', mainHead);
          const paths = { juror: join(cwd, 'file.txt'), shared: join(shared, 'file.txt'), ownBrain, otherBrain,
            outside: join(home, 'outside.txt'), review: join(review, 'file.txt') };
          if (scenario.mutate) writeFileSync(paths[scenario.mutate], 'unexpected lane edit\n');
          const path = paths[scenario.target];
          if (scenario.write) writeFileSync(path, 'completed write outside the lane\n');
          else if (!scenario.emptyTranscript && !scenario.error) readFileSync(path, 'utf8');
          const step_update = { step_type: 'tool', step_index: 1, conversation_id: SESSION, state: 'DONE',
            tool_name: scenario.write ? 'write_to_file' : 'view_file',
            tool_info: { parameters: { AbsolutePath: path } },
            ...(scenario.error ? { status: 'TOOL_ERROR' } : {}) };
          writeFileSync(transcriptFile, scenario.emptyTranscript ? '' : `${JSON.stringify({ event: 'step_update', step_update })}\n`);
          return { value: { summary: 'fixture review', findings: [] }, sessionId: SESSION, transcriptFile };
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export default {
  id: 'agy-juror-shared-checkout-reset',
  title: 'agy review seats falsely void on concurrent shared-checkout resets and own-session brain reads',
  card: 'card 84 — PR #5260, live trial: 19 shared-reset voids and 2 own-brain voids in 88 runs',
  fixedBy: { sha: '9d1cd12d8,74a974784', where: 'lane/agy-void-check', paths: [RUNNER] },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, RUNNER), 'utf8');
      return source.includes('function sharedChangeTouched(')
        && source.includes('const touchAll = () => paths.push(...roots);')
        && source.includes("canonicalPath(join(home, '.gemini', 'antigravity-cli', 'brain', id))");
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    try {
      const { runAgyReviewJuror } = await import(pathToFileURL(join(sourceRoot, RUNNER)).href);
      for (const scenario of CASES) {
        const result = await replayCase(runAgyReviewJuror, scenario);
        log?.(`${scenario.id}: ${result.status} (${result.reasons.join('; ')})`);
        const correctAnswer = scenario.status === 'ok'
          ? result.value?.summary === 'fixture review' && result.reasons.length === 0
          : result.value === undefined && result.reasons.some((reason) => reason.includes(scenario.reason));
        if (result.status !== scenario.status || !correctAnswer) {
          violations.push({ invariant: scenario.id,
            detail: `expected ${scenario.status}, got ${result.status}: ${result.reasons.join('; ')}` });
        }
      }
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.message ?? e) });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
