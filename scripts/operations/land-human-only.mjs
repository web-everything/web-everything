/**
 * @file scripts/operations/land-human-only.mjs
 * @description THE `land-human-only` DECLARATION (card 334) — the operator's sanctioned way to land an approved PR
 *   whose diff touches a workflow or action file, which only a person may land.
 *
 * WHY. The drain refuses to enqueue a PR that changes `.github/workflows/` or `.github/actions/`
 * (`we:scripts/lib/merge-queue-enqueue.mjs#workflowEditHold`: "only a person may land"), and it never adds
 * `ready-to-merge` to one. That guard is right and stays exactly as it is. But when the operator enqueued such a PR
 * by hand, the merge-queue run of `merge-gate` held it on `candidate-label: no "ready-to-merge" label` and GitHub
 * removed it as `failed_checks`. Live: #5298 and #5187 (2026-10-14 22:27Z), both approved with a clear-human ceremony
 * on the head and every required check green. This operation does the person's half the drain may not do, after
 * the drain's own gate reads say every other gate passes.
 *
 *   | step    | kind      | does                                                                             |
 *   |---------|-----------|----------------------------------------------------------------------------------|
 *   | `read`  | `compute` | the PR on its live head: pinned change list, the drain's gate rows, required checks, mergeability, queue state, the operator login |
 *   | `plan`  | `compute` | THE VERDICT: every gate, then the plan (label → enqueue → verify → comment)      |
 *   | `write` | `effect`  | re-checks the head, labels, enqueues with the operator's credential, verifies, comments |
 *
 * WHAT IT REFUSES (a thrown error naming why; nothing is written):
 *   - an actor that is not a registered operator login, a blank `--reason`, a blank or multi-line `--channel`;
 *   - an operator credential that does not resolve, or resolves to a login that is not an operator's;
 *   - a PR that is not open, is a draft, or does not target the default branch;
 *   - a PR whose pinned change list touches no workflow or action file (the drain lands those);
 *   - any `hold` or `fail-closed` row from the drain's own merge-time gates on the exact head
 *     (`we:scripts/lib/merge-gate-ci.mjs#evaluatePrGates`) — this includes review acceptance, which for this
 *     kind of PR needs the clear-human ceremony at this exact head. The only allowance: when `ready-to-merge` is
 *     absent and the drain's own labelling decision (`labelOnGreenVerdict`) would add it, the gates are read
 *     with it present, because this operation applies it;
 *   - required checks not all green on the head, or the required set unreadable;
 *   - a conflicting PR, or one whose mergeability GitHub has not computed yet.
 * A PR already in the merge queue is not refused: nothing is written.
 *
 * RUN ONLY ON AN EXPLICIT OPERATOR INSTRUCTION:
 *   node scripts/operations/run.mjs land-human-only --pr=<n> --actor=<login> --channel=<where you said it> --reason='<your words>' [--dry-run]
 * `--dry-run` reads every gate and prints the plan; it writes nothing.
 *
 * PURE. The reader and the sink live in `./land-human-only-io.mjs`.
 */

import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

export const LAND_HUMAN_ONLY_OP = 'land-human-only';
export const LAND_HUMAN_ONLY_EFFECT = 'github.land-human-only';
export const LAND_HUMAN_ONLY_MARKER = '<!-- land-human-only -->';
export const READY_LABEL = 'ready-to-merge';
export const DEFAULT_REPO = CONSTELLATION_REPOS.we.slug;

/** Gate-row statuses that are not a hold: decided elsewhere (the queue, the enqueue) or passed. */
const PASSING_ROW_STATUSES = new Set(['pass', 'queue', 'enqueue', 'skipped-by-policy']);

const isOperator = (login) => OPERATOR_LOGINS.includes(String(login ?? '').trim().toLowerCase());
const short = (sha) => String(sha ?? '').slice(0, 9);

/**
 * The gates, in order. Each is `{id, ok, detail}`. PURE over the `read` finding.
 * @param {object} read
 * @returns {Array<{id:string, ok:boolean, detail:string}>}
 */
