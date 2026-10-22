#!/usr/bin/env node
/**
 * bootstrap-session.mjs — make a machine ready to work the constellation, idempotently.
 *
 * WHY THIS EXISTS. The instruction layer already travels: `AGENTS.md` is committed, so any session that
 * opens this repo reads the rules. MACHINE STATE does not travel. A fresh Claude Code cloud VM has the
 * repo on disk and nothing else wired: `~/.claude/skills/` is empty of this repo's skills, so `/drain`,
 * `/jury`, `/pr` and the rest are inert; the sibling repos of the constellation are not cloned; and the
 * lane pool the laptop relies on does not exist and should not. Every VM session so far has rediscovered
 * that by hand, differently. This script is the one answer, in code rather than prose — prose gets
 * half-followed, an idempotent script cannot be.
 *
 * HOST-AWARE, because the right setup differs. On the LAPTOP the lane pool, the reserved memory lane and
 * the user-level guard are the environment, and a skills deploy is deliberately scoped so a WE-specific
 * orchestration skill never leaks into an unrelated repo (see sync-skills-deploy.mjs). On an EPHEMERAL VM
 * none of that holds: there are no unrelated repos and the box is reclaimed on idle, so this script writes
 * freely rather than asking consent about state nothing outlives.
 *
 * WHAT IS *NOT* DIFFERENT — and this paragraph used to say the opposite. It claimed the branch guard "is not
 * installed", so "provisioning a pool costs an `npm ci` per lane and buys nothing". Both halves are false.
 * The USER-LEVEL installer (#3074) is skipped, but `guard-lane.mjs` itself ships in the COMMITTED
 * `.claude/settings.json` `PreToolUse` hooks and denies every `Edit`/`Write` to a primary checkout here
 * exactly as on a laptop — so a lane is the ONLY writable surface, and a pool is required rather than
 * pointless. (`--reference` against the `--depth 1` clones was also *fatal* rather than merely unhelpful,
 * and the pool root mis-derived from `$HOME`; both fixed in `lane-pool.mjs` by #3265.) The `lanes` step below
 * still SKIPS — a `SessionStart` hook must not block for minutes cloning lanes — but it now names the
 * command instead of explaining why you do not need one.
 *
 * WHERE THIS LIVES IS NOT WHERE IT STAYS. The lane and delivery machinery this sets up is Plateau's
 * product; WE is a PUBLIC peer that happens to dogfood it, not the constellation's hub. So nothing here
 * hard-codes its own home: the checkout it is in is DERIVED (`selfKey`), the siblings come from the shared
 * constellation table rather than a local literal, and the skills CLI is looked up self-then-siblings so
 * the two halves can move in either order. Relocating this file should be a `git mv`, not a rewrite.
 *
 * WHAT IT NEVER DOES. It does not clone the sibling repos: in a cloud session they arrive through the
 * harness's `add_repo` + credential-proxied clone, which no script here can or should perform. It reports
 * which are missing and names the tool. It does not touch the reserved memory lane or repoint the
 * machine-global memory symlink — that is #2350's supervised, human-gated half, and a script that moved
 * it silently would be the wipe that decision exists to prevent.
 *
 * CONSENT: A DURABLE HOST IS REPORTED ON, NEVER MUTATED IMPLICITLY. The committed project SessionStart hook
 * means this runs the moment anyone opens the repo, so a default run must not reach outside the repository.
 * On a workstation it reports what it would do and stops; `install` is the explicit opt-in, `uninstall` the
 * reverse. An ephemeral cloud VM writes freely — its `$HOME` is a container reclaimed on idle, so there is
 * no durable state to consent about, and the value of a session that configures itself is the whole point.
 *
 * Usage:
 *   node scripts/bootstrap-session.mjs             # report; applies only on an ephemeral host
 *   node scripts/bootstrap-session.mjs --check     # report drift only, write nothing; exit 1 if any
 *   node scripts/bootstrap-session.mjs --dry-run   # print the plan, write nothing; exit 0
 *   node scripts/bootstrap-session.mjs --json      # machine-readable summary on stdout
 *   node scripts/bootstrap-session.mjs --laptop    # force the non-ephemeral plan (override detection)
 *   node scripts/bootstrap-session.mjs --ephemeral # force the ephemeral plan (override detection)
 *   node scripts/bootstrap-session.mjs install     # apply on ANY host (the explicit opt-in)
 *   node scripts/bootstrap-session.mjs uninstall   # drop the SessionStart registration
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLineSync } from './lib/write-all-sync.mjs';
import { CONSTELLATION_REPOS, repoKeyForDir, siblingKeys } from './lib/constellation-repos.mjs';
import { readGitIdentity, identityVerdict, resolveGitIdentityPlaceholders, GIT_IDENTITY_FIX_HINT, invokedAsScript } from './lib/git-identity.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The path segment that marks a checkout as a lane clone rather than a primary. */
const LANE_MARKER = `${sep}.lanes${sep}`;

/**
 * The lane pool a checkout belongs to, or `null` when it is not a lane clone at all. PURE.
 *
 * `<workspace>/.lanes/<pool>/lane-N`. WHICH SEGMENT IDENTIFIES THE REPO matters and is easy to get wrong:
 * it is the POOL, never `lane-N` and never the workspace. `lane-pool.mjs` derives the pool name from the
 * origin URL basename, so it names the repo the pool was cloned from — which is exactly the question every
 * caller below is really asking. Parsing FORWARD from the marker also survives a caller standing in a
 * subdirectory of a lane (`…/lane-9/scripts`), where counting backwards from the end reads `lane-9` as the
 * pool.
 */
export function lanePool(root = REPO_ROOT) {
  const path = String(root);
  const i = path.indexOf(LANE_MARKER);
  if (i < 0) return null;
  const [pool, lane] = path.slice(i + LANE_MARKER.length).split(sep);
  // A bare `<workspace>/.lanes/<pool>` is the pool DIRECTORY, not a clone inside it — nobody works there,
  // and treating it as one would answer for a checkout that does not exist.
  return pool && lane ? { workspace: path.slice(0, i), pool } : null;
}

/**
 * Which constellation repo is this checkout part of? DERIVED, never assumed.
 *
 * This script must survive its own relocation. The lane and delivery machinery is Plateau's product, and WE
 * — a PUBLIC peer, not a hub — is where it happens to be dogfooded today; the move is a `git mv`, and
 * anything that hard-coded "I am WE, my siblings are the other two" would silently invert on the day it
 * happened (reporting WE as a missing sibling of itself). Asking the shared table which checkout we are in
 * costs one basename lookup and makes the move free. PURE over a root.
 *
 * FROM A LANE CLONE THE BASENAME IS `lane-9`, WHICH NAMES NOTHING (#xsarpbt). That is not an exotic case: a
 * lane clone is where agent work actually happens, so it is the common one. Reading the basename there
 * produced `null`, and `null` is not inert — `siblingKeys(null)` returns the WHOLE table, so the bootstrap
 * reported the checkout it was standing in as an unrecognised repo AND as a missing sibling of itself, in
 * the same breath. The honest reading of that output is "this environment is broken", when nothing is. So a
 * lane resolves through its POOL, which is the repo identity the lane was cloned from.
 */
export function selfKey(root = REPO_ROOT) {
  const lane = lanePool(root);
  return repoKeyForDir(lane ? lane.pool : basename(root));
}

