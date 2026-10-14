/**
 * @file agent-actions.mjs — epic #3383 part 3, the BEHAVIOUR ENGINE. A scenario attaches a scripted queue of
 * actions to a session-name pattern (`w.agents.script('fix-*', [w.act.resolveConflictAndPush(), ...])` —
 * `createFakeClaude#script`, `scripts/operations/__tests__/helpers/fake-claude.mjs`); `stepSessions(ctx)` is
 * what the scenario runner (part 4, not built here) calls once per tick to advance every LIVE scripted
 * session by exactly one action.
 *
 * EACH ACTION FACTORY RETURNS `{kind, run(ctx, session)}` — a plain object, not a class, so a scenario's own
 * `expect()` can assert on `.kind` directly and a malformed one (missing `run`, or anything `script()` was
 * handed that is not this shape) is a loud `throw`, never a silently-skipped no-op (see `stepSessions` below).
 *
 * `ctx` (documented once here, not per-factory): `{ claude, gh, repoFor(session), simClone, env, completionsDir,
 * clock }` — `claude` is `createFakeClaude`'s own return value, `gh` is the OTHER worker's fake-GitHub JS API
 * (`we:scripts/conveyor/__tests__/helpers/fake-gh.mjs`'s `createFakeGithub` — used only by its documented
 * shape, `{openPr, comment, pr, ...}`, never imported from here), `simClone` is the abs path of the daemon's
 * own clone (so `scripts/review-set-label.mjs` etc are run for REAL, as child processes, exactly as the
 * running daemon would), `env` is the scenario's complete env (fake `PATH`/`HOME`/clock — passed to every
 * child process this file spawns), and `clock` is `./clock.mjs`'s `createSimClock()` return value.
 *
 * TRANSCRIPT-TOUCHING IS THE HUNG-SESSION SIGNAL. Every action here except {@link hang} stamps its session's
 * transcript mtime to the sim clock's current instant after it runs (`touchTranscript`) — modelling a real
 * agent whose tool calls keep its own transcript file growing. `hang()` deliberately skips it: the session
 * stays `state: 'working'` with a live pid, but its transcript stops advancing, which is the one signal
 * `we:scripts/conveyor/session-reaper.mjs`'s own hung-session axis (I-02 in the design report) has to go on.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { transcriptPath } from '../../../operations/__tests__/helpers/fake-claude-shim.mjs';

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `review-1234` / `fix-1234` / `ci-heal-1234` → `1234`. `null` when the session's name carries no PR number —
 *  an action that needs one (postVerdict, pushCommit, …) throws rather than silently acting on `NaN`. */
