/**
 * converge-transports.mjs — the TRANSPORT contract for the convergence loop (#xztipiw).
 *
 * The convergence core (`we:scripts/lib/converge-core.mjs`) decides WHAT to do next. A transport says WHERE the
 * material comes from and WHERE a revision goes. Those are the only two things that differ between converging a
 * parked pull request and converging uncommitted work in a lane clone.
 *
 * EXACTLY TWO MEMBERS, ON PURPOSE. An earlier draft of this contract also carried `snapshot` / `checkpoint` /
 * `restore` / `allowedWriteSet`. A jury flagged that as premature generalization: four shared concepts sized for
 * a third caller that does not exist, and stubs on one of the two implementations. Round-boundary bookkeeping
 * that only ONE transport needs stays private to that transport — it does not belong in shared vocabulary.
 *
 * ONE IMPLEMENTATION, ALSO ON PURPOSE. Only `working-tree` ships here, because only `/converge` calls it. The
 * `pr-branch` implementation arrives with the item that actually migrates `we:scripts/workflows/review-parked-prs.mjs`
 * onto this core — writing it now would be a second unused generalization, the same mistake one layer down.
 *
 * PURITY. Both members are pure BUILDERS: they return a description of the effect to perform, never perform it.
 * `readMaterial` returns a shell command for the caller to run; `applyRevision` returns an agent prompt for the
 * caller to spawn. So the transport is unit-testable, and the caller (a Workflow harness, or a main-session
 * skill) owns every side effect. This is the same split the core makes — reasoning here, effects there.
 */

import { isAbsolute } from 'node:path';
import { buildEditorMandate } from './review-core.mjs';
import { laneRootFromCwd } from '../guard-bash.mjs';

/**
 * VALIDATE THE WRITE/READ TARGET before any command is built (PR #1064 review, blocker 2). Pure — the caller
 * does the `git rev-parse` and the `realpath` and hands the answers in, so this stays unit-testable.
 *
 * `/converge`'s trigger is "converge the current work", so an agent NOT standing in a lane clone naturally
 * passes its cwd — the SHARED primary checkout where every concurrent session's uncommitted work lives. Four
 * distinct ways that used to get through, all now refused:
 *   • a bare `--lane` (no `=`) parses to boolean `true`, which is truthy — the only check there was;
 *   • a RELATIVE `--lane=lane-4` resolves against the driver's cwd, i.e. the primary checkout;
 *   • the primary checkout itself, passed absolutely;
 *   • a SUBDIRECTORY of a repo — git then discovers the enclosing repo, so `git diff` returns the whole
 *     enclosing repo's diff while `git ls-files` stays scoped to the subdir, and the panel judges the wrong
 *     repo with an arbitrary subset of its new files silently missing.
 *
 * The lanes-root test is `laneRootFromCwd` (`we:scripts/guard-bash.mjs`, the #2367 lane matcher) — reused, not
 * re-derived. It returns the `…/.lanes/<repo>/lane-N` root a path sits at OR UNDER, so requiring it to EQUAL the
 * lane's own realpath rejects the primary checkout (never under `.lanes/`) and a subdirectory in one test.
 *
 * @param {{lane: *, realpath?: string|null, toplevel?: string|null}} o
 *   `realpath` — the lane's resolved real path (symlinks followed); `toplevel` — `git -C <lane> rev-parse
 *   --show-toplevel`, resolved, or null when the call failed / it is not a repo.
 * @returns {{ok: true, laneRoot: string}|{ok: false, error: string}}
 */
export function validateLaneTarget({ lane, realpath = null, toplevel = null } = {}) {
  if (typeof lane !== 'string' || !lane.trim()) {
    return { ok: false, error: '--lane=<path to the lane clone> is required and must carry a value (a bare `--lane` parses to `true`)' };
  }
  if (!isAbsolute(lane)) {
    return { ok: false, error: `--lane must be an ABSOLUTE path — "${lane}" would resolve against the driver's cwd, which is normally the shared primary checkout` };
  }
  const real = realpath || lane;
  if (!toplevel) {
    return { ok: false, error: `--lane "${lane}" is not a git repository (no \`git rev-parse --show-toplevel\`)` };
  }
  if (toplevel !== real) {
    return { ok: false, error: `--lane "${lane}" is a SUBDIRECTORY of the repo at "${toplevel}" — git would discover the enclosing repo and the panel would judge the wrong tree. Pass the repository root.` };
  }
  const laneRoot = laneRootFromCwd(real);
  if (laneRoot !== real) {
    return { ok: false, error: `--lane "${lane}" is not a lane clone (expected a \`…/.lanes/<repo>/lane-N\` root). /converge never reads or writes a shared primary checkout — provision a lane with \`node scripts/lane-pool.mjs status --json\`.` };
  }
  return { ok: true, laneRoot: real };
}