/**
 * The constellation members this checkout expects beside it, with the path each should occupy. Resolved
 * relative to the CURRENT repo's parent rather than the table's `$HOME/workspace` literals, because the
 * laptop and a cloud VM disagree about that prefix and both are correct.
 *
 * FROM A LANE THERE ARE TWO PLAUSIBLE PARENTS, and both are in live use — so both are probed rather than one
 * being declared canonical:
 *   · beside the PRIMARY checkout (`dirname(primaryCheckout(root))`) — the laptop's arrangement: siblings sit
 *     in `~/workspace`, with the pool a `.lanes` subtree beneath it.
 *   · beside the LANE ITSELF (`dirname(root)`, i.e. the pool directory) — what this repo's cloud VMs actually
 *     do: `.lanes/web-everything/` holds `lane-1…3` AND the `frontierui`/`plateau-app` clones, because the
 *     lanes are what needs to reach them.
 *
 * MEASURED, NOT REASONED. Resolving from the primary alone is the tidier rule and it is wrong here: a
 * `--dry-run` from lane-1 on the VM reported both siblings MISSING under it, and both PRESENT once the pool
 * directory was probed as well. A non-lane checkout collapses the two parents to one, so nothing changes for
 * a primary. The FALLBACK path — what gets reported when a sibling is genuinely absent — stays the
 * primary-relative one, because that is where an operator should put it.
 */
export function siblingsFor(root = REPO_ROOT, exists = existsSync) {
  const parents = constellationParents(root, exists);
  return siblingKeys(selfKey(root)).map((key) => {
    const dirs = CONSTELLATION_REPOS[key].dirs;
    const found = parents.flatMap((parent) => dirs.map((d) => join(parent, d))).find((p) => exists(p));
    return { name: key, path: found ?? join(parents[0], dirs[0]), present: Boolean(found) };
  });
}

/** The parents a constellation member may sit under — see {@link siblingsFor} for why there are two. PURE. */
function constellationParents(root = REPO_ROOT, exists = existsSync) {
  return [...new Set([dirname(primaryCheckout(root, exists)), dirname(root)])];
}

/**
 * The basename ALIASES a constellation member is missing — the directory names its peers resolve it by, that
 * do not exist beside it.
 *
 * WHY THIS IS NOT COSMETIC. `constellation-repos.mjs` records that WE answers to two directory names
 * (`web-everything` from the clone slug, `webeverything` on the laptop) precisely because both are in live
 * use. That table is consulted by TOOLING; the BUILD CONFIGS of the other two repos resolve their peers by a
 * hard-coded basename instead — `frontierui/vite.config.mts` does `resolve(__dirname, '../webeverything')`,
 * and plateau-app's tsconfig `paths` and FUI's intent-resolver plugin do the same. A cloud VM clones from the
 * slug, so WE lands at `web-everything` and every one of those resolutions misses.
 *
 * The failure is not subtle and it is not deferred: `vite.config.mts` cannot LOAD, so plateau-app's dev server
 * dies at config load with `Could not resolve "../../../webeverything/webtraits/intentProfileResolver"` before
 * serving a module. It is the #1202 cold-start class of bug, one repo over.
 *
 * The `siblings` step above cannot see any of this — it asks whether a DIRECTORY EXISTS, answers yes for a
 * checkout whose configs cannot resolve their peers, and reports `ok`. That false green is what this step
 * exists to close (observed 2026-08-24: `ok siblings frontierui, plateau-app` on a VM where plateau-app's
 * cold start was broken).
 *
 * Reported as `drift`, not `missing`: unlike an absent sibling — which needs the harness's `add_repo` and so
 * is the operator's move — an alias is machine state this script can compute and create, which is the same
 * conclusion #3074 reached for the guard path. PURE over `exists`.
 */
export function aliasesFor(root = REPO_ROOT, exists = existsSync) {
  return constellationParents(root, exists).flatMap((parent) =>
    Object.values(CONSTELLATION_REPOS).flatMap(({ dirs }) => {
      // PER-PARENT, and the target is only ever a checkout in the SAME directory as the link. The first cut
      // searched the parents in priority order for one target and then linked it beside whichever parent won
      // — so with a lane, whose two parents diverge, the alias landed beside the primary while the sibling
      // that needed it sat in the pool directory, and the step still reported `ok`. That is the very
      // false-green this file is fixing, reintroduced one level down (PR #1537 correctness juror).
      const target = dirs.map((d) => join(parent, d)).find((p) => exists(p));
      // Nothing here to alias. Deliberately NOT resolved from another parent: a `webeverything` in the pool
      // directory pointed at the primary checkout — or at one arbitrary lane — would silently cross a
      // sibling's build over into a tree it does not belong to, which is worse than the missing link. A pool
      // whose own sibling clones cannot resolve their peers is `lane-pool.mjs`'s provisioning to fix.
      if (!target) return [];
      return dirs
        .map((d) => join(parent, d))
        .filter((p) => p !== target)
        .map((path) => ({ name: basename(path), path, target, present: exists(path) }));
    }));
}

/**
 * Is this an ephemeral cloud VM rather than a durable workstation?
 *
 * PURE over an env bag so the plan is testable without a container. The signals are the runner's own, not
 * guesses: `CLAUDE_CODE_CONTAINER_ID` is stamped per cloud container, and `CCR_AGENT_PROXY_ENABLED` marks
 * the credential-proxied egress only the managed environment sets. Either alone is sufficient — requiring
 * BOTH would fail closed the moment the runner renames one, and failing closed here means the laptop plan
 * (lane pool, guard) runs on a VM that has neither.
 */
export function detectHost(env = process.env) {
  const signals = [];
  if (env.CLAUDE_CODE_CONTAINER_ID) signals.push('CLAUDE_CODE_CONTAINER_ID');
  if (env.CCR_AGENT_PROXY_ENABLED === '1') signals.push('CCR_AGENT_PROXY_ENABLED');
  return { ephemeral: signals.length > 0, signals };
}

/**
 * Where memory lives, both candidates, derived exactly as check-memory.mjs derives them (#2301).
 *
 * Kept as ONE function rather than a second copy of the `replace(/\//g, '-')` project key, so the
 * bootstrap can never disagree with the checker about which directory it is reporting on.
 */