function prNumberFromName(name) {
  const m = /-(\d+)(?:$|[^0-9])/.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

function requirePr(session) {
  const pr = prNumberFromName(session?.name);
  if (pr === null) throw new Error(`agent-actions: session "${session?.name}" has no PR number in its name — cannot act on it`);
  return pr;
}

function touchTranscript(ctx, session) {
  try {
    const home = ctx.env?.FAKE_CLAUDE_HOME;
    if (!home || !session?.cwd || !session?.sessionId) return;
    const path = transcriptPath({ home, cwd: session.cwd, sessionId: session.sessionId });
    if (existsSync(path)) ctx.clock.touch(path);
  } catch { /* best effort — a missing transcript never fails the step */ }
}

/** Run one of the daemon's own real CLIs (`review-set-label.mjs`, `conflict-fix-mark.mjs`, `rearm-review.mjs`,
 *  `stand-down.mjs`) as a REAL child process against `ctx.simClone` — never a re-implementation of what those
 *  scripts decide, exactly the design report's own reasoning for why this engine exists. */
function runRealCli(ctx, relPath, args) {
  return execFileSync(process.execPath, [join(ctx.simClone, relPath), ...args], {
    cwd: ctx.simClone,
    env: ctx.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeTempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-action-'));
  const path = join(dir, 'body.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Import the REAL `completion-store.mjs` FROM THE SIM CLONE (never from this repo's own tree directly) — the
 *  same "run the daemon's own code" reasoning as {@link runRealCli}, just via `import()` instead of a child
 *  process, since a writer needs to be called in-process to return its record. */
async function completionStoreFrom(simClone) {
  const path = join(simClone, 'scripts', 'operations', 'completion-store.mjs');
  return import(pathToFileURL(path).href);
}

async function doWriteCompletion(ctx, session, spec = {}) {
  const { newCompletionRecord, writeCompletion: persist, applyCompletionUpdate } = await completionStoreFrom(ctx.simClone);
  const dir = ctx.completionsDir;
  const kind = spec.kind ?? (session.name?.startsWith('fix-') ? 'fix' : session.name?.startsWith('review-') ? 'review' : 'inspect');
  const pr = spec.pr ?? prNumberFromName(session.name);
  let record = newCompletionRecord({ session: session.name, kind, pr, item: spec.item ?? null });
  record = applyCompletionUpdate(record, {
    status: spec.status ?? 'done',
    outcome: spec.outcome ?? null,
    verdict: spec.verdict ?? null,
    label: spec.label ?? null,
    runId: spec.runId ?? null,
  });
  persist(record, dir);
  return record;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACTION FACTORIES
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Post a findings comment (via `ctx.gh.comment`) then run the REAL `scripts/review-set-label.mjs` — the same
 *  two steps a real reviewer agent's own brief has it perform. `verdict: 'accepted'` needs no `--body-file`;
 *  `'changes'` does (the CLI's own usage string requires it — see the shim header for the measured usage). */
export function postVerdict({ verdict, findings = [] } = {}) {
  if (verdict !== 'accepted' && verdict !== 'changes') throw new Error(`agent-actions: postVerdict needs verdict 'accepted'|'changes', got ${JSON.stringify(verdict)}`);
  return {
    kind: 'postVerdict',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug } = ctx.repoFor(session);
      const body = findings.length
        ? findings.map((f, i) => `${i + 1}. ${typeof f === 'string' ? f : JSON.stringify(f)}`).join('\n')
        : `Verdict: ${verdict}`;
      if (ctx.gh?.comment) ctx.gh.comment(slug, pr, body, { author: session.name });
      const args = [String(pr), `--repo=${slug}`, `--to=${verdict}`, `--actor=${session.name}`];
      if (verdict === 'changes') args.push(`--body-file=${writeTempFile(body)}`);
      runRealCli(ctx, 'scripts/review-set-label.mjs', args);
      touchTranscript(ctx, session);
    },
  };
}

/** Real git: clone `originPath`, check out the PR's head branch, write `files`, commit, push. */
export function pushCommit({ files = {}, message = 'fix: apply changes' } = {}) {
  return {
    kind: 'pushCommit',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug, originPath } = ctx.repoFor(session);
      const prRow = ctx.gh?.pr ? ctx.gh.pr(slug, pr) : null;
      const headRef = prRow?.headRefName;
      if (!headRef) throw new Error(`agent-actions: pushCommit — no headRefName for ${slug}#${pr} (is ctx.gh wired up?)`);
      const work = mkdtempSync(join(tmpdir(), 'agent-push-'));
      try {
        git(work, ['clone', '--quiet', originPath, '.']);
        git(work, ['checkout', headRef]);
        for (const [name, content] of Object.entries(files)) {
          const filePath = join(work, name);
          mkdirSync(join(filePath, '..'), { recursive: true });
          writeFileSync(filePath, content, 'utf8');
        }
        git(work, ['add', '-A']);
        git(work, ['-c', 'user.email=fake-agent@example.com', '-c', 'user.name=Fake Agent', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
        git(work, ['push', 'origin', `HEAD:${headRef}`]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      touchTranscript(ctx, session);
    },
  };
}

/** Real git: merge `baseRef` (default the repo's default branch, read via `ctx.gh.pr`) into the PR head,
 *  resolving any conflict with `-X ours`/`-X theirs`, then push. */
export function resolveConflictAndPush({ take = 'ours', baseRef } = {}) {
  if (take !== 'ours' && take !== 'theirs') throw new Error(`agent-actions: resolveConflictAndPush needs take 'ours'|'theirs', got ${JSON.stringify(take)}`);
  return {
    kind: 'resolveConflictAndPush',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug, originPath } = ctx.repoFor(session);
      const prRow = ctx.gh?.pr ? ctx.gh.pr(slug, pr) : null;
      const headRef = prRow?.headRefName;
      const base = baseRef ?? prRow?.baseRefName ?? 'main';
      if (!headRef) throw new Error(`agent-actions: resolveConflictAndPush — no headRefName for ${slug}#${pr}`);
      const work = mkdtempSync(join(tmpdir(), 'agent-conflict-'));
      try {
        git(work, ['clone', '--quiet', originPath, '.']);
        git(work, ['checkout', headRef]);
        git(work, ['-c', 'user.email=fake-agent@example.com', '-c', 'user.name=Fake Agent',
          'merge', `origin/${base}`, `-X${take}`, '--no-edit']);
        git(work, ['push', 'origin', `HEAD:${headRef}`]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      touchTranscript(ctx, session);
    },
  };
}

/** Run the REAL `scripts/conveyor/conflict-fix-mark.mjs <pr> --repo=<slug>`. */
export function markConflictFixed({ actor, baseRef } = {}) {
  return {
    kind: 'markConflictFixed',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug } = ctx.repoFor(session);
      const args = [String(pr), `--repo=${slug}`];
      if (actor) args.push(`--actor=${actor}`);
      if (baseRef) args.push(`--base-ref=${baseRef}`);
      runRealCli(ctx, 'scripts/conveyor/conflict-fix-mark.mjs', args);
      touchTranscript(ctx, session);
    },
  };
}

/** Run the REAL `scripts/conveyor/rearm-review.mjs <pr> --repo=<slug>`. */
export function rearm({ actor, round } = {}) {
  return {
    kind: 'rearm',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug } = ctx.repoFor(session);
      const args = [String(pr), `--repo=${slug}`];
      if (actor) args.push(`--actor=${actor}`);
      if (round) args.push(`--round=${round}`);
      runRealCli(ctx, 'scripts/conveyor/rearm-review.mjs', args);
      touchTranscript(ctx, session);
    },
  };
}

/** Run the REAL `scripts/conveyor/stand-down.mjs <pr> --repo=<slug> --reason=<reason>`. */
export function standDown({ reason, actor, detail } = {}) {
  if (!reason) throw new Error('agent-actions: standDown needs a reason');
  return {
    kind: 'standDown',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug } = ctx.repoFor(session);
      const args = [String(pr), `--repo=${slug}`, `--reason=${reason}`];
      if (actor) args.push(`--actor=${actor}`);
      if (detail) args.push(`--detail=${detail}`);
      runRealCli(ctx, 'scripts/conveyor/stand-down.mjs', args);
      touchTranscript(ctx, session);
    },
  };
}

