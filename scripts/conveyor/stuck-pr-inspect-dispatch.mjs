#!/usr/bin/env node
/**
 * @file scripts/conveyor/stuck-pr-inspect-dispatch.mjs
 * @description DISPATCH ONE DIAGNOSIS-ONLY INSPECTION AGENT for one stuck PR (epic #3383's stuck-PR watch).
 *
 *   node scripts/conveyor/stuck-pr-inspect-dispatch.mjs --pr=2505 --repo=chalbert/web-everything \
 *     --stage=conflict --minutes-since=390 --threshold-minutes=45
 *
 * MIRRORS `we:scripts/operations/review-dispatch.mjs#dispatchReview`'s OWN COMPOSITION (plan → fill the brief →
 * mint a fresh session id → spawn), reusing the SAME primitives (`buildAgentArgv`, `defaultSpawnAgent`,
 * `parseBackgroundedId`, `assertNotALaneCheckout`) rather than re-deriving them — the same precedent
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs` already followed for its own fix dispatch.
 *
 * LIGHTER THAN A REVIEW DISPATCH: this agent never acquires a lane (it never builds or edits anything), so
 * there is no `{{LANE_REPO}}` to resolve and no checkout-existence check for a sibling repo — `gh` alone
 * reaches everything it needs to read.
 *
 * A NARROW, DIAGNOSIS-SHAPED DENY LIST (not a full `gh` denial the way `review-dispatch.mjs` uses — this
 * agent's OWN required last step is `gh pr comment`, which a wholesale `gh` denial would also block). Denies
 * exactly the mutating shapes the brief never needs: labels, edits, merges, reviews, and every write-side
 * script this repo owns. Same residual as `review-dispatch.mjs`'s own note: a prefix-match deny list is not a
 * sandbox (a sufficiently adversarial rewrite is not caught) — it is the same trade that file already accepts,
 * narrowed here to what THIS brief's much smaller task surface actually needs denied.
 */
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentArgsFromEnv, assertNotALaneCheckout, buildAgentArgv, defaultSpawnAgent, isPreSpawnRefusal, parseBackgroundedId,
  REPO_ROOT, resolveGhShimSettingsEnv,
} from '../operations/dispatch-lane-io.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { mintSessionSlug } from './session-slug.mjs';

/** The inspection-side twin of `we:scripts/operations/dispatch-lane-io.mjs#DISPATCHED_AGENT_SYSTEM_PROMPT_FILE`
 *  / `we:scripts/operations/review-dispatch.mjs#REVIEW_DISPATCH_SYSTEM_PROMPT_FILE` — a DEDICATED file (not a
 *  reuse of either) because this dispatch's own standing identity ("you have no lane, you acquire none,
 *  diagnosis only") genuinely differs from both. */
export const INSPECT_DISPATCH_SYSTEM_PROMPT_FILE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills-src', 'conveyor', 'stuck-pr-inspect-system-prompt.md',
);

/** The template `we:skills-src/conveyor/stuck-pr-inspect-brief.md` — read fresh per dispatch. */
export function inspectBriefPath(root = REPO_ROOT) {
  return join(root, 'skills-src', 'conveyor', 'stuck-pr-inspect-brief.md');
}

/** The `{{PLACEHOLDER}}` tokens the inspection brief declares. */
export const INSPECT_BRIEF_PLACEHOLDERS = Object.freeze([
  'PR', 'REPO', 'SESSION_SLUG', 'STAGE', 'MINUTES_SINCE', 'THRESHOLD_MINUTES',
]);

/** Any run of separators a placeholder name might be typo'd with, canonicalized — same shape as
 *  `we:scripts/operations/review-dispatch.mjs#canonicalReviewPlaceholder`. */
export function canonicalInspectPlaceholder(name) {
  const norm = String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return INSPECT_BRIEF_PLACEHOLDERS.includes(norm) ? norm : null;
}

const INSPECT_BRIEF_TOKEN_RE = /\{\{\s*([^{}\n]*?)\s*\}\}/g;

/** What a placeholder VALUE may safely contain — pasted UNQUOTED into a shell command the dispatched agent is
 *  told to run, same narrow allowlist `we:scripts/operations/review-dispatch.mjs#REVIEW_BRIEF_VALUE_RE` uses. */