export function evaluateLandGates(read) {
  const r = read && typeof read === 'object' ? read : {};
  const gates = [];
  const add = (id, ok, detail) => gates.push({ id, ok: !!ok, detail: String(detail) });

  add('operator-credential', !r.credentialError && isOperator(r.operatorLogin),
    r.credentialError ? `operator credential unreadable: ${r.credentialError}`
      : isOperator(r.operatorLogin) ? `enqueue runs as ${r.operatorLogin}`
        : `the operator credential is ${r.operatorLogin || 'nobody'}, not a registered operator login (${OPERATOR_LOGINS.join(', ')})`);

  const pr = r.pr ?? {};
  const openOk = pr.state === 'OPEN' && !pr.isDraft && !!r.defaultBranch && pr.baseRefName === r.defaultBranch;
  add('open-on-default-branch', openOk, openOk ? `open, base ${pr.baseRefName}`
    : `state ${pr.state ?? '?'}${pr.isDraft ? ', draft' : ''}, base ${pr.baseRefName ?? '?'} vs default ${r.defaultBranch ?? '?'}`);

  const surface = r.surface ?? {};
  const surfaceOk = surface.hold === true && surface.humanOnly === true;
  add('human-only-surface', surfaceOk, surfaceOk ? `touches ${(surface.paths ?? []).join(', ')}`
    : surface.hold === true ? `change list unreadable: ${surface.error ?? 'unknown'}`
      : 'the pinned diff touches no workflow or action file — not a human-only PR; the drain lands it');

  const labelOk = r.labelPresent === true || r.labelDecision?.label === true;
  add('ready-to-merge-label', labelOk, r.labelPresent ? `${READY_LABEL} present`
    : r.labelDecision?.label ? `${READY_LABEL} absent; the drain's labelling decision would add it`
      : `${READY_LABEL} absent and the drain's labelling decision refuses it${r.labelDecision?.reason ? ` (${r.labelDecision.reason})` : ''}`);

  const rows = Array.isArray(r.gateRows) ? r.gateRows : null;
  const blocking = rows ? rows.filter((row) => !PASSING_ROW_STATUSES.has(row?.status)) : [];
  add('drain-gates', !!rows && !r.gateRowsError && blocking.length === 0,
    r.gateRowsError || !rows ? `drain gate rows unreadable: ${r.gateRowsError ?? 'not read'}`
      : blocking.length ? blocking.map((row) => `${row.id} ${row.status}: ${row.reason}`).join('; ')
        : `${rows.length} gate rows pass on ${short(r.head)}`);

  const ci = r.requiredChecks ?? {};
  add('required-checks-green', ci.allowed === true, ci.allowed === true ? `${(ci.names ?? []).join(', ')} green on ${short(r.head)}`
    : !Array.isArray(ci.names) ? 'required check set unreadable'
      : `${ci.reason ?? 'not green'}: ${(ci.affected ?? []).map((a) => `${a.name} ${a.reason}`).join(', ')}`);

  const mergeOk = pr.mergeable === 'MERGEABLE' && !['DIRTY', 'UNKNOWN'].includes(pr.mergeStateStatus);
  add('not-conflicting', mergeOk, mergeOk ? `MERGEABLE (${pr.mergeStateStatus ?? '?'})`
    : pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN' ? 'GitHub has not computed mergeability yet — re-run'
      : `mergeable ${pr.mergeable ?? '?'}, state ${pr.mergeStateStatus ?? '?'}`);
  return gates;
}

/**
 * THE VERDICT. Validates the instruction, runs every gate, and returns the plan. PURE; throws on a refusal.
 * @param {object} read - the `read` finding.
 * @param {{repo:string, pr:number, actor:string, channel:string, reason:string, 'dry-run'?:boolean}} input
 */