/** Write (or update) this session's own completion record, via the REAL `completion-store.mjs` writer —
 *  imported FROM `ctx.simClone`, never re-implemented here. */
export function writeCompletion(spec = {}) {
  return {
    kind: 'writeCompletion',
    async run(ctx, session) {
      await doWriteCompletion(ctx, session, spec);
      touchTranscript(ctx, session);
    },
  };
}

/** Change this session's own `state` (and any extra fields — `status`/`waitingFor` for the awaiting-permission
 *  axis, etc), via `ctx.claude.setState`. */
export function setState(state, extra = {}) {
  return {
    kind: 'setState',
    run(ctx, session) {
      ctx.claude.setState(session.id, state, extra);
      touchTranscript(ctx, session);
    },
  };
}

/** End the session: kill its sleeper pid and set its terminal `state`, optionally writing (or not) its
 *  completion record first — the one action whose whole point is to prove `writeCompletion: false` really
 *  leaves nothing on disk (I-01/I-04 in the design report both turn on exactly this distinction). */
export function exit({ state = 'done', writeCompletion: shouldWriteCompletion = false, ...completionSpec } = {}) {
  if (state !== 'done' && state !== 'failed') throw new Error(`agent-actions: exit needs state 'done'|'failed', got ${JSON.stringify(state)}`);
  return {
    kind: 'exit',
    async run(ctx, session) {
      if (shouldWriteCompletion) await doWriteCompletion(ctx, session, { status: 'done', ...completionSpec });
      ctx.claude.killPid(session.id);
      ctx.claude.setState(session.id, state);
      // No `touchTranscript` — the session is over, its transcript should stop advancing exactly as a real
      // agent's would once its process exits.
    },
  };
}

/** Mark the session hung: it stays `state: 'working'` with a live pid, but this is the ONE action that never
 *  touches the transcript — see the file header on why that omission IS the hung-session signal. */
export function hang() {
  return {
    kind: 'hang',
    run(ctx, session) {
      ctx.claude.setState(session.id, 'working', { hung: true });
      // Deliberately no touchTranscript(ctx, session) call here.
    },
  };
}