export const INSPECT_BRIEF_VALUE_RE = /^[A-Za-z0-9_.,:/@#-]+$/;

/**
 * FILL the inspection brief. PURE. Same three refusals as `dispatch-lane.mjs#fillBrief` /
 * `review-dispatch.mjs#fillReviewBrief`: a missing/blank/unsafe value refuses; a MISSPELLED placeholder
 * refuses (nothing substitutes it, so the agent would run the literal token); an UNKNOWN token is reported,
 * never fatal (the brief's own prose legitimately contains bracketed examples).
 * @param {string} template
 * @param {object} values
 * @returns {{prompt:string, unknownTokens:string[]}}
 */
export function fillInspectBrief(template, values = {}) {
  const text = String(template ?? '');
  if (!text.trim()) {
    throw new Error('stuck-pr-inspect-dispatch: the inspection brief template is empty — refusing to dispatch an agent with no instructions');
  }
  for (const name of INSPECT_BRIEF_PLACEHOLDERS) {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`stuck-pr-inspect-dispatch: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`);
    }
    if (!INSPECT_BRIEF_VALUE_RE.test(String(value))) {
      throw new Error(
        `stuck-pr-inspect-dispatch: the value for {{${name}}} (${JSON.stringify(String(value))}) has characters `
        + 'the brief cannot carry safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.',
      );
    }
  }
  const unknown = new Set();
  const misspelled = new Set();
  const prompt = text.replace(INSPECT_BRIEF_TOKEN_RE, (whole, name) => {
    if (whole === `{{${name}}}` && INSPECT_BRIEF_PLACEHOLDERS.includes(name)) return String(values[name]);
    const canonical = canonicalInspectPlaceholder(name);
    if (canonical) { misspelled.add(`${whole} (meaning {{${canonical}}})`); return whole; }
    unknown.add(whole);
    return whole;
  });
  if (misspelled.size) {
    throw new Error(
      `stuck-pr-inspect-dispatch: the brief carries a MISSPELLED placeholder — ${[...misspelled].sort().join(', ')}. `
      + `Spell it exactly as one of ${INSPECT_BRIEF_PLACEHOLDERS.map((n) => `{{${n}}}`).join(', ')}.`,
    );
  }
  return { prompt, unknownTokens: [...unknown].sort() };
}

/** `inspect-<pr>` for WE, `inspect-<tag>-<pr>` for a sibling repo — `we:scripts/conveyor/session-slug.mjs`'s
 *  own `inspect` PR-kind grammar (epic #3383), so `session-reaper.mjs` / `lease-reaper.mjs` cover it for free. */
export function inspectSessionSlug(pr, repo = 'we') {
  const id = String(pr ?? '').trim();
  if (!id) throw new Error('stuck-pr-inspect-dispatch: needs a PR number to derive a session slug');
  return mintSessionSlug({ kind: 'inspect', id, repo });
}

/**
 * BASH DENY LIST baked into every dispatched inspection session (see file header for why this is narrower than
 * `review-dispatch.mjs`'s wholesale `gh` denial — this brief's own required last step is `gh pr comment`).
 * Denies: every label/edit/merge/review mutation on GitHub, and every write-side script this repo owns that a
 * diagnosis-only agent has no legitimate reason to run (it never labels, never lands, never claims/resolves a
 * backlog item, never acquires or releases a lane).
 *
 * `gh api` IS DENIED WHOLESALE (PR #2553 review): raw REST reaches every write the per-verb rules deny
 * (`-X PATCH state=closed`, `POST …/labels`, `PUT …/merge`) — the exact bypass `review-dispatch.mjs` already
 * closed for itself. The brief's one legitimate `gh api` use, the timeline READ, goes through the fixed-argv,
 * GET-only `node scripts/conveyor/stuck-pr-watch.mjs timeline` instead. Every other gh family that can write
 * to GitHub (issues, workflows/runs, repo/release/secret/variable/cache/ruleset settings, the remaining pr
 * state verbs) is denied too; what stays reachable is the read side (`gh pr view`, `gh pr checks`, `gh pr
 * diff`) plus the brief's own `gh pr comment`.
 */
