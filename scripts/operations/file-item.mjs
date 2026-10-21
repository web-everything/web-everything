/**
 * @file scripts/operations/file-item.mjs
 * @description THE `file-item` DECLARATION — file a new backlog card AND clear it for the conveyor to pull,
 *   as one callable unit (epic #3383's own machinery, "every new backlog item files through the mechanical
 *   conveyor"). Graduated to `main` from `origin/lane/mechanical-dispatcher` per #3548.
 *
 * WHY THIS EXISTS. `we:scripts/operations/scaffold.mjs` already declares the BIRTH of a card, and #3383's own
 * mechanical-delivery-doctrine rule 2 ("mechanical dispatch runs on the card + the generic brief, never a
 * bespoke prompt") already governs BUILD dispatch. Filing was the gap: found live 2026-09-06, when a session
 * driving this epic realized every single item it had filed that session went through a hand-dispatched
 * `Agent`-tool subagent with a bespoke prompt — never through a declared operation, because none covered the
 * FULL filing sequence. `scaffold` alone is not that sequence: it writes the card and stops. A filed item that
 * is never cleared for the conveyor (`we:scripts/conveyor/queue.mjs add`) sits invisible to `planTick` —
 * `we:scripts/conveyor/tick-core.mjs#planTick` builds its five launch lists from `state.queue`'s CLEARED
 * (`buildQueued`) rows ONLY, so an uncleared item, however ready, is never in `decisions.spawnBuilds`. A
 * session that files a card and stops has handed the mechanism nothing to pick up — the exact hand-off gap
 * this operation closes.
 *
 * IT RE-DERIVES NOTHING FROM `scaffold`. The `read` and `plan` steps below call `shapeScaffoldRead` /
 * `planScaffold` (`./scaffold.mjs`) DIRECTLY — same reader shape, same allocator, same refusals
 * (`SCAFFOLD_REFUSALS`), same rendered content. This operation adds exactly one thing scaffold does not do:
 * decide whether the freshly-born card should be cleared for the conveyor, and declare that clearance as a
 * second effect beside the write. A caller who wants scaffold's behaviour with no clearance still has
 * `scaffold` itself — this is not a replacement for it, it is the fuller sequence.
 *
 * WHAT IS STILL, DELIBERATELY, NOT HERE:
 *   - COMPOSING THE CONTENT (title/digest/scope/sizing) inherently needs judgment — an LLM reading the
 *     situation and writing prose. That step cannot be a `compute`/`effect`/`judge`/`confirm` (none of the
 *     four kinds performs open-ended authorship), so it is not removed, only routed correctly: the calling
 *     agent composes the text and passes it as ordinary string inputs, exactly as it already does for
 *     `scaffold` today. This operation starts from "the text already exists."
 *   - LANDING (commit / `verify` / `open-pr`) is NOT folded in here. Those are already declared operations
 *     (`we:scripts/operations/verify.mjs`, `we:scripts/operations/open-pr.mjs`) that apply to every
 *     constellation-repo change, not just a filed card — folding them in would duplicate machinery this file's
 *     own header warns against re-deriving. The skill that owns this operation
 *     (`we:skills-src/file-item/SKILL.md`) states the three-call sequence: `file-item`, then `verify`, then
 *     `open-pr`.
 *   - AN IMMEDIATE DISPATCH ATTEMPT. A freshly-filed item almost never passes `planTick`'s own readiness gate
 *     the instant it is born (unsized epics/decisions can never build at all; a story usually still needs a
 *     lane scope decided and any `blockedBy` cleared) — so a same-call dispatch attempt would be a no-op in
 *     the overwhelming majority of real filings, for the cost of importing the conveyor's live tick machinery
 *     into a operation whose job is to WRITE A CARD. Clearing it via `queueAdd` is what removes the
 *     "wait for a human to remember `queue.mjs add`" step; the next tick's `planTick` still owns the READINESS
 *     decision, exactly as it does for every other cleared item. If a caller genuinely knows an item is
 *     build-ready the instant it is filed, `we:scripts/operations/dispatch-lane.mjs` is the separate declared
 *     call to make next — this operation does not reach into it.
 *
 * QUEUE-AD EFFECT REUSES `we:scripts/conveyor/queue-store.mjs`'s PURE CORE (`addToQueue`) rather than
 * shelling `queue.mjs` — same reason `dispatch-lane.mjs` "reaches nothing" in its own static import graph:
 * the io shell (`./file-item-io.mjs`) is the only place this touches `fs`.
 *
 * NON-DISPATCHABLE KINDS ARE DUPLICATED HERE, NOT IMPORTED, and that is a deliberate, narrow choice, not an
 * oversight: importing the conveyor CLI here would pull IO dependencies into this pure declaration.
 * The agreement test in `./__tests__/file-item.test.mjs` imports keys derived from queue.mjs's actual
 * `NON_DISPATCHABLE` warning map and compares both sets, catching additions or removals on either side.
 *
 * PURE. No fs, no clock, no process, no network. `./file-item-io.mjs` is the only place it touches the world.
 */