export function memoryDirs(root = REPO_ROOT, home = homedir()) {
  return {
    user: join(home, '.claude', 'projects', root.replace(/\//g, '-'), 'memory'),
    repo: join(root, '.claude', 'agent-memory'),
  };
}

/**
 * The steps this host needs, as data. PURE — the runner performs them; `--dry-run` and `--check` print
 * them. Every skip carries its REASON, because a silently-absent step is indistinguishable from a step
 * that ran and did nothing.
 */
export function planSteps({ ephemeral, root = REPO_ROOT, home = homedir(), exists = existsSync } = {}) {
  const mem = memoryDirs(root, home);
  const steps = [];

  // Skills. `--all` bootstraps a machine that has none of them; the scoped default exists to protect a
  // real workstation's ~/.claude/skills from gaining WE orchestration skills it should not carry.
  steps.push({
    id: 'skills',
    title: ephemeral ? 'deploy every skill to ~/.claude/skills (--all)' : 'sync already-deployed skills',
    argv: ephemeral ? ['--all'] : [],
  });

  // Commands are the half that had no deploy path at all: `.claude/commands/*.md` are live only in a session
  // whose PRIMARY directory is this repo, so from a sibling, a lane, or any VM the twenty slash commands
  // silently did not exist. `--all` on both hosts: unlike a skill, a command is inert until invoked by name,
  // so deploying one the operator never types costs nothing, while NOT deploying it is the whole bug.
  steps.push({ id: 'commands', title: 'deploy .claude/commands to ~/.claude/commands (--all)', argv: ['--all'], cli: 'sync-commands-deploy.mjs' });

  // Memory. Nothing to INSTALL: check-memory.mjs and memory-resolve.mjs both fall back to the in-repo
  // `.claude/agent-memory` symlink, which git carries into any clone. The user-level dir is the LAPTOP's
  // reserved-lane arrangement (#2350) and is never created or repointed from here.
  steps.push({
    id: 'memory',
    title: 'verify memory resolves',
    verify: () =>
      exists(mem.user) ? { via: 'user', dir: mem.user } : exists(mem.repo) ? { via: 'repo', dir: mem.repo } : null,
  });

  // Siblings. Reported, never cloned — see the header.
  steps.push({
    id: 'siblings',
    title: 'report constellation siblings',
    verify: () => siblingsFor(root, exists),
  });

  // Basename aliases. UNLIKE the siblings above this one is APPLIED, because it is machine state this script
  // can compute rather than a repo only the harness can fetch — see {@link aliasesFor}. It rides the same
  // `write` consent as every other effect here: reported on a durable host, applied on an ephemeral one.
  steps.push({
    id: 'aliases',
    title: 'reconcile constellation basename aliases',
    verify: () => aliasesFor(root, exists),
  });

  steps.push(
    ephemeral
      ? {
          id: 'lanes',
          title: 'lane pool',
          // STILL SKIPPED, but for a different reason and with a different message — the old one was wrong on
          // every clause and, being the first thing a cloud session reads, it was actively misleading.
          //
          // It said: no branch guard to work around, shallow clones share nothing via `--reference`, a pool
          // buys nothing. In fact `guard-lane.mjs` ships in the COMMITTED `.claude/settings.json` PreToolUse
          // hooks, so it denies every write to a primary checkout here exactly as on a laptop — which means a
          // session that believes this message has NO writable surface at all and cannot make the edit it was
          // opened to make. (`--reference` on a shallow clone was also fatal rather than merely useless; both
          // that and the pool-root derivation are fixed in `lane-pool.mjs` as of #3265, so provisioning now
          // works here with no env override and no manual `fetch --unshallow`.)
          //
          // Why still a SKIP and not a provision: this runs as a `SessionStart` hook, and provisioning clones
          // two lanes plus their siblings and installs deps — minutes of blocking before the operator can type
          // anything, on every session, including the many that only read. The cost is real and the command is
          // one line, so the honest trade is to state it rather than pay it unasked. What was broken was never
          // that the step skipped; it was that it said the wrong thing about why.
          skip: 'ephemeral host: the pool is NOT provisioned for you (a SessionStart hook must not block for '
            + 'minutes), but you DO need one — the committed guard-lane.mjs hook denies every Edit/Write to a '
            + 'primary checkout here, so a lane is the only writable surface. Run: '
            + '`node scripts/lane-pool.mjs provision --count=2` (two: review-pr\'s juror refuses the lane you '
            + 'drive from, #3151). See docs/agent/vm-sessions.md.',
        }
      : {
          id: 'lanes',
          title: 'lane pool',
          skip: 'owned by lane-pool.mjs — run `node scripts/lane-pool.mjs provision --count=N` yourself',
        },
  );

  steps.push(
    ephemeral
      // The USER-LEVEL guard installer (#3074) is what is skipped — never the guard itself, which ships in the
      // committed `.claude/settings.json` and is already enforcing here. The old wording ("there is no pool
      // here") implied the opposite and paired with the `lanes` message above to tell a cloud session it could
      // edit the primary. It cannot.
      ? { id: 'guard', title: 'lane guard', skip: 'ephemeral host: no USER-level install needed — the committed project hook already enforces lane isolation here' }
      : { id: 'guard', title: 'lane guard', info: 'check with `node scripts/guard-lane-install.mjs status`' },
  );

  // Laptop only: a lane clone reads objects from the primary's `.git` via `--reference`, so that directory
  // needs an explicit grant. No lanes on an ephemeral host, so nothing to grant there.
  if (!ephemeral) steps.push({ id: 'gitdir', title: 'grant the primary checkout .git', gitDir: join(primaryCheckout(root), '.git') });

  // BOTH HOSTS, unlike `gitdir`. An ephemeral VM has no pool yet, so `trustableDirs` returns just its own
  // checkout — and that checkout still needs trusting, or the CLI ignores the committed allow-list there too.
  // The step is idempotent and re-derives the lane list every run, so provisioning a pool later is picked up
  // by the next session rather than needing its own command.
  steps.push({ id: 'trust', title: 'trust this repo\'s checkouts (so the committed allow-list applies)', trustDirs: trustableDirs(root, exists) });

  return steps;
}

/**
 * The PRIMARY checkout, given any checkout — a lane clone resolves to the checkout it was cloned from.
 *
 * Same derivation `guard-lane-install.mjs` makes for the guard path, and for the same reason: a lane is
 * reset and recycled, so anything registered from inside one silently stops resolving. PURE.
 */
export function primaryCheckout(root = REPO_ROOT, exists = existsSync) {
  const lane = lanePool(root);
  if (!lane) return root;
  const { workspace } = lane;
  // `<workspace>/.lanes/<pool>/lane-N`. The POOL name is derived by lane-pool.mjs from the origin URL
  // basename (`web-everything`), which is NOT necessarily the directory the primary checkout occupies (the
  // laptop's is `webeverything` — the same divergence guard-lane-install.mjs hard-codes around). So the pool
  // name identifies the REPO, and the primary's directory is then PROBED among that repo's known basenames.
  // Deriving it instead of probing produced a path that resolves nowhere, silently.
  const dirs = CONSTELLATION_REPOS[selfKey(root) ?? '']?.dirs;
  if (!dirs) return workspace;
  return dirs.map((d) => join(workspace, d)).find((p) => exists(p)) ?? join(workspace, dirs[0]);
}

/**
 * Grant the primary checkout's `.git` to the agent, at USER level, derived rather than typed.
 *
 * A lane is cloned with `--reference <primary>`, so git in a lane reads objects out of the primary's
 * `.git` — which sits outside the lane and needs an explicit grant. That grant lived as an absolute
 * `/Users/<name>/...` literal inside the COMMITTED `.claude/settings.json`, which made it wrong for
 * everyone else and dead in every cloud VM. It is machine state, so it belongs in machine-level settings,
 * computed from where the checkout actually is. PURE.
 */
export function withPrimaryGitDir(settings, gitDir, known = []) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  next.permissions = next.permissions ?? {};
  const dirs = Array.isArray(next.permissions.additionalDirectories) ? next.permissions.additionalDirectories : [];
  // Repair, not accumulate: a moved checkout must not leave a dead grant beside the live one. But the set we
  // may drop is ONLY the ones this script could itself have written — the `.git` of a constellation checkout
  // at a path we can name. The first cut matched any string ending in `/.git`, which silently REVOKED an
  // operator's hand-added grant for an unrelated repo on the next run (converge finding, 2026-08-18). A
  // grant we cannot prove is ours is the operator's, and is left alone.
  const ours = new Set([gitDir, ...known]);
  next.permissions.additionalDirectories = [...dirs.filter((d) => !ours.has(d)), gitDir];
  return next;
}

/**
 * Every `.git` path this script could have written on this machine — the constellation checkouts it knows
 * about, in both of the directory names each answers to. Used as the "is this grant ours?" set above, so
 * repair stays exact instead of matching by suffix.
 */
export function knownGitDirs(root = REPO_ROOT) {
  const parent = dirname(primaryCheckout(root));
  return Object.values(CONSTELLATION_REPOS).flatMap((m) => m.dirs.map((d) => join(parent, d, '.git')));
}

/**
 * The PR-watch tools, pre-approved so a session can subscribe without a permission prompt.
 *
 * WHY IT BELONGS HERE AND NOT IN A LIVE `$HOME`. Watching a PR is needed on exactly the host whose `$HOME`
 * does not survive: a cloud VM is reclaimed on idle, so an allow rule added by hand is gone by the next
 * session and gets re-approved by hand every time. That is machine state, which is what this script exists
 * to make travel.
 *
 * ONLY THE STABLE NAMES ARE LISTED, and the omission is deliberate. An MCP tool's permission name embeds its
 * SERVER id, and this harness also serves these two from a session-scoped server whose id is a bare uuid
 * (`mcp__<uuid>__subscribe_pr_activity`). That id is derivable from nothing in the repo — there is no
 * `.mcp.json` here — so committing one would be the same defect as the `/Users/<name>/…` literal this file's
 * header describes: right on one machine, wrong everywhere else, and silently dead in the next VM. The
 * `mcp__github__` pair is the name that is identical on every host, so it is the one that travels.
 */
export const PR_WATCH_TOOLS = Object.freeze([
  'mcp__github__subscribe_pr_activity',
  'mcp__github__unsubscribe_pr_activity',
]);

/**
 * Add tool names to `permissions.allow`, additively. PURE.
 *
 * PURELY ADDITIVE, UNLIKE {@link withPrimaryGitDir}, and the difference is worth stating rather than leaving
 * to be inferred. That function REPAIRS — it drops a stale grant it can prove it wrote — because a moved
 * checkout leaves a dead absolute path behind. Nothing here goes stale: a tool name is not a path, so an
 * entry this script wrote last month is exactly as valid today. There is therefore nothing to prune, and
 * pruning is the only way this could ever remove an allow rule an operator added by hand. It cannot, by
 * construction — which is the property that matters, since `permissions.allow` is the operator's list.
 *
 * Idempotent: re-running adds nothing and reorders nothing.
 */
export function withToolAllowlist(settings, tools = PR_WATCH_TOOLS) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  next.permissions = next.permissions ?? {};
  const allow = Array.isArray(next.permissions.allow) ? next.permissions.allow : [];
  const missing = tools.filter((t) => !allow.includes(t));
  next.permissions.allow = missing.length ? [...allow, ...missing] : allow;
  return next;
}