export function planLandHumanOnly(read, input) {
  const { actor, channel, reason } = input ?? {};
  if (!isOperator(actor)) throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); only a person may land this`);
  if (!String(reason ?? '').trim()) throw new Error("--reason is required: the operator's instruction, verbatim");
  if (!String(channel ?? '').trim() || /[\r\n]/.test(String(channel))) throw new Error('--channel is required and must be one line');
  if (!/^[0-9a-f]{40}$/.test(String(read?.head ?? ''))) throw new Error('the PR head could not be read');
  const repo = String(read.repo ?? input.repo ?? DEFAULT_REPO);
  const pr = Number(read.number ?? input.pr);
  const gates = evaluateLandGates(read);
  const base = { repo, pr, head: read.head, actor: String(actor).trim().toLowerCase(), channel: String(channel).trim(),
    reason: String(reason), operatorLogin: read.operatorLogin ?? null, dryRun: input['dry-run'] === true, gates };
  if (read.inMergeQueue === true) return { ...base, noop: true, plan: [], summary: `${repo}#${pr} is already in the merge queue — nothing to do` };
  const failed = gates.filter((g) => !g.ok);
  if (failed.length) {
    throw new Error(`land-human-only refuses ${repo}#${pr} at ${short(read.head)}:\n`
      + failed.map((g) => `  ✗ ${g.id}: ${g.detail}`).join('\n'));
  }
  const plan = [
    read.labelPresent ? `${READY_LABEL} already present` : `label ${READY_LABEL}`,
    `enqueue ${repo}#${pr} expectedHeadOid=${read.head} as ${read.operatorLogin}`,
    'verify isInMergeQueue',
    'comment on the PR naming the actor and the instruction',
  ];
  return { ...base, noop: false, addLabel: !read.labelPresent, plan,
    summary: `${repo}#${pr} passes every gate at ${short(read.head)}${base.dryRun ? ' — dry run, nothing written' : ''}` };
}

/** The durable PR comment. PURE. `outcome`: `{queued:boolean, error?:string}`. */
export function buildLandComment(verdict, outcome) {
  const quote = String(verdict.reason).split('\n').map((l) => `> ${l}`).join('\n');
  const status = outcome?.queued ? `✅ queued on GitHub's merge queue (\`isInMergeQueue\` confirmed)` : `✗ not queued: ${outcome?.error ?? 'unknown error'}`;
  return `${LAND_HUMAN_ONLY_MARKER}\n🧑 **Landed on an operator instruction (human-only surface)**\n\n`
    + `Actor: \`${verdict.actor}\` · channel: ${verdict.channel} · head: \`${verdict.head}\` · enqueued as \`${verdict.operatorLogin}\`\n\n`
    + `Instruction:\n${quote}\n\n`
    + `Gates (the drain's own reads on this exact head):\n${verdict.gates.map((g) => `- ${g.ok ? '✓' : '✗'} \`${g.id}\` — ${g.detail}`).join('\n')}\n\n`
    + `Outcome: ${status}`;
}

/** Plain-mode lines for a verdict. PURE. */
export function renderLandVerdict(v) {
  if (!v || !Array.isArray(v.gates)) return [];
  return [`land-human-only ${v.repo}#${v.pr} @ ${short(v.head)} (actor ${v.actor}, channel ${v.channel})`,
    ...v.gates.map((g) => `  ${g.ok ? '✓' : '✗'} ${g.id}: ${g.detail}`),
    ...(v.plan?.length ? [`plan${v.dryRun ? ' (dry run — nothing written)' : ''}:`, ...v.plan.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    v.summary ?? ''];
}

/** `finish` for the CLI: the gates and plan first in plain mode. */
export function finishLandOutcome({ run, code, lines, json = false } = {}) {
  if (json || !run?.verdict) return { code, lines };
  return { code, lines: [...renderLandVerdict(run.verdict), '', ...lines] };
}

export function landHumanOnlyOperation({ readLandContext } = {}) {
  if (typeof readLandContext !== 'function') {
    throw new TypeError('land-human-only: needs a `readLandContext({repo, pr})` reader — the real binding is '
      + '`we:scripts/operations/land-human-only-io.mjs`.');
  }
  return op(LAND_HUMAN_ONLY_OP, {
    input: {
      pr: 'number',
      repo: { type: 'string', required: false, default: DEFAULT_REPO },
      actor: 'string',
      channel: 'string',
      reason: 'string',
      'dry-run': { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr'],
      fn: (view) => readLandContext({ repo: view.input.repo, pr: view.input.pr }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.actor', 'input.channel', 'input.reason', 'input.dry-run', 'findings.read'],
      fn: (view) => planLandHumanOnly(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict'],
      // NOT idempotent: it posts a comment. The sink re-reads the PR first, and a PR already queued is a no-op.
      effects: (view) => (view.verdict.dryRun || view.verdict.noop ? [] : [{
        type: LAND_HUMAN_ONLY_EFFECT, idempotent: false,
        payload: { verdict: view.verdict },
      }]),
    }),
  });
}
