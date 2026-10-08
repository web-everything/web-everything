#!/usr/bin/env node
/**
 * @file scripts/lib/dispatch-bg-isolation.mjs
 * @description #x9fbg1x — TURN OFF Claude Code's OWN "background session hasn't isolated its changes" guard
 *   for DISPATCHED sessions (and lane clones generally) ONLY — never repo-wide.
 *
 *   THE INCIDENT (live, 2026-09-26): dispatched sessions `fix-2748`/`fix-2770` both sat `state: blocked,
 *   waitingFor: "permission prompt"`. `fix-2748`'s own transcript showed the real cause: Claude Code
 *   (>=2.1.283) refused its first Edit with *"This background session hasn't isolated its changes yet. Call
 *   EnterWorktree first…"*. `fix-2770` tried exactly that, and this repo's OWN single-branch-workflow guard
 *   denied the `git worktree add` it ran to comply — a genuine deadlock: obeying the CLI's guard is the one
 *   thing this repo's git guard never allows. The same message recurs across 43+ transcripts since 2026-08-29.
 *
 *   WHY THE EXISTING FIX (commit 63ac1da, 2026-08-17, "lane-pool already provides it") DID NOT CLOSE THIS: it
 *   set `worktree: {bgIsolation: "none"}` in the TRACKED, repo-wide `.claude/settings.json` — reaching a
 *   session only if its process actually STARTS somewhere that file is checked out. #4174 (2026-09-25,
 *   `we:scripts/operations/dispatch-lane-io.mjs#dispatchSessionCwd`) moved every dispatched session's start
 *   cwd to a bare SCRATCH directory (`.operations/dispatch/<sessionId>`) outside every checkout, specifically
 *   so a session could not dirty the daemon's own clone before acquiring a lane of its own — but that scratch
 *   directory carries no `.claude/settings.json` at all, so the repo-wide setting never reaches a freshly
 *   dispatched session in the first place. This is thus a REGRESSION #4174 introduced as a side effect, not a
 *   brand-new gap.
 *
 *   THE FIX, NARROWLY SCOPED (per this repo's own "never repo-wide" rule — an operator's own background
 *   session in the PRIMARY checkout genuinely is unisolated and should keep the guard):
 *     1. The tracked `.claude/settings.json` no longer carries `worktree` at all (see that file's own diff) —
 *        the primary checkout keeps the CLI's default guard.
 *     2. `we:scripts/operations/dispatch-lane-io.mjs` applies {@link DISPATCH_WORKTREE_SETTINGS} to every
 *        dispatched session's OWN scratch cwd only, via THIS module's {@link ensureWorktreeIsolationOff} — the
 *        SAME two-delivery-path pattern (a `--settings` CLI flag PLUS a durable `<cwd>/.claude/settings.local.
 *        json` write) `we:scripts/lib/gh-app-shim.mjs` already proved necessary for its own per-dispatch
 *        settings override (`--settings`'s JSON is a coin flip against the CLI's pre-warmed "spare" pool,
 *        which never re-applies it; the settings.local.json write is read fresh per task regardless).
 *     3. `we:scripts/lane-pool.mjs` applies the SAME override to every LANE CLONE it provisions/refreshes/
 *        acquires, via an UNTRACKED (`.gitignore`d) `.claude/settings.local.json` written INTO that clone —
 *        never the tracked file, never the primary checkout. This covers every session that ends up doing its
 *        actual work in a lane clone, dispatched or a human-driven single session alike (both already treat
 *        the lane clone itself as their isolation boundary — see docs/agent/platform-decisions.md
 *        #state-lives-where-its-nature-dictates and MEMORY rule "Edit-Work Runs In A Lane Clone").
 *
 *   NEVER BY TELLING A DISPATCHED SESSION'S OWN BRIEF TO RUN `git worktree add` ITSELF — this repo's
 *   single-branch-workflow guard (`we:scripts/guard-bash.mjs`) would only refuse it anyway (see `fix-2770`'s
 *   own transcript), and the lane clone already IS the isolation the CLI's guard exists to provide.
 *
 *   PURE CORE / IO SHELL, same law as `gh-app-shim.mjs`: {@link ensureWorktreeIsolationOff} is the one real
 *   write, best-effort and NEVER THROWING — a read-only checkout, a corrupt existing settings file (treated as
 *   empty, never fatal), or a full disk all resolve to `{ok:false}`, never an exception, so this can never be
 *   the reason a dispatch (or a lane provision) that would otherwise have gone out fine fails.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The settings PATCH that disables Claude Code's own background-session isolation guard. Frozen — every
 *  caller merges this same literal value, never a hand-rolled equivalent. */