/** Which of {@link PR_WATCH_TOOLS} a settings object does not yet allow. PURE. */
export function missingToolAllows(settings, tools = PR_WATCH_TOOLS) {
  const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  return tools.filter((t) => !allow.includes(t));
}

/**
 * Decide (and, when permitted, apply) the PR-watch allow step, in the SAME status vocabulary the `gitdir`
 * step uses — `ok` / `drift` / `planned`.
 *
 * THE VOCABULARY IS THE POINT, not the shape. `--check` exits non-zero on `drift` and on nothing else, so a
 * step is only covered by the drift gate if it speaks that word. `gitDirStatus` exists in this file for the
 * identical reason; a second answer to "how does a step report" is how one of them ends up outside the gate.
 *
 * `drift` is reserved for READ-ONLY runs, where the rule genuinely is missing and stays missing. A run that
 * may write reports `ok` because it just fixed it, and `planned` is the `--dry-run` case: nothing was written
 * and nothing is being claimed about the end state.
 *
 * @param {{settings: object|null, write: boolean, dryRun?: boolean, apply?: (s: object) => void}} o
 * @returns {{id: string, status: 'ok'|'drift'|'planned', detail: string}}
 */
export function toolAllowStatus({ settings, write, dryRun = false, apply } = {}) {
  const missing = missingToolAllows(settings);
  const id = 'pr-watch';
  if (!missing.length) return { id, status: 'ok', detail: `already allowed: ${PR_WATCH_TOOLS.join(', ')}` };
  if (dryRun) return { id, status: 'planned', detail: `would allow ${missing.join(', ')}` };
  if (!write) {
    return { id, status: 'drift', detail: `NOT allowed: ${missing.join(', ')} — run \`npm run bootstrap:install\`` };
  }
  if (typeof apply === 'function') apply(withToolAllowlist(settings));
  return { id, status: 'ok', detail: `allowed ${missing.join(', ')}` };
}

// ── Output style ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The operator's chosen response style — the built-in `Concise` ("responds tersely, leading with results and
 * skipping preamble and narration").
 *
 * WHY IT TRAVELS WITH THE OTHER MACHINE STATE. Same argument as {@link PR_WATCH_TOOLS} verbatim: it is a
 * `~/.claude/settings.json` key, so on the host whose `$HOME` does not survive it is re-chosen by hand every
 * session or simply lost. A VM session that configures itself is the whole point of this script; a preference
 * the operator has already stated is exactly the kind of state it exists to carry.
 */
export const OUTPUT_STYLE = 'Concise';

/**
 * Set `outputStyle` in a settings OBJECT. PURE.
 *
 * WRITES ONLY INTO THE ABSENCE, and that restraint is the whole design rather than caution. `outputStyle` is a
 * SINGLE-VALUED key, unlike `permissions.allow` — there is no additive form of setting it, so the only way to
 * apply it over an existing value is to overwrite a choice the operator made. {@link withToolAllowlist} can
 * promise it never removes an operator's entry because appending is available to it; this cannot, so it
 * declines instead. A settings file that already names a style is left exactly as it stands, whatever it says.
 *
 * Idempotent: re-running over a settings object that already carries any style changes nothing.
 */
export function withOutputStyle(settings, style = OUTPUT_STYLE) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  if (typeof next.outputStyle === 'string' && next.outputStyle.trim()) return next;
  next.outputStyle = style;
  return next;
}