/**
 * Live incident, night of 2026-09-25/26 ET (epic #3383/#4075 continuation) — the operator's own Claude login
 * expired, and every daemon-dispatched session ended IMMEDIATELY on the CLI's own auth failure. Appends the
 * REAL failure shape (measured live off `~/.claude/projects/<slug>/f61f0de3-....jsonl` — see
 * `we:scripts/conveyor/hung-session.mjs`'s own file header) directly to the session's own transcript file —
 * NOT `touchTranscript` (this is real content the shared detector reads, not a bare mtime bump) — and
 * deliberately leaves `state`/`pid` UNTOUCHED: the whole point of the live incident is that these sessions
 * were never killed, just sat there with a still-live pid, never advancing. `we:scripts/conveyor/soak/breaks/
 * claude-auth-expired.mjs` proves the daemon still frees the PR anyway once `reconcile-core.mjs#assessLiveness`
 * knows to look.
 */
export function authExpiredFail() {
  return {
    kind: 'authExpiredFail',
    run(ctx, session) {
      const home = ctx.env?.FAKE_CLAUDE_HOME;
      if (!home || !session?.cwd || !session?.sessionId) return;
      const path = transcriptPath({ home, cwd: session.cwd, sessionId: session.sessionId });
      mkdirSync(dirname(path), { recursive: true });
      // No timestamp dependency on the sim clock: the shared detector (`hung-session.mjs
      // #classifyClaudeAuthExpired`) matches on the newest assistant turn's API-error provenance
      // (`isApiErrorMessage` + `error`/text), never on when it was written — an instant, unconditional signal,
      // unlike the hung-transcript axis's own staleness window.
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
        error: 'authentication_failed',
        isApiErrorMessage: true,
      });
      appendFileSync(path, `${line}\n`);
      // Deliberately NO ctx.claude.setState / killPid call — see the doc above.
    },
  };
}

/**
 * The false-positive twin of {@link authExpiredFail} (PR #2717 review): a HEALTHY session working a GitHub-auth
 * bug writes an ordinary assistant turn naming every auth signature the detector once matched on free text —
 * but it is the model's own prose, never the CLI's synthetic `isApiErrorMessage` turn. `we:scripts/conveyor/
 * soak/breaks/claude-auth-false-positive.mjs` proves the daemon keeps reading such a session as live.
 */
export function authDiscussionTurn() {
  return {
    kind: 'authDiscussionTurn',
    run(ctx, session) {
      const home = ctx.env?.FAKE_CLAUDE_HOME;
      if (!home || !session?.cwd || !session?.sessionId) return;
      const path = transcriptPath({ home, cwd: session.cwd, sessionId: session.sessionId });
      mkdirSync(dirname(path), { recursive: true });
      const text = 'Fixed the bug: a 401 Unauthorized from the GitHub API (authentication_failed) was misread; '
        + 'the old incident transcript said "Login expired · Please run /login".';
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
      appendFileSync(path, `${line}\n`);
    },
  };
}

/** Run one real `gh pr view` with the session's OWN recorded `GH_TOKEN` (a stale/revoked one, in the scenario
 *  this models — I-12/`inheritStaleToken` in the design report), record the resulting 401, then exit failed. */