export const DISPATCH_WORKTREE_SETTINGS = Object.freeze({ worktree: Object.freeze({ bgIsolation: 'none' }) });

/**
 * Best-effort, NEVER THROWS: merges {@link DISPATCH_WORKTREE_SETTINGS} into `<cwd>/.claude/settings.local.
 * json`, creating the file (and the `.claude` dir) if neither exists yet. ADDITIVE — an existing file's other
 * top-level keys (e.g. the gh-shim's own `env` block, `we:scripts/lib/gh-app-shim.mjs#ensureSettingsFileEnv`)
 * and any other `worktree` sub-keys survive untouched; only `worktree.bgIsolation` is set/overwritten.
 * @param {{cwd:string, readFile?:Function, writeFile?:Function, mkdir?:Function}} o
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function ensureWorktreeIsolationOff({
  cwd, readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  if (!cwd) return { ok: false, reason: 'no-cwd' };
  const dir = join(cwd, '.claude');
  const path = join(dir, 'settings.local.json');
  try {
    mkdir(dir, { recursive: true });
    let existing;
    try { existing = JSON.parse(readFile(path, 'utf8')); } catch { existing = null; }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    const existingWorktree = existing.worktree && typeof existing.worktree === 'object' && !Array.isArray(existing.worktree)
      ? existing.worktree : {};
    const merged = { ...existing, worktree: { ...existingWorktree, ...DISPATCH_WORKTREE_SETTINGS.worktree } };
    writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }
}

/** Fail-safe guard set used only when the repo's own settings file cannot be read or parsed: the two guards
 *  that matter most for a worker (Bash and Edit/Write). Never the whole list, so a parse fault degrades, not blanks. */