export const INSPECT_DISPATCH_DISALLOWED_TOOLS = Object.freeze([
  'Bash(gh api:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr reopen:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr lock:*)',
  'Bash(gh pr unlock:*)',
  'Bash(gh pr update-branch:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr checkout:*)', // switches the branch of the PRIMARY checkout this agent runs in
  'Bash(gh label:*)',
  'Bash(gh issue:*)',
  'Bash(gh workflow:*)',
  'Bash(gh run:*)',
  'Bash(gh repo:*)',
  'Bash(gh release:*)',
  'Bash(gh secret:*)',
  'Bash(gh variable:*)',
  'Bash(gh cache:*)',
  'Bash(gh ruleset:*)',
  'Bash(gh gist:*)',
  'Bash(gh project:*)',
  'Bash(gh codespace:*)',
  'Bash(gh ssh-key:*)',
  'Bash(gh gpg-key:*)',
  // Indirection that would re-open the `gh api` door: an alias/extension runs arbitrary gh subcommands under a
  // name no rule matches, and `gh auth token` hands a raw credential to curl.
  'Bash(gh alias:*)',
  'Bash(gh extension:*)',
  'Bash(gh auth:*)',
  // This repo's own GitHub-writing conveyor scripts — each shells `gh` as a child process, where Bash deny
  // rules never reach. `stuck-pr-watch.mjs sweep` would also dispatch MORE inspection agents (recursive fan-out);
  // its `timeline` verb stays reachable (the brief's own read).
  'Bash(node scripts/conveyor/stuck-pr-watch.mjs sweep:*)',
  'Bash(node scripts/conveyor/stuck-pr-inspect-dispatch.mjs:*)',
  'Bash(node scripts/conveyor/stand-down.mjs:*)',
  'Bash(node scripts/conveyor/rearm-review.mjs:*)',
  'Bash(node scripts/conveyor/ci-heal-mark.mjs:*)',
  'Bash(node scripts/conveyor/advisory-label-sweep.mjs:*)',
  // `git` IS DENIED WHOLESALE (PR #2553 review). This agent runs in the operator's PRIMARY checkout with no lane
  // behind it, so a `git checkout`/`reset --hard`/`clean -fd` there cannot be undone. Per-verb rules would also
  // miss `git -C <dir> …` / `git -c k=v …`. The brief needs no git at all — it reads everything through `gh`.
  'Bash(git:*)',
  'Bash(node scripts/review-set-label.mjs:*)',
  'Bash(node scripts/backlog.mjs:*)',
  'Bash(node scripts/lane-pool.mjs:*)',
  'Bash(node scripts/pr-land.mjs:*)',
  'Bash(node scripts/merge-ai-prs.mjs:*)',
  'Bash(node scripts/operations/run.mjs:*)',
]);

/** ONE `=`-joined argv element — NEVER two separate elements. `--disallowedTools` is variadic; a two-element
 *  form lets `claude`'s parser keep consuming the PROMPT that `buildAgentArgv` appends right after it as more
 *  deny patterns, silently swallowing the whole task (measured live, `review-dispatch.mjs`'s own R2 finding). */
export function inspectDispatchDisallowedToolsArgs() {
  return [`--disallowedTools=${INSPECT_DISPATCH_DISALLOWED_TOOLS.join(',')}`];
}

/**
 * Shape one dispatch request. Simpler than `review-dispatch.mjs#planReviewDispatch`: no `laneRepo` to resolve
 * (this agent acquires no lane in any repo) and no sibling-checkout existence check (it reaches everything
 * through `gh`, never a local clone).
 * @param {{pr:number|string, repo:string}} o
 * @returns {{pr:number, repo:string, repoKey:string, sessionSlug:string}}
 */
export function planInspectDispatch({ pr, repo } = {}) {
  const prNum = Number(pr);
  if (!Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(`stuck-pr-inspect-dispatch: --pr must be a positive integer, got ${JSON.stringify(pr)}`);
  }
  const repoStr = String(repo ?? '').trim();
  const repoKey = repoKeyForSlug(repoStr);
  if (repoKey === null) throw new Error(`stuck-pr-inspect-dispatch: --repo ${repoStr} is not a constellation repo`);
  return { pr: prNum, repo: CONSTELLATION_REPOS[repoKey].slug, repoKey, sessionSlug: inspectSessionSlug(prNum, repoKey) };
}

const NO_INSPECTION_STARTED = Symbol('no-inspection-started');

/** Tag an error as proving no agent started (read back by {@link noInspectionStarted}). Exported for tests. */
export function markNoInspectionStarted(e) {
  const err = e instanceof Error ? e : new Error(String(e));
  err[NO_INSPECTION_STARTED] = true;
  return err;
}

/**
 * Does this {@link dispatchInspection} error PROVE no agent was started? True only for a failure before the
 * spawn, or a spawn refused before `claude` ran (`isPreSpawnRefusal`: ENOENT/EACCES). Every other failure is
 * INDETERMINATE — the session may exist — so the stuck-PR watch must not reopen the episode for it (PR #2553).
 * @param {unknown} e
 * @returns {boolean}
 */
export function noInspectionStarted(e) {
  return Boolean(e && e[NO_INSPECTION_STARTED]);
}