export function fail401() {
  return {
    kind: 'fail401',
    run(ctx, session) {
      const pr = requirePr(session);
      const { slug } = ctx.repoFor(session);
      const token = session?.env?.GH_TOKEN ?? '';
      let error = null;
      try {
        execFileSync('gh', ['pr', 'view', String(pr), '--repo', slug], {
          env: { ...ctx.env, GH_TOKEN: token },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
      } catch (e) {
        error = String(e?.stderr ?? e?.message ?? e);
      }
      ctx.claude.killPid(session.id);
      ctx.claude.setState(session.id, 'failed', { lastError: error ?? '401' });
    },
  };
}

/** No lane was acquirable — record that and exit failed. No `gh`/`git` call: this models a dispatch that
 *  never got far enough to touch either. */
export function failNoLane() {
  return {
    kind: 'failNoLane',
    run(ctx, session) {
      ctx.claude.killPid(session.id);
      ctx.claude.setState(session.id, 'failed', { lastError: 'no free lane' });
    },
  };
}

/** #3383 I-09 — the FIRST thing a real review/delivery agent's own brief does: `node scripts/lane-pool.mjs
 *  acquire --purpose=<purpose> --session=<this session's name> --json` (mirrors
 *  `skills-src/review/review-agent-brief.md`'s own acquire line, minus `--wait-ms=` — this action never
 *  polls; a starved pool fails AT ONCE, exactly like the real CLI's own instant-fail default, which is the
 *  behaviour a lane-starvation scenario needs to observe). On success the acquired lane NUMBER is persisted
 *  onto the session's own store record (`ctx.claude.setState`), so a later {@link releaseLane} action (run in
 *  a LATER tick, reading a freshly re-fetched session row) still knows which lane to hand back. On failure —
 *  the pool genuinely has nothing acquirable right now — this session fails exactly like {@link failNoLane},
 *  because that IS what happened; a scenario's own dispatch cap (not this action) is what is supposed to make
 *  this the rare case, so a scenario asserting "no session ever failed no-lane" is asserting that cap works. */
export function acquireLane({ purpose = 'review-loop' } = {}) {
  return {
    kind: 'acquireLane',
    run(ctx, session) {
      let parsed = null;
      try {
        const out = execFileSync(process.execPath, [
          join(ctx.simClone, 'scripts', 'lane-pool.mjs'), 'acquire',
          `--purpose=${purpose}`, `--session=${session.name}`, '--json',
        ], {
          cwd: ctx.simClone, env: ctx.env, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
        parsed = JSON.parse(out);
      } catch { parsed = null; }
      if (!parsed || !Number.isInteger(parsed.lane)) {
        ctx.claude.killPid(session.id);
        ctx.claude.setState(session.id, 'failed', { lastError: 'no free lane' });
        return;
      }
      ctx.claude.setState(session.id, 'working', { lane: parsed.lane, laneDir: parsed.path ?? null });
      touchTranscript(ctx, session);
    },
  };
}

/** #3383 I-09 — the matching hand-back: `node scripts/lane-pool.mjs release --lane=<N> --session=<name>`,
 *  reusing the lane number {@link acquireLane} persisted onto this session's own row. A session with no
 *  recorded `lane` (never acquired one, or already released) is a no-op — nothing to release. */
export function releaseLane() {
  return {
    kind: 'releaseLane',
    run(ctx, session) {
      const lane = session?.lane;
      if (!Number.isInteger(lane)) { touchTranscript(ctx, session); return; }
      try {
        execFileSync(process.execPath, [
          join(ctx.simClone, 'scripts', 'lane-pool.mjs'), 'release',
          `--lane=${lane}`, `--session=${session.name}`,
        ], {
          cwd: ctx.simClone, env: ctx.env, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
      } catch { /* best-effort — a failed release is a lane-pool-health-watch concern, not this action's */ }
      touchTranscript(ctx, session);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// ASSERT HELPERS
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `GH_TOKEN` a session's spawn env carried — re-exported from `fake-claude.mjs` so a scenario/test that
 *  only imports THIS file (the behaviour-engine surface) still has it. See that file for the definition. */
export { sessionEnvToken } from '../../../operations/__tests__/helpers/fake-claude.mjs';

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE ENGINE
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Step every LIVE (`state: 'working'|'blocked'`) session that has a scripted action queued: pop and run ONE
 * action per session, per call. A session with nothing scripted (no `script()` pattern matches its name, or
 * its queue is already empty) is simply left alone — most sessions in a scenario are never scripted at all.
 *
 * @param {object} ctx - see the file header for the full shape.
 * @returns {Promise<Array<{session:string, kind:string}>>} what ran, in session-listing order.
 */
export async function stepSessions(ctx) {
  const stepped = [];
  const sessions = ctx.claude.sessions().filter((s) => s.state === 'working' || s.state === 'blocked');
  for (const session of sessions) {
    const action = ctx.claude.takeNextAction(session.name);
    if (!action) continue;
    if (!action.kind || typeof action.run !== 'function') {
      throw new Error(`agent-actions: malformed action queued for session "${session.name}": ${JSON.stringify(action)}`);
    }
    // eslint-disable-next-line no-await-in-loop -- sessions must step in listing order, one action at a time
    await action.run(ctx, session);
    stepped.push({ session: session.name, kind: action.kind });
  }
  return stepped;
}