/** The style a settings object already names, or '' when it names none. PURE. */
export function currentOutputStyle(settings) {
  const v = settings?.outputStyle;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * Decide (and, when permitted, apply) the output-style step, in the SAME `ok` / `drift` / `planned` vocabulary
 * {@link toolAllowStatus} and `gitDirStatus` use — see that function for why speaking the vocabulary, rather
 * than merely reporting, is what puts a step inside `--check`'s drift gate.
 *
 * A settings file that already names a style — ANY style, not only this one — is `ok`, not `drift`. Reporting
 * drift there would be this script telling the operator their own stated preference is wrong, and `--check`
 * would then exit non-zero on a machine that is configured exactly as its owner intended.
 *
 * @param {{settings: object|null, write: boolean, dryRun?: boolean, apply?: (s: object) => void}} o
 * @returns {{id: string, status: 'ok'|'drift'|'planned', detail: string}}
 */
export function outputStyleStatus({ settings, write, dryRun = false, apply } = {}) {
  const id = 'style';
  const current = currentOutputStyle(settings);
  if (current) return { id, status: 'ok', detail: `already set: ${current}` };
  if (dryRun) return { id, status: 'planned', detail: `would set outputStyle: ${OUTPUT_STYLE}` };
  if (!write) {
    return { id, status: 'drift', detail: `NOT set: outputStyle — run \`npm run bootstrap:install\`` };
  }
  if (typeof apply === 'function') apply(withOutputStyle(settings));
  return { id, status: 'ok', detail: `set outputStyle: ${OUTPUT_STYLE}` };
}

// ── SessionStart hook registration (user level, absolute path — the #3074 shape) ───────────────────────

export const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
export const BOOTSTRAP_PATH = join(REPO_ROOT, 'scripts', 'bootstrap-session.mjs');

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('bootstrap-session.mjs');

/**
 * Add or repair the SessionStart entry in a settings OBJECT. PURE.
 *
 * Idempotent by IDENTITY, not by count: an entry naming this script is replaced, so re-running after the
 * checkout moves REPAIRS the path rather than leaving a second, stale registration that resolves nowhere.
 */
export function withBootstrapHook(settings, scriptPath = BOOTSTRAP_PATH) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  next.hooks = next.hooks ?? {};
  const list = Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [];
  next.hooks.SessionStart = list
    .map((block) => (Array.isArray(block?.hooks) ? { ...block, hooks: block.hooks.filter((h) => !isOurs(h)) } : block))
    .filter((block) => !Array.isArray(block?.hooks) || block.hooks.length > 0);
  next.hooks.SessionStart.push({ hooks: [{ type: 'command', command: `node ${scriptPath}` }] });
  return next;
}

/** Remove every bootstrap entry, wherever it sits. PURE. */
export function withoutBootstrapHook(settings) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  if (!Array.isArray(next.hooks?.SessionStart)) return next;
  next.hooks.SessionStart = next.hooks.SessionStart
    .map((block) => (Array.isArray(block?.hooks) ? { ...block, hooks: block.hooks.filter((h) => !isOurs(h)) } : block))
    .filter((block) => !Array.isArray(block?.hooks) || block.hooks.length > 0);
  return next;
}

/** Which bootstrap commands a settings object registers, and whether each resolves. PURE over a probe. */
export function bootstrapStatus(settings, exists = existsSync) {
  const found = [];
  for (const block of settings?.hooks?.SessionStart ?? []) {
    for (const h of block?.hooks ?? []) {
      if (!isOurs(h)) continue;
      const path = String(h.command).replace(/^node\s+/, '').trim();
      found.push({ path, resolves: exists(path), absolute: path.startsWith('/') });
    }
  }
  return found;
}

// ── workspace trust (#xtrust1) ────────────────────────────────────────────────────────────────────────

/**
 * The CLI's own config, which is NOT `~/.claude/settings.json`.
 *
 * Two files, two owners, and conflating them is the trap: `settings.json` holds hooks and permission RULES,
 * while `.claude.json` holds per-directory workspace state — including `hasTrustDialogAccepted`. Nothing in
 * `settings.json` can grant trust, so the `gitdir` step above (which writes `settings.json`) cannot fix the
 * failure this one exists for.
 */
export const TRUST_PATH = join(homedir(), '.claude.json');

/**
 * Every checkout of this constellation that an agent may be launched INTO, so each can be trusted. PURE over
 * its three injected probes (`exists`, `readdir`, `realpath`) — it reaches no real filesystem of its own.
 *
 * WHY LANES AND NOT JUST THE PRIMARY. An untrusted workspace makes the CLI **ignore the repo's committed
 * `.claude/settings.json` allow-list** — it says so on startup: *"Ignoring N permissions.allow entries …
 * this workspace has not been trusted."* Every agent this repo dispatches works in a LANE, never the
 * primary (the committed `guard-lane.mjs` hook denies writes there), so the trusted checkout was the one
 * directory no agent uses and every lane it does use was untrusted. Measured 2026-08-25, before this step
 * existed: 40 of 40 lanes `false`, primary `true` — a figure that cannot be re-measured now that the step
 * has run, since running it is what flipped them. Each such agent re-asked permission for work the repo
 * already allows, and a background one has nobody to ask — it simply stops.
 *
 * A lane is a clone of a repo the operator has already trusted, provisioned by `lane-pool.mjs` on their own
 * machine. Trusting it grants nothing the primary did not already grant; it stops silently WITHDRAWING it.
 *
 * THE POOL IS ENUMERATED FROM EITHER ROOT, and that is the whole point of {@link poolRoots}. An earlier cut
 * enumerated it only when the root it ran in was ITSELF a lane, which quietly made the step useless exactly
 * where it is installed: the registered `SessionStart` hook runs `scripts/bootstrap-session.mjs` out of the
 * PRIMARY checkout, and `npm run bootstrap install` — the remediation this step itself prints — is run there
 * too. Both reported `ok — 1 checkout(s) already trusted` while every lane stayed untrusted.
 */
export function trustableDirs(root = REPO_ROOT, exists = existsSync, readdir = readdirSync, realpath = realpathNative) {
  const dirs = [primaryCheckout(root, exists)];
  for (const poolRoot of poolRoots(root, exists)) {
    for (const name of listDir(poolRoot, readdir)) {
      if (/^lane-/.test(name)) dirs.push(join(poolRoot, name));
    }
  }
  // EXISTS-FILTERED **THEN CANONICALISED**, and both halves are load-bearing rather than tidy.
  //
  // `primaryCheckout` PROBES among the repo's known directory basenames and falls back to the first when
  // none is found, so from a lane on a machine whose primary is `webeverything` it can hand back
  // `web-everything`. The exists filter drops that when it resolves NOWHERE.
  //
  // But on the laptop it resolves: this same script's `aliases` step creates `web-everything` as a SYMLINK
  // to `webeverything`, so `exists` says true and the alias sails through. `~/.claude.json` keys `projects`
  // on the literal cwd string, and the CLI's cwd is the real path — so trusting the alias writes an entry
  // the CLI never consults, reports `trusted N of N`, and leaves the real primary untouched. Canonicalising
  // before the de-dupe collapses the alias and the real checkout to ONE key, which is the entry that counts.
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!exists(d)) continue;
    const real = canonical(d, realpath);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out.sort();
}

/**
 * The lane-pool directories whose lanes belong to this checkout — derived from EITHER a lane root or the
 * primary, because the step has to work from both. PURE over `exists`.
 *
 * From a lane the pool is known exactly (`lanePool` parses it out of the path). From a non-lane checkout it
 * is PROBED, the same way {@link primaryCheckout} probes for the primary's directory: the pool name is the
 * origin-URL basename `lane-pool.mjs` cloned under, which is one of the repo's known basenames but not
 * necessarily the one the checkout itself occupies (the laptop's pool is `.lanes/web-everything` beside a
 * primary named `webeverything`). A checkout that is not a constellation repo, or a fresh VM with no pool
 * yet, yields nothing — correct there, and the step runs again once someone provisions one.
 */
function poolRoots(root = REPO_ROOT, exists = existsSync) {
  const lane = lanePool(root);
  const candidates = lane
    ? [join(lane.workspace, '.lanes', lane.pool)]
    : (CONSTELLATION_REPOS[selfKey(root) ?? '']?.dirs ?? []).map((d) => join(dirname(root), '.lanes', d));
  return [...new Set(candidates)].filter((p) => exists(p));
}

/**
 * `realpathSync.native`, but never throwing. A path can vanish between the `exists` probe and here, and a
 * bootstrap step that dies on that race would take the whole session hook down with it; falling back to the
 * literal path is the same answer the code gave before canonicalising existed.
 */
const realpathNative = (p) => { try { return realpathSync.native(p); } catch { return p; } };