import { OPERATOR_TASK_INPUT, OPERATOR_TASK_READS } from '../backlog/operator-task.mjs';
import { op } from './registry.mjs';
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { BACKLOG_KINDS } from '../check-standards-rules.mjs';
import { planScaffold, shapeScaffoldRead, SCAFFOLD_EFFECT } from './scaffold.mjs';
import { setFrontmatterField } from '../backlog/frontmatter.mjs';
import { validatePrepareCard } from '../conveyor/prepare-result.mjs';
import { rankRelatedItems, planRelatedGate, relatedDigestNote, formatRelatedItemsPolicy } from '../lib/related-items-core.mjs';

/** Validate before either filing effect; ordinary scaffold output stays byte-identical. An explicit card
 *  priority (P0..P4) for operator tasks is card #xqqmw6g, with the authority it needs. */
export function planFileItem(read, input, related = null) {
  if (related?.refuse) throw new Error(related.lines.join('\n'));
  input = withNewBecause(input);
  // A filer who named a related card or said why this is new gets that recorded on the card, under the digest.
  const note = relatedDigestNote(input);
  if (note) input = { ...input, digest: `${String(input.digest ?? '').replace(/\s+$/, '')}${input.digest ? '\n\n' : ''}${note}` };
  const verdict = planScaffold(read, input);
  const policy = read.operatorTask;
  if (!input.operatorTask) return verdict;
  // The digest supplies the complete authored body, replacing the scaffold's unfinished agreement.
  verdict.content = verdict.content.slice(0, verdict.content.indexOf('\n# '))
    + `\n# ${input.title}\n\n${input.digest || ''}\n`;
  if (!policy) throw new Error('file-item: operatorTask requires the resolved build policy');
  if (!policy.enabled) return verdict;
  const ready = validatePrepareCard(verdict.content, { operatorTask: true });
  if (!ready.ok) throw new Error(`file-item: missing or incomplete sections: ${ready.missing.join(', ')}`);
  if (!/^[a-f0-9]{40,64}$/.test(read.originMainSha ?? '')) throw new Error('file-item: cannot stamp without origin/main tip');
  verdict.content = setFrontmatterField(verdict.content, 'preparedDate', JSON.stringify(read.today));
  verdict.content = setFrontmatterField(verdict.content, 'preparedAgainstSha', JSON.stringify(read.originMainSha));
  return verdict;
}

export const FILE_ITEM_OP = 'file-item';

/** The CLI spells the reason `--new-because`; the pure core reads `newBecause`. */
const withNewBecause = (input = {}) => (input['new-because'] !== undefined && input.newBecause === undefined
  ? { ...input, newBecause: input['new-because'] } : input);

/**
 * THE RELATED-CARD CHECK (operator 2026-10-21): before the card is written, rank the existing cards against the
 * filing's title + digest (+ scope) with the same pure core as the read-only `related-items` operation. PURE over the
 * injected context; `null` context (no reader bound) or any read failure means "not checked", never a refusal.
 * @returns {ReturnType<typeof planRelatedGate> & {policy: string|null, error?: string}}
 */
export function planRelatedCheck(ctx, input) {
  input = withNewBecause(input);
  if (!ctx) return { ...planRelatedGate({ result: null, policy: null }), policy: null };
  if (ctx.error) return { ...planRelatedGate({ result: null, policy: null }), policy: null, error: ctx.error };
  const policyLine = formatRelatedItemsPolicy(ctx.policy);
  const gateOff = !ctx.policy.enabled || ctx.policy.fileItem === 'off';
  const result = gateOff ? null : rankRelatedItems({
    query: { text: `${input.title ?? ''}\n${input.digest ?? ''}`, scope: input.scope },
    cards: ctx.cards, policy: ctx.policy, today: ctx.today,
  });
  const gate = planRelatedGate({ result, policy: ctx.policy, input });
  return { ...gate, lines: gate.lines.length ? [...gate.lines, `policy: ${policyLine}`] : [], policy: policyLine };
}