/**
 * DISPATCH ONE INSPECTION SESSION. The composition: plan → fill the brief → mint a fresh session id → spawn.
 * @param {object} o
 * @param {number|string} o.pr
 * @param {string} o.repo
 * @param {string} o.stage - one of `we:scripts/conveyor/stuck-pr-watch-core.mjs#STUCK_STAGES`.
 * @param {number} o.minutesSince
 * @param {number} o.thresholdMinutes
 * @param {string} [o.root]
 * @param {(root?:string) => string} [o.readBrief]
 * @param {() => string} [o.mintSessionId]
 * @param {Function} [o.spawnAgent]
 * @param {string[]} [o.extraArgs]
 * @returns {{sessionId:string, agentId:string|null, sessionSlug:string, pr:number, repo:string, repoKey:string, prompt:string, unknownTokens:string[]}}
 */
export function dispatchInspection({
  pr, repo, stage, minutesSince, thresholdMinutes, root = REPO_ROOT,
  readBrief = (r) => readFileSync(inspectBriefPath(r), 'utf8'),
  mintSessionId = () => randomUUID(),
  spawnAgent = defaultSpawnAgent,
  extraArgs = [],
  // #x8mpubm follow-up — this dispatch never wired the gh-app-shim either, the same gap fixed in
  // `review-dispatch.mjs#dispatchReview` and `reconcile-fix-dispatch.mjs#dispatchFix`.
  resolveSettingsEnv = resolveGhShimSettingsEnv,
} = {}) {
  // Everything before the spawn is pre-spawn: a throw here PROVES no agent exists (see noInspectionStarted).
  const prepare = () => {
    const planned = planInspectDispatch({ pr, repo });
    assertNotALaneCheckout(root);
    const { prompt, unknownTokens } = fillInspectBrief(readBrief(root), {
      PR: planned.pr,
      REPO: planned.repo,
      SESSION_SLUG: planned.sessionSlug,
      STAGE: stage,
      MINUTES_SINCE: Math.round(Number(minutesSince)),
      THRESHOLD_MINUTES: thresholdMinutes,
    });
    const sessionId = String(mintSessionId());
    const argv = buildAgentArgv({
      sessionId,
      payload: { prompt, sessionSlug: planned.sessionSlug },
      systemPromptFile: INSPECT_DISPATCH_SYSTEM_PROMPT_FILE,
      extraArgs: [...inspectDispatchDisallowedToolsArgs(), ...extraArgs],
      settingsEnv: resolveSettingsEnv(root),
    });
    return { planned, prompt, unknownTokens, sessionId, argv };
  };
  let prepared;
  try { prepared = prepare(); } catch (e) { throw markNoInspectionStarted(e); }
  const { planned, prompt, unknownTokens, sessionId, argv } = prepared;
  let stdout;
  try {
    stdout = String(spawnAgent(argv, { cwd: root }) ?? '');
  } catch (e) {
    // Only ENOENT/EACCES prove `claude` never ran. A timeout or non-zero exit may still have started a session.
    throw isPreSpawnRefusal(e) ? markNoInspectionStarted(e) : e;
  }
  const agentId = parseBackgroundedId(stdout);
  return {
    sessionId, agentId, sessionSlug: planned.sessionSlug, pr: planned.pr, repo: planned.repo, repoKey: planned.repoKey,
    prompt, unknownTokens,
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  try {
    const result = dispatchInspection({
      pr: flag('pr'), repo: flag('repo'), stage: flag('stage'),
      minutesSince: flag('minutes-since'), thresholdMinutes: flag('threshold-minutes'),
      extraArgs: agentArgsFromEnv(),
    });
    writeAllSync(
      1,
      (result.agentId
        ? `stuck-pr-inspect-dispatch: started agent ${result.agentId} (slug ${result.sessionSlug}) inspecting `
          + `${result.repo}#${result.pr}\nwatch it: claude agents --json | grep ${result.agentId}   # or: claude logs ${result.agentId}\n`
        : `stuck-pr-inspect-dispatch: started a session (slug ${result.sessionSlug}) inspecting ${result.repo}#${result.pr}, `
          + 'but could NOT read its id off `claude --bg`\'s output\n'
          + `watch it by name: claude agents --json | grep ${result.sessionSlug}\n`)
      + (result.unknownTokens.length ? `note: unrecognized brief tokens (reported, not fatal): ${result.unknownTokens.join(', ')}\n` : ''),
    );
  } catch (e) {
    writeLineSync(2, `error: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