/** Canonicalise through an injected probe, tolerating a probe that throws. PURE over `realpath`. */
function canonical(p, realpath) {
  try { return realpath(p); } catch { return p; }
}

/**
 * List a directory through an injected probe, tolerating one that throws. PURE over `readdir`.
 *
 * The `exists` probe and the `readdir` probe are separate handles and a caller may inject an optimistic one
 * (the installer's own test double answers `true` for every path). A pool root that `exists` claims and
 * `readdir` cannot open must contribute no lanes, not take the session hook down with an ENOENT.
 */
function listDir(p, readdir) {
  try { return readdir(p); } catch { return []; }
}

/**
 * Mark each directory trusted in a `.claude.json` OBJECT. PURE.
 *
 * ADDITIVE AND SURGICAL. It sets exactly one boolean per directory and creates the entry when absent; it
 * never removes a project, never touches another key, and never sets the flag to `false`. Un-trusting is the
 * operator's to do by hand, because a bootstrap that could withdraw trust on a bad derivation is a bootstrap
 * that can lock an agent out of every lane at once.
 */
export function withTrustedDirs(config, dirs = []) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  next.projects = next.projects ?? {};
  for (const dir of dirs) {
    next.projects[dir] = { ...(next.projects[dir] ?? {}), hasTrustDialogAccepted: true };
  }
  return next;
}

/** Which of `dirs` are not yet trusted. PURE. */
export function untrustedDirs(config, dirs = []) {
  const projects = config?.projects ?? {};
  return dirs.filter((d) => projects[d]?.hasTrustDialogAccepted !== true);
}

/**
 * The counterpart {@link withTrustedDirs} deliberately does NOT offer (see that function's own doc: "a
 * bootstrap that could withdraw trust on a bad derivation is one that can lock an agent out of every lane at
 * once"). That reasoning is about the `SessionStart` BOOTSTRAP step, which derives its dir list by PROBING the
 * filesystem (`trustableDirs`) — a wrong probe there really could delist a lane still in use. This function is
 * for a DIFFERENT caller with a DIFFERENT, much narrower blast radius (card #4188, bornAs `x5qketq`, epic
 * #4075): the session reaper's dispatch-scratch cleanup, which only ever passes EXACT, already-deleted
 * `.operations/dispatch/<uuid>` directory paths it minted and just removed itself — never a probed or derived
 * list, never a lane or primary checkout. PURE, same shape as {@link withTrustedDirs}: deep-clones rather than
 * mutates, deletes exactly the given project keys, and touches nothing else.
 * @param {object|null} config
 * @param {string[]} [dirs]
 * @returns {object}
 */
export function withoutTrustedDirs(config, dirs = []) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  if (next.projects && typeof next.projects === 'object') {
    for (const dir of dirs) delete next.projects[dir];
  }
  return next;
}

/**
 * The `trust` step's decision, in the same `planned`/`ok`/`drift` vocabulary every other step reports. PURE.
 *
 * @param {{dirs: string[], config: object|null, write: boolean, dryRun?: boolean}} o
 * @returns {{status: string, detail: string, grant: boolean}}
 */
export function trustStatus({ dirs = [], config, write, dryRun = false } = {}) {
  if (dryRun) return { status: 'planned', detail: `${dirs.length} checkout(s)`, grant: false };
  const missing = untrustedDirs(config, dirs);
  if (!missing.length) return { status: 'ok', detail: `${dirs.length} checkout(s) already trusted`, grant: false };
  if (!write) {
    return {
      status: 'drift',
      detail: `${missing.length} of ${dirs.length} checkout(s) NOT trusted — the repo's committed allow-list is `
        + 'being IGNORED there, so a background agent stalls on a permission prompt with nobody to answer it. '
        + 'Run `npm run bootstrap install`',
      grant: false,
    };
  }
  return { status: 'ok', detail: `trusted ${missing.length} of ${dirs.length} checkout(s)`, grant: true };
}

// ── io ────────────────────────────────────────────────────────────────────────────────────────────────