/** The CLI trailer: the default outcome lines, plus the related-card warning when the check found any. */
export function finishFileItem({ run, code, lines, json = false }) {
  const related = run?.findings?.related;
  const extra = related?.lines ?? [];
  // A refusal already carries these lines in its own error text; print them once.
  if (json || !extra.length || related.refuse) return { code, lines };
  return { code, lines: [...lines, '', ...extra] };
}

/** The second effect this operation can declare, beside `scaffold`'s own `scaffold.write`. */
export const FILE_ITEM_QUEUE_EFFECT = 'file-item.queue-add';

/**
 * Kinds `we:scripts/conveyor/tick-core.mjs#planTick` can NEVER dispatch a build for, whatever their frontmatter
 * says — mirrors `we:scripts/conveyor/queue.mjs`'s own `NON_DISPATCHABLE` map (see this file's header for why
 * it is a local copy, not an import). Entries are selected from {@link BACKLOG_KINDS}; the agreement test
 * detects drift from the conveyor's warning map.
 */
export const NON_DISPATCHABLE_KINDS = Object.freeze(
  [...BACKLOG_KINDS].filter((k) => k === 'epic' || k === 'decision'),
);

/**
 * Decide whether the just-scaffolded card should be cleared for the conveyor. PURE.
 *
 * REFUSES TO QUEUE, without erroring the whole filing, in three cases — each named on the returned reason so
 * a caller (and the skill) can explain a "filed but not queued" outcome rather than a caller silently getting
 * less than they asked for:
 *   - `input.queue` was explicitly opted out (`"false"`/`"0"`/`""`) — the caller's own call, respected.
 *   - the kind is in {@link NON_DISPATCHABLE_KINDS} — clearing an epic or a decision for a builder queue that
 *     can never build one is a false promise the next tick would just have to explain away.
 *   - the card was born `active` (a `--session` filing, #670) — a half-authored card is deliberately
 *     pool-excluded until `settle`d; auto-queuing it here would offer an unfinished card to the conveyor the
 *     same tick it was born, which is the exact race #670 exists to prevent.
 *
 * @param {{kind:string, status:string}} verdict - the `scaffold` plan's own verdict (kind + birth status).
 * @param {{queue?:string}} input - this operation's own `queue` input (a string flag, CLI-shaped).
 * @returns {{queueing:boolean, reason:string}}
 */
export function planQueueing(verdict, input = {}) {
  const optedOut = ['', '0', 'false', 'no'].includes(String(input.queue ?? 'true').trim().toLowerCase());
  if (optedOut) return { queueing: false, reason: 'caller opted out (`--queue=false`)' };
  if (NON_DISPATCHABLE_KINDS.includes(verdict.kind)) {
    return {
      queueing: false,
      reason: `kind:${verdict.kind} can never be dispatched by the conveyor — ${verdict.kind === 'epic' ? '`/slice` it into stories first' : '`/prepare` then `/decision` (ratify) it first'}`,
    };
  }
  if (verdict.status !== 'open') {
    return { queueing: false, reason: `born \`${verdict.status}\` (#670) — pool-excluded until settled; queue it by hand once settled` };
  }
  return { queueing: true, reason: 'ready to clear — story/task born open' };
}

/**
 * Build the declaration. Both readers/sinks are injected — `./file-item-io.mjs` supplies the real bindings,
 * reusing `we:scripts/operations/scaffold-io.mjs`'s own reader + write sink rather than re-deriving either.
 */