/**
 * The contract every transport must satisfy: a NAME plus the two behavioural members. `validateTransport`
 * ITERATES this descriptor rather than restating it (PR #1064 review, cosmetic 2) — a hardcoded second copy of
 * the same three checks made the declared contract inert: adding a member changed nothing, and the test still
 * passed because it only re-read the constant.
 *
 * "Exactly two members" refers to the two BEHAVIOURS (`readMaterial` / `applyRevision`). `transport` is the
 * registry key, not a third behaviour — spelled out here so the descriptor and the header no longer appear to
 * disagree.
 */
export const TRANSPORT_CONTRACT = Object.freeze({
  required: Object.freeze(['transport', 'readMaterial', 'applyRevision']),
  /** member → the type it must have, and the shape a caller can expect. Drives `validateTransport`. */
  members: Object.freeze({
    transport: Object.freeze({ type: 'string', shape: 'a non-empty registry name' }),
    readMaterial: Object.freeze({ type: 'function', shape: '(ctx) => { kind, command }' }),
    applyRevision: Object.freeze({ type: 'function', shape: '({ findings, round, roundCap, ctx }) => { kind, prompt }' }),
  }),
});

/**
 * Validate a transport implementation. Pure; never throws — a malformed transport must surface as a structured
 * result at its own boundary, not crash the loop three layers in. Derived entirely from `TRANSPORT_CONTRACT`.
 * @param {*} transport
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateTransport(transport) {
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    return { valid: false, errors: ['transport must be a non-null object'] };
  }
  const errors = [];
  for (const member of TRANSPORT_CONTRACT.required) {
    const spec = TRANSPORT_CONTRACT.members[member];
    const value = transport[member];
    const ok = spec.type === 'string' ? (typeof value === 'string' && !!value) : typeof value === spec.type;
    if (!ok) errors.push(`transport.${member} must be a ${spec.type} (${spec.shape})`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Shell-quote a single argument for safe interpolation into a `bash -c` command string. A lane path or a base
 * ref reaches these builders from a caller's argument, so it is never pasted raw.
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The write-target clause for the WORKING-TREE editor — the ONE instruction that says where a revision goes.
 * It REPLACES `buildEditorMandate`'s default PR-clone clause rather than being appended after it (PR #1064
 * review, blocker 3): appending produced a prompt carrying both "clone the PR branch, commit and push" and
 * "edit in place, never push", and an editor handed both either discarded its fixes with a temp clone or pushed,
 * breaking this skill's headline promise. Exported so the test can assert the PR-clone clause is ABSENT.
 */
export const WORKING_TREE_WRITE_TARGET = [
  'Do your writing IN PLACE in the lane clone named in the "Where you are working" section below — that working',
  'tree IS the material under review. Do NOT clone anything, do NOT commit, do NOT push, and do NOT open a PR:',
  'this loop revises work in the tree, and whether it ever becomes a commit or a PR is the human\'s call.',
].join(' ');

/**
 * THE WORKING-TREE TRANSPORT — converge the work in a lane clone, before any PR exists.
 *
 * Reads the lane's whole change against its fork point: committed lane commits AND uncommitted edits, in one
 * diff, because pre-PR work is normally a mix of both and reviewing only half of it would be worse than not
 * reviewing at all.
 *
 * THE READ IS GENUINELY READ-ONLY (PR #1064 review, blocker 1). An earlier draft made untracked files visible by
 * running `git ls-files --others -z | xargs -0 git add --intent-to-add`, and never restored the index. That is a
 * repo-wide index mutation dressed as a read: with intent-to-add entries present, `git restore <path>` TRUNCATES
 * a swept file to 0 bytes, `git stash` fails `Entry '<path>' not uptodate`, so every `pull --ff-only --autostash`
 * in the repo dies, and a later `git add -u` commits the full contents of files a peer session left in the tree.
 * The command below touches NO git state at all: tracked work comes from `git diff <forkpoint>`, and each
 * untracked file is rendered with `git diff --no-index /dev/null <file>`, which reads two paths and writes
 * nothing. That also removes the need for the `--all`-avoidance dance entirely — nothing is ever staged.
 *
 * NO `|| true` ANYWHERE (PR #1064 review, blocker 5). A discarded exit status turned a FAILED read into a
 * successful-looking PARTIAL one: with committed work present the diff is non-empty, the core sees `read.ok`, and
 * the panel judges material missing every brand-new file. The only tolerated non-zero status is `git diff
 * --no-index`'s exit 1, which means "the two paths DIFFER" — the normal case, not an error. Anything above 1
 * aborts the whole read, and `pipefail` propagates a failed enumeration.
 *
 * `git -C <root>`, NEVER a leading `cd` (PR #1064 review, blocker 2). A `cd` into a SUBDIRECTORY of a repo lets
 * git discover the enclosing repo, so `git diff` returns the enclosing repo's whole diff while `git ls-files`
 * stays scoped to cwd — the panel judges the wrong repo with an arbitrary subset of its new files missing. `-C`
 * plus the CLI's toplevel check makes that unreachable. (The untracked pass runs inside a `( cd … )` SUBSHELL so
 * the `--no-index` paths stay repo-relative in the diff headers; `--no-index` reads the filesystem directly and
 * never discovers a repo.)
 */