// ONE GUARDED READER FOR BOTH CONFIG FILES, and the guard is the point rather than the sharing.
//
// This ran as a bare `JSON.parse` per call site. `~/.claude.json` is the CLI's OWN, actively-written state
// file, and this script runs as a `SessionStart` hook on a machine where dozens of lanes start sessions
// close together — so a read that lands mid-write throws, and the throw propagates out of `main()` and
// takes the WHOLE bootstrap down: skills, commands, memory, siblings, aliases, gitdir and trust alike. One
// unusable config file must cost its own step and nothing else (review finding, 2026-08-26).
//
// ABSENT IS `{}`; PRESENT-BUT-UNUSABLE IS `null`, and the two are deliberately different answers. `{}` says
// "nothing here yet, build it" — the correct read of a first run. Returning `{}` for a file that IS there
// but did not parse would say the same thing to a writer, which would then rebuild `~/.claude.json` from an
// empty object and take the operator's every-repo CLI state with it (a `.bak` copy of a file we could not
// parse is thin comfort). `null` says "present, unusable", and every caller below reports it and writes
// nothing.
export function readJsonConfig(path, exists = existsSync, read = (p) => readFileSync(p, 'utf8')) {
  if (!exists(path)) return {};
  let parsed;
  try { parsed = JSON.parse(read(path)); } catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** What a step reports when its config file is there but unusable. Never a write. */
export const unreadableConfig = (path) =>
  `${path} is present but does not parse as JSON — this step read nothing and wrote nothing rather than `
  + 'rebuilding that file from an empty object. Every other step still ran. Fix or move it aside, then '
  + 're-run `npm run bootstrap install`.';

const readSettings = () => readJsonConfig(SETTINGS_PATH);

const readTrust = () => readJsonConfig(TRUST_PATH);

/**
 * Write `~/.claude.json`, backing the previous copy up first.
 *
 * The backup is not ceremony here: this file holds the operator's whole per-project CLI state — history,
 * onboarding flags, MCP approvals — for every repo on the machine, not just this one. A bad write costs far
 * more than the `settings.json` one, so it gets the same `.bak` treatment and the same single-key discipline
 * in {@link withTrustedDirs}.
 */
function writeTrust(next) {
  if (existsSync(TRUST_PATH)) copyFileSync(TRUST_PATH, `${TRUST_PATH}.bak`);
  writeFileSync(TRUST_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function writeSettings(next) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  if (existsSync(SETTINGS_PATH)) copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak`);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function installHook() {
  const before = readSettings();
  if (before === null) return `NOT registered — ${unreadableConfig(SETTINGS_PATH)}`;
  if (bootstrapStatus(before).some((f) => f.path === BOOTSTRAP_PATH && f.resolves)) return 'already registered';
  writeSettings(withBootstrapHook(before));
  return `registered in ${SETTINGS_PATH}`;
}

function uninstallHook() {
  const before = readSettings();
  if (before === null) return `NOT removed — ${unreadableConfig(SETTINGS_PATH)}`;
  if (!bootstrapStatus(before).length) return `not registered in ${SETTINGS_PATH}`;
  writeSettings(withoutBootstrapHook(before));
  return `removed from ${SETTINGS_PATH} (previous saved to ${SETTINGS_PATH}.bak)`;
}

/**
 * Where the skills deploy CLI lives — THIS checkout only. PURE over a probe.
 *
 * An earlier cut searched sibling constellation checkouts too, so the two halves could move to Plateau
 * independently. That was a cross-repo CODE EXECUTION path: siblings arrive on a cloud VM through the
 * harness's `add_repo`, are not vetted by this repo, and whatever `sync-skills-deploy.mjs` was found got
 * `execFileSync`'d with full privileges on every run — including the automatic SessionStart one, with no
 * provenance check (converge finding, 2026-08-18). The convenience it bought was one commit's worth of
 * ordering freedom during a relocation that has not happened yet and is properly handled by the
 * multi-project registry (#2472). Deleted rather than defended: a missing CLI now reports and skips.
 */
export function skillsDeployScript(root = REPO_ROOT, exists = existsSync, cli = 'sync-skills-deploy.mjs') {
  const here = join(root, 'scripts', cli);
  return exists(here) ? here : null;
}

/** Shell the existing skills CLI — never reimplement its deploy, prune or tracked-file rules. */
function runSkills(script, argv, { write }) {
  const args = [script, ...argv, ...(write ? [] : ['--check'])];
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { encoding: 'utf8' }).trim().split('\n').at(-1) };
  } catch (e) {
    // sync-skills-deploy --check exits 1 on drift; that is a REPORT, not a failure of this script.
    return { ok: false, out: String(e.stdout || e.message).trim().split('\n').at(-1) };
  }
}

function describe(step) {
  if (typeof step.detail === 'string') return step.detail;
  if (step.id === 'memory') {
    return step.detail ? `${step.detail.via} → ${step.detail.dir}` : 'NO memory dir — /note and memory-resolve will fail';
  }
  return step.detail
    .map((s) => `${s.name}${s.present ? '' : ' (MISSING — attach with the harness `add_repo` tool, then clone)'}`)
    .join(', ');
}

/**
 * The `git-identity` step: `drift` when the effective author/committer is a placeholder (`test`, `*@example.com`, …)
 * or missing, `ok` otherwise. Never throws; an absent reader (a partial io bag) is `skipped`.
 * @returns {{id:'git-identity', status:'ok'|'drift'|'skipped', detail:string}}
 */
export function gitIdentityStatus({ read, env = process.env, lists } = {}) {
  const id = 'git-identity';
  if (typeof read !== 'function') return { id, status: 'skipped', detail: 'no identity reader' };
  try {
    const v = identityVerdict(read(), lists ?? resolveGitIdentityPlaceholders({ env }));
    return v.status === 'ok'
      ? { id, status: 'ok', detail: v.detail }
      : { id, status: 'drift', detail: `${v.status.toUpperCase()} — ${v.detail} — ${GIT_IDENTITY_FIX_HINT}` };
  } catch (e) {
    return { id, status: 'drift', detail: `could not read the git identity (${e?.message ?? e})` };
  }
}

/**
 * May this run write OUTSIDE the repository — into the machine-global `$HOME/.claude` tree? PURE.
 *
 * The first cut always could, and the committed project SessionStart hook made that automatic: opening this
 * repo in Claude Code silently granted a directory and installed a USER-level hook that then fired in every
 * unrelated repo on that machine (converge finding, 2026-08-18). Consent is the issue, and it is a
 * WORKSTATION issue — on an ephemeral cloud VM `$HOME` belongs to a container that is reclaimed on idle, so
 * there is no durable state to mutate and nothing to consent to. Hence: ephemeral writes freely, a durable
 * host reports and requires the explicit `install` subcommand.
 */
export function mayWriteUserTree({ ephemeral, explicitInstall = false } = {}) {
  return Boolean(ephemeral || explicitInstall);
}

/**
 * What the `gitdir` step should report, and whether it should write. PURE — the decision lives here so it is
 * testable; `main` keeps only the fs calls around it.
 *
 * WHY IT IS ITS OWN FUNCTION. This branch used to sit inline in `main`, which is not exported and has no
 * test, and it reported `planned` for EVERY read-only path. That made `--check`'s documented contract
 * ("report drift only … exit 1 if any") unreachable for this step: a missing grant and a correct one both
 * printed `planned`, and the exit code — which keys off `status === 'drift'` — could never fire. An
 * untestable branch is where that hides, so the branch stopped being untestable.
 *
 * THE THREE PATHS:
 *   - `--dry-run` DESCRIBES what would happen and reads nothing → `planned`;
 *   - any other read-only path (`--check`, and the default report on a durable host) REPORTS STATE
 *     → `ok` when the grant is present, `drift` when it is not;
 *   - a writing path grants when absent and reports `ok` either way.
 *
 * @param {{gitDir: string, settings: object|null, write: boolean, dryRun?: boolean}} o
 * @returns {{status: 'planned'|'ok'|'drift', detail: string, grant: boolean}}
 */
export function gitDirStatus({ gitDir, settings, write, dryRun = false } = {}) {
  if (dryRun) return { status: 'planned', detail: gitDir, grant: false };
  const granted = (settings?.permissions?.additionalDirectories ?? []).includes(gitDir);
  if (!write) {
    return granted
      ? { status: 'ok', detail: `${gitDir} (already granted)`, grant: false }
      : { status: 'drift', detail: `${gitDir} (NOT granted — run \`npm run bootstrap:install\`)`, grant: false };
  }
  return { status: 'ok', detail: `${gitDir}${granted ? ' (already granted)' : ' (granted)'}`, grant: !granted };
}

/**
 * EVERYTHING `main` TOUCHES OUTSIDE ITSELF, as one injectable bag (#3197).
 *
 * The decisions here were already pure and tested — `gitDirStatus`, `mayWriteUserTree`, `planSteps`. What had
 * no test was the ORCHESTRATION that calls them: which steps run in what order, what `--dry-run` reports
 * without writing, whether a drift actually reaches the exit code. An installer is precisely the code a human
 * runs once and trusts, so the sequencing is the part that must not be wrong, and it was the part nothing
 * pinned. A bag rather than eight parameters because the list will grow, and a caller that must re-list every
 * handle to add one is a caller that starts passing partial bags.
 */
export function defaultIo() {
  return {
    readSettings, writeSettings, readTrust, writeTrust, installHook, uninstallHook, runSkills,
    readGitIdentity: () => readGitIdentity(REPO_ROOT),
    exists: existsSync,
    symlink: (target, path) => symlinkSync(target, path, 'dir'),
    env: process.env,
    out: (line) => writeLineSync(1, line),
  };
}

export function main(argv, io = defaultIo()) {
  const has = (f) => argv.includes(f);
  if (argv[0] === 'uninstall') { io.out(`bootstrap-session: ${io.uninstallHook()}`); return 0; }
  const explicitInstall = argv[0] === 'install';
  const readOnlyFlag = has('--check') || has('--dry-run');
  const detected = detectHost(io.env);
  const ephemeral = has('--ephemeral') ? true : has('--laptop') ? false : detected.ephemeral;
  // `write` now means "may touch $HOME/.claude", not merely "was --check absent".
  const write = !readOnlyFlag && mayWriteUserTree({ ephemeral, explicitInstall });
  const locus = selfKey();
  const report = { host: ephemeral ? 'ephemeral' : 'laptop', locus, signals: detected.signals, writes: write, steps: [] };

  for (const step of planSteps({ ephemeral, exists: io.exists })) {
    if (step.skip) { report.steps.push({ id: step.id, status: 'skipped', detail: step.skip }); continue; }
    if (step.info) { report.steps.push({ id: step.id, status: 'info', detail: step.info }); continue; }
    if (step.gitDir) {
      const dryRun = has('--dry-run');
      const before = dryRun ? null : io.readSettings();
      // `null` here is the UNUSABLE answer, not the `--dry-run` one — see `readJsonConfig`.
      if (!dryRun && before === null) { report.steps.push({ id: step.id, status: 'drift', detail: unreadableConfig(SETTINGS_PATH) }); continue; }
      const decision = gitDirStatus({ gitDir: step.gitDir, settings: before, write, dryRun });
      if (decision.grant) io.writeSettings(withPrimaryGitDir(before, step.gitDir, knownGitDirs()));
      report.steps.push({ id: step.id, status: decision.status, detail: decision.detail });
      continue;
    }
    if (step.trustDirs) {
      const dryRun = has('--dry-run');
      // A SEPARATE FILE from `readSettings`. `~/.claude.json` is the CLI's workspace config; `settings.json`
      // is hooks and permission rules. Reading the wrong one here reports every checkout as untrusted forever.
      const before = dryRun ? null : io.readTrust();
      if (!dryRun && before === null) { report.steps.push({ id: step.id, status: 'drift', detail: unreadableConfig(TRUST_PATH) }); continue; }
      const decision = trustStatus({ dirs: step.trustDirs, config: before, write, dryRun });
      if (decision.grant) io.writeTrust(withTrustedDirs(before, step.trustDirs));
      report.steps.push({ id: step.id, status: decision.status, detail: decision.detail });
      continue;
    }
    if (step.id === 'skills' || step.id === 'commands') {
      const cli = step.cli ?? 'sync-skills-deploy.mjs';
      const script = skillsDeployScript(REPO_ROOT, io.exists, cli);
      if (!script) {
        report.steps.push({ id: step.id, status: 'skipped', detail: `no ${cli} in this checkout — that source of truth is not here` });
        continue;
      }
      if (has('--dry-run')) { report.steps.push({ id: step.id, status: 'planned', detail: `${step.title} via ${script}` }); continue; }
      const r = io.runSkills(script, step.argv, { write });
      report.steps.push({ id: step.id, status: r.ok ? 'ok' : 'drift', detail: r.out });
      continue;
    }
    const v = step.verify();
    // Aliases are the one `verify`-shaped step with an EFFECT. It is a symlink beside a checkout, not a write
    // into the user tree, but it rides the same `write` consent anyway: a durable host that already resolves
    // its peers must not have a second name for one of them appear unasked.
    if (step.id === 'aliases') {
      const absent = v.filter((a) => !a.present);
      if (!absent.length) { report.steps.push({ id: step.id, status: 'ok', detail: v }); continue; }
      if (!write || has('--dry-run')) {
        report.steps.push({
          id: step.id,
          status: has('--dry-run') ? 'planned' : 'drift',
          detail: absent.map((a) => `${a.path} → ${a.target} (NOT linked — run \`npm run bootstrap:install\`)`).join(', '),
        });
        continue;
      }
      const done = [];
      for (const a of absent) {
        // A failure here is REPORTED, never thrown: the bootstrap runs as a SessionStart hook, and a session
        // that refuses to start because a convenience symlink could not be made is worse than the missing link.
        try { io.symlink(a.target, a.path); done.push(`${a.path} → ${a.target}`); }
        catch (e) { done.push(`${a.path} FAILED (${e.code ?? e.message})`); }
      }
      report.steps.push({ id: step.id, status: done.some((d) => d.includes('FAILED')) ? 'drift' : 'ok', detail: done.join(', ') });
      continue;
    }
    const ok = step.id === 'memory' ? Boolean(v) : v.every((s) => s.present);
    report.steps.push({ id: step.id, status: ok ? 'ok' : step.id === 'siblings' ? 'missing' : 'drift', detail: v });
  }

  // Pre-approve the PR-watch tools. Behind the SAME `write` consent as everything else, so a durable host is
  // still only ever reported on: `permissions.allow` is the operator's list, and widening it silently on a
  // laptop is exactly the implicit mutation this script's consent rule exists to prevent. On an ephemeral VM
  // there is nothing to consent about and a session that configures itself is the whole point.
  //
  // IT REPORTS THROUGH `report.steps`, NOT A FIELD OF ITS OWN, and that is load-bearing rather than tidiness.
  // `--check`'s exit code is `report.steps.some((s) => s.status === 'drift')`, so a step that reports beside
  // that array is INVISIBLE to the drift gate: a missing allow rule would print in the summary and still exit
  // 0, which is a checker that reports a problem and passes anyway. This file already paid that lesson down
  // once for the `gitdir` step — its `gitDirStatus` returns the same `planned`/`ok`/`drift` vocabulary for
  // exactly this reason — so the second step to need it reuses the vocabulary instead of inventing one
  // (PR #1520 correctness juror).
  const allowSettings = io.readSettings();
  report.steps.push(allowSettings === null
    ? { id: 'pr-watch', status: 'drift', detail: unreadableConfig(SETTINGS_PATH) }
    : toolAllowStatus({ settings: allowSettings, write, dryRun: has('--dry-run'), apply: io.writeSettings }));

  // A SECOND `readSettings`, deliberately — NOT a reuse of `allowSettings`. The step above may have just
  // written the file, and `writeSettings` REPLACES it wholesale; applying this step over the pre-write object
  // would write back a settings file with the allow rules that step just added stripped out again. Each step
  // that may write reads first, so the last writer never carries a stale copy of an earlier one's work.
  const styleSettings = io.readSettings();
  report.steps.push(styleSettings === null
    ? { id: 'style', status: 'drift', detail: unreadableConfig(SETTINGS_PATH) }
    : outputStyleStatus({ settings: styleSettings, write, dryRun: has('--dry-run'), apply: io.writeSettings }));

  // The git author every commit from this checkout would carry. REPORT-ONLY, never a write: the identity is the
  // operator's own config. In `report.steps` so `--check`'s drift gate sees it (the 2026-10-05..20 "test" author
  // incident went unnoticed for two weeks precisely because no surface looked).
  report.steps.push(gitIdentityStatus({ read: io.readGitIdentity, env: io.env }));

  // The user-level SessionStart registration is the most invasive thing here — it makes this script run in
  // repos that never asked for it — so it is the one effect that NEVER happens implicitly on a durable host.
  if (write) report.hook = io.installHook();

  if (has('--json')) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`bootstrap-session — host: ${report.host}${report.signals.length ? ` (${report.signals.join(', ')})` : ''} · locus: ${report.locus ?? 'UNKNOWN checkout — siblings listed in full'}`);
    for (const s of report.steps) io.out(`  ${s.status.padEnd(8)} ${s.id.padEnd(9)} ${describe(s)}`);
    if (report.hook) io.out(`  hook     SessionStart ${report.hook}`);
    if (!write && !readOnlyFlag) {
      io.out('  — reported only. This host is durable, so nothing under $HOME/.claude was touched;');
      io.out('    run `npm run bootstrap install` to apply, `… uninstall` to undo.');
    }
  }

  return has('--check') && report.steps.some((s) => s.status === 'drift') ? 1 : 0;
}

// `process.exitCode =`, not `process.exit()` — #3061's exit-wraps-call shape discards the callee's flush.
// Shared canonical comparison: the raw `file://${argv[1]}` template skipped main (and its git-identity report) for a
// checkout path with a space or a symlink.
if (invokedAsScript(process.argv[1], import.meta.url)) process.exitCode = main(process.argv.slice(2));