export function fileItemOperation({ readScaffoldContext, readRelated = null } = {}) {
  if (typeof readScaffoldContext !== 'function') {
    throw new TypeError(
      'file-item: needs a `readScaffoldContext()` reader — the io is INJECTED so the declaration stays '
      + 'testable without `fs`; the real binding is `we:scripts/operations/file-item-io.mjs`, which reuses '
      + '`we:scripts/operations/scaffold-io.mjs`\'s own reader.',
    );
  }

  return op(FILE_ITEM_OP, {
    input: {
      title: 'string',
      ...OPERATOR_TASK_INPUT,
      kind: { type: 'string', required: false, default: '' },
      type: { type: 'string', required: false, default: '' },
      workItem: { type: 'string', required: false, default: '' },
      size: { type: 'string', required: false, default: '' },
      slug: { type: 'string', required: false, default: '' },
      digest: { type: 'string', required: false, default: '' },
      parent: { type: 'string', required: false, default: '' },
      blockedBy: { type: 'string', required: false, default: '' },
      scope: { type: 'string', required: false, default: '' },
      session: { type: 'string', required: false, default: '' },
      // Opt OUT of the auto-clear, not opt in — the default behaviour is the whole point of this operation
      // over bare `scaffold`; a caller who wants scaffold-only behaviour passes `--queue=false` (or calls
      // `scaffold` directly, which this operation intentionally leaves reachable).
      queue: { type: 'string', required: false, default: 'true' },
      // The related-card check (see `planRelatedCheck`): name the existing card this filing relates to, or say why
      // it is new. Either one satisfies the check; both are recorded under the digest.
      related: { type: 'string', required: false, default: '' },
      'new-because': { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',
    // Both raw sequences this operation replaces end to end: filing (`backlog.mjs scaffold`) AND the
    // separate hand-off gesture (`conveyor/queue.mjs add`) a session previously had to remember to run itself.
    declaresOver: DECLARED_HOMES['file-item'],

    read: compute({
      reads: ['input.operatorTask'],
      fn: (view) => {
        const raw = readScaffoldContext();
        return { ...shapeScaffoldRead(raw), operatorTask: raw.operatorTask, sessionRole: raw.sessionRole,
          originMainSha: view.input.operatorTask ? raw.originMainSha : undefined };
      },
    }),

    // THE RELATED-CARD CHECK — before `plan`, so a refusal stops the filing before any card number is allocated.
    // Only the bounded top matches are kept on the finding (never the whole card corpus).
    related: compute({
      reads: ['input.title', 'input.digest', 'input.scope', 'input.parent', 'input.related', 'input.new-because'],
      fn: (view) => {
        let ctx = null;
        if (typeof readRelated === 'function') {
          try { ctx = readRelated(); } catch (e) { ctx = { error: String(e?.message ?? e) }; }
        }
        return planRelatedCheck(ctx, view.input);
      },
    }),

    // THE SCAFFOLD VERDICT, extended only by operator filing admission — same allocation, same refusals,
    // same rendered content. This is the operation's `verdictFrom` target, so a caller reading `run.verdict`
    // sees exactly what a `scaffold` caller would (num/id/rel/abs/kind/status/content/digestFilled).
    plan: compute({
      reads: [
        'input.title', 'input.kind', 'input.type', 'input.workItem', 'input.size', 'input.slug',
        ...OPERATOR_TASK_READS, 'input.digest', 'input.parent', 'input.blockedBy', 'input.scope', 'input.session', 'findings.read',
        'input.related', 'input.new-because', 'findings.related',
      ],
      fn: (view) => planFileItem(view.findings.read, view.input, view.findings.related),
    }),

    // THE QUEUEING DECISION, kept OFF the verdict deliberately: `verdictFrom: 'plan'` means every existing
    // reader of a scaffold-shaped verdict (tooling, tests, a future caller) keeps working unchanged — this is
    // an ADDITIONAL finding, not a reshaping of the one scaffold already returns.
    queuePlan: compute({
      reads: ['verdict', 'input.queue'],
      fn: (view) => planQueueing(view.verdict, view.input),
    }),

    write: effectStep({
      reads: ['verdict'],
      effects: (view) => [{
        type: SCAFFOLD_EFFECT,
        idempotent: true,
        payload: { abs: view.verdict.abs, rel: view.verdict.rel, content: view.verdict.content },
      }],
    }),

    // ONE EFFECT OR ZERO — never refused, never retried: a card that fails to queue still filed successfully
    // (the `write` effect above already ran), so this step only ever ADDS an outcome, never blocks one.
    queueAdd: effectStep({
      reads: ['verdict', 'findings.queuePlan'],
      effects: (view) => {
        if (!view.findings.queuePlan.queueing) return [];
        return [{
          type: FILE_ITEM_QUEUE_EFFECT,
          // IDEMPOTENT: `addToQueue` is itself idempotent (re-adding an already-cleared id is a no-op), so a
          // replay after a crash between `pending` and `applied` is safe.
          idempotent: true,
          payload: { num: view.verdict.num },
        }];
      },
    }),
  });
}