export const WORKING_TREE_TRANSPORT = Object.freeze({
  transport: 'working-tree',

  /**
   * @param {{laneRoot: string, baseRef?: string}} ctx
   * @returns {{kind: 'shell', command: string, cwd: string}}
   */
  readMaterial({ laneRoot, baseRef = 'origin/main' } = {}) {
    const root = shellQuote(laneRoot);
    const base = shellQuote(baseRef);
    // `git diff <forkpoint>` compares the WORKING TREE to the fork point, so committed and uncommitted work both
    // appear. `--no-index` then appends each untracked file as an add-diff, so a brand-new file — the single most
    // common thing an unfinished change adds — is never invisible to the panel.
    const untracked = [
      `git -C ${root} ls-files --others --exclude-standard -z`,
      `( cd ${root} && while IFS= read -r -d '' f; do `
        + `git --no-pager diff --no-index -- /dev/null "$f"; s=$?; [ "$s" -le 1 ] || exit "$s"; `
        + `done )`,
    ].join(' | ');
    return {
      kind: 'shell',
      cwd: laneRoot,
      command: [
        'set -o pipefail',
        `git --no-pager -C ${root} diff "$(git -C ${root} merge-base HEAD ${base})"`,
        untracked,
      ].join(' && '),
    };
  },

  /**
   * The editor's mandate comes from the shared review core — this transport supplies the ONE write-target clause
   * that differs from the PR case (edit in place, never commit, never push) THROUGH `buildEditorMandate`'s
   * `writeTarget` parameter, so the editor is never handed two contradictory write targets. Committing here would
   * take the decision to publish out of the human's hands, which is exactly what `/converge` promises not to do.
   *
   * `fenced: true` puts the juror finding text — untrusted prose about untrusted material, handed to an agent
   * with write tools pointed at a live tree — inside the #2438 labeled data fence.
   *
   * @param {{findings: any[], round: number, roundCap: number, ctx: {laneRoot: string}}} o
   * @returns {{kind: 'agent', prompt: string}}
   */
  applyRevision({ findings = [], round = 1, roundCap, ctx = {} } = {}) {
    const mandate = buildEditorMandate({
      findings, round, roundCap,
      writeTarget: WORKING_TREE_WRITE_TARGET,
      fenced: true,
    });
    const prompt = [
      mandate,
      '',
      '## Where you are working',
      '',
      `Edit the files in the lane clone at \`${ctx.laneRoot}\` **in place**.`,
      '',
      '- Do **not** run `git commit`, `git push`, or `gh pr create`. This loop revises work in the tree; whether it',
      '  ever becomes a commit or a PR is the human\'s call, not yours.',
      '- Do **not** revert or stash changes you did not make — a human may be editing in this clone at the same time.',
      '',
      '## What to return',
      '',
      'Return JSON: `{ "advanced": <true if you changed at least one file>, "dismissed": [{ "summary": "…",',
      '"reason": "…" }] }`. Put every finding you judged NOT real in `dismissed` with a one-line reason — a',
      'finding you neither fixed nor dismissed is a finding silently dropped, which the loop treats as a stall.',
    ].join('\n');
    return { kind: 'agent', prompt };
  },
});

/** The closed registry. `/converge` resolves through here so an unknown name fails at the boundary. */
const REGISTRY = Object.freeze({
  [WORKING_TREE_TRANSPORT.transport]: WORKING_TREE_TRANSPORT,
});

/**
 * Resolve a transport by name. Fails closed: an absent, unknown, or misspelled name returns an error rather than
 * silently defaulting, because defaulting would silently pick where a revision gets WRITTEN.
 *
 * NOTE ON SCOPE — this applies to the CONVERGE entry point only. The judge-only jury path
 * (`we:.claude/skills/jury/`) takes no transport at all: `design-pixels` and `decision-prose` are judged without
 * any convergence loop, so they neither need nor accept one.
 *
 * @param {string} name
 * @returns {{ok: true, transport: object}|{ok: false, error: string, available: string[]}}
 */
export function resolveTransport(name) {
  const available = Object.keys(REGISTRY);
  if (typeof name !== 'string' || !name) {
    return { ok: false, error: 'a transport name is required (no default)', available };
  }
  const found = REGISTRY[name];
  if (!found) return { ok: false, error: `unknown transport "${name}"`, available };
  // GATE on the declared contract (PR #1064 review, cosmetic 2). `validateTransport` was previously never called
  // on any production path, so the contract it checks could only ever be wrong in a test. Resolution is the one
  // choke point every caller passes through, so it is where the check belongs.
  const check = validateTransport(found);
  if (!check.valid) {
    return { ok: false, error: `transport "${name}" does not satisfy the contract: ${check.errors.join('; ')}`, available };
  }
  return { ok: true, transport: found };
}