const FALLBACK_PRETOOLUSE = Object.freeze([
  { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node scripts/guard-lane.mjs' }] },
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/guard-bash.mjs' }] },
]);

/**
 * xl5reby — the repo root whose `scripts/` the dispatched workers' guard hooks point at. Derived from THIS file's
 * location. A lane clone is not a stable home (the guards derive the constellation primaries from their own
 * location, `<workspace>/<repo>/scripts/`, so a script under `.lanes/` would compute the wrong workspace), so a
 * root inside `.lanes` falls back to the sibling primary checkout when that has the guard.
 * @param {{fileUrl?: string, exists?: (p: string) => boolean}} [o]
 * @returns {string}
 */
export function resolveGuardRepoRoot({ fileUrl = import.meta.url, exists = (p) => { try { readFileSync(p); return true; } catch { return false; } } } = {}) {
  const here = resolve(dirname(fileURLToPath(fileUrl)), '..', '..');
  if (!here.split('/').includes('.lanes')) return here;
  const workspace = here.slice(0, here.indexOf('/.lanes/'));
  for (const name of ['webeverything', 'web-everything']) {
    const cand = join(workspace, name);
    if (exists(join(cand, 'scripts', 'guard-bash.mjs'))) return cand;
  }
  return here;
}

/**
 * xl5reby — the repo's PreToolUse guard hooks, rewritten so every script path is ABSOLUTE (`node scripts/x.mjs`
 * resolves against the session cwd, and a dispatched worker's cwd is a scratch dir with no `scripts/`). PURE.
 * Only PreToolUse is carried: those are the deny guards. SessionStart/Stop/PostToolUse hooks do bookkeeping with
 * side effects meant for interactive sessions and stay out. A command that is not a plain `node scripts/...` is
 * skipped rather than guessed at. The guards locate the primaries and the lane from their OWN location and the
 * event payload, never from the process cwd, so an absolute path is all they need.
 * @param {{preToolUse?: Array, repoRoot: string}} o
 * @returns {Array<{matcher?: string, hooks: Array<{type: string, command: string}>}>}
 */
export function dispatchGuardHooks({ preToolUse, repoRoot }) {
  const groups = Array.isArray(preToolUse) && preToolUse.length ? preToolUse : FALLBACK_PRETOOLUSE;
  const out = [];
  for (const g of groups) {
    const hooks = [];
    for (const h of g?.hooks ?? []) {
      const m = h?.type === 'command' && typeof h.command === 'string' ? /^node (scripts\/\S+)(.*)$/.exec(h.command) : null;
      if (m) hooks.push({ type: 'command', command: `node "${join(repoRoot, m[1])}"${m[2]}` });
    }
    if (hooks.length) out.push({ ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks });
  }
  return out;
}

/**
 * xl5reby — THE SAFETY GAP: a dispatched worker starts in `.operations/dispatch/<id>`, which has no repo
 * `.claude/settings.json`, so the repo's PreToolUse guards (guard-bash, guard-lane, ...) never ran for it.
 * This merges them (absolute paths) into the worker's OWN `<cwd>/.claude/settings.local.json`. Why this file
 * and not `--settings` or user-level hooks: the local settings file is read fresh from the start directory on
 * every task (the `--settings` JSON is skipped when the CLI hands out a pre-warmed spare session, see the
 * header), and it is scoped to this one worker, so nothing leaks to the operator's other sessions. ADDITIVE and
 * IDEMPOTENT (a command already present is not added twice); never throws.
 * @param {{cwd: string, repoRoot?: string, readFile?: Function, writeFile?: Function, mkdir?: Function}} o
 * @returns {{ok: boolean, path?: string, count?: number, reason?: string}}
 */
export function ensureDispatchGuardHooks({
  cwd, repoRoot = resolveGuardRepoRoot(), readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  if (!cwd) return { ok: false, reason: 'no-cwd' };
  const dir = join(cwd, '.claude');
  const path = join(dir, 'settings.local.json');
  try {
    let repoPre = null;
    try { repoPre = JSON.parse(readFile(join(repoRoot, '.claude', 'settings.json'), 'utf8'))?.hooks?.PreToolUse ?? null; } catch { repoPre = null; }
    const wanted = dispatchGuardHooks({ preToolUse: repoPre, repoRoot });
    mkdir(dir, { recursive: true });
    let existing;
    try { existing = JSON.parse(readFile(path, 'utf8')); } catch { existing = null; }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    const hooks = existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks) ? { ...existing.hooks } : {};
    const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.map((g) => ({ ...g, hooks: [...(g?.hooks ?? [])] })) : [];
    const have = new Set(pre.flatMap((g) => (g.hooks ?? []).map((h) => `${g.matcher ?? ''}\u0000${h.command}`)));
    for (const g of wanted) {
      const fresh = g.hooks.filter((h) => !have.has(`${g.matcher ?? ''}\u0000${h.command}`));
      if (fresh.length) pre.push({ ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks: fresh });
    }
    hooks.PreToolUse = pre;
    writeFile(path, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`, 'utf8');
    return { ok: true, path, count: wanted.reduce((n, g) => n + g.hooks.length, 0) };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }
}

/**
 * THE ONE SHARED CALL every dispatch path makes for a FRESH `claude --bg` session (build/fix/ci-heal/prepare via
 * `dispatch-lane-io.mjs#createDispatchSinks`, the conveyor fix path `reconcile-fix-dispatch.mjs`, the review path
 * `review-dispatch.mjs`, and `stuck-pr-inspect-dispatch.mjs`). Before build-path-codex-isolation only the
 * dispatch-lane sink applied the override: every other dispatcher spawned into a bare scratch cwd with no
 * `worktree` setting at all, so its session hit the "Call EnterWorktree first" guard on its first Edit.
 *
 * Does BOTH halves of the two-delivery-path pattern in one call, so no caller can apply one and forget the other:
 * the durable `<cwd>/.claude/settings.local.json` write ({@link ensureWorktreeIsolationOff}, never throws), and
 * the value the caller folds into `buildAgentArgv`'s `worktreeSettings` (the `--settings` flag).
 * xl5reby — and the same durable file also receives the repo's PreToolUse guard hooks
 * ({@link ensureDispatchGuardHooks}); `hooks` reports that write. Hooks ride ONLY in the file, never in
 * `--settings`, so a guard cannot run twice.
 *
 * @param {string} cwd - the session's own scratch cwd (never the primary checkout — see this file's header).
 * @param {{ensure?: (o: {cwd: string}) => object, ensureHooks?: (o: {cwd: string}) => object}} [io]
 * @returns {{worktreeSettings: {bgIsolation: 'none'}, write: object, hooks: object}}
 */
export function isolateDispatchSession(cwd, { ensure = ensureWorktreeIsolationOff, ensureHooks = ensureDispatchGuardHooks } = {}) {
  const write = ensure({ cwd });
  const hooks = ensureHooks({ cwd });
  return { worktreeSettings: DISPATCH_WORKTREE_SETTINGS.worktree, write, hooks };
}

/** True iff `dir` already has the override on disk (best-effort read, never throws) — used only for
 *  diagnostics/tests; nothing in the real dispatch/lane-provision path needs to check before writing, since
 *  {@link ensureWorktreeIsolationOff} is already idempotent and additive. */
export function hasWorktreeIsolationOff(dir, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    return parsed?.worktree?.bgIsolation === 'none';
  } catch {
    return false;
  }
}
