/**
 * @file scripts/operations/scaffold.mjs
 * @description THE `scaffold` DECLARATION (#xrrpfo7, under epic #3029) — bring a new backlog item into
 *   existence, with the refusals that stop a malformed one from being born.
 *
 * THE THIRD OF THE LIFECYCLE TRIO. `we:scripts/operations/claim.mjs` (#3034) declared the OPEN,
 * `we:scripts/operations/resolve.mjs` the CLOSE; this declares the BIRTH. Measured reason: a 1,786-call
 * session audit on 2026-08-21 counted **45 raw `backlog.mjs scaffold` calls** — the single most-invoked
 * backlog verb in the session — and 0 through any operation, because there was none.
 *
 * IT RE-DERIVES NOTHING. Every decision below already has a home and is imported from it:
 *   · `BACKLOG_KINDS`  — `we:scripts/check-standards-rules.mjs`, the same set the gate validates against;
 *   · `nextHash`       — `we:scripts/backlog/id.mjs`, the #2288 JIT id allocator;
 *   · `renderItem`     — `we:scripts/backlog/scaffold.mjs`, the skeleton renderer;
 *   · the write        — `we:scripts/backlog/guarded-write.mjs`, which owns the lane-not-primary refusal AND
 *                        the #883 locus scan that already refuses a bad digest at write time.
 * A second answer to any of those is the defect #2644 names. In particular this file does NOT decide what a
 * valid locus prefix is: that scan fired three times while cards were being filed on 2026-08-21, each time
 * fail-closed with nothing written, which is exactly the behaviour to preserve rather than reimplement.
 *
 * The IO reader reserves a final numeric id under the shared allocator lock. The
 * pure plan consumes that id, refuses collisions, and retains a hash as bornAs.
 * If allocation is disabled or fails, the existing hash path remains available.
 *
 * THE LEGACY FLAG SHAPE IS PRESERVED DELIBERATELY. `--type`/`--workitem` predate the single `kind` axis
 * (#466/#487) and every skill and doc in the repo still passes them — including the 45 calls that motivated
 * this operation. Refusing them would break the callers this exists to serve, so `resolveKind` replays the
 * CLI's precedence exactly: an explicit `kind` wins, else a `type: decision` wins, else the `workItem`.
 *
 * PURE. No fs, no clock, no process. `./scaffold-io.mjs` is the only place it touches the world.
 */
import { OPERATOR_TASK_INPUT, OPERATOR_TASK_READS, operatorTaskFields } from '../backlog/operator-task.mjs';
import { op } from './registry.mjs';
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { BACKLOG_KINDS } from '../check-standards-rules.mjs';
import { nextHash, stampBornAs } from '../backlog/id.mjs';
import { renderItem, sizeRefusal, parseSize } from '../backlog/scaffold.mjs';

export const SCAFFOLD_OP = 'scaffold';

/** The one effect: write the rendered skeleton through the guarded writer. */
export const SCAFFOLD_EFFECT = 'scaffold.write';

/** Why a scaffold was refused. A closed set, so a caller branches on a reason rather than prose. */
export const SCAFFOLD_REFUSALS = Object.freeze(['bad-kind', 'no-title', 'story-needs-size', 'bad-size', 'size-not-allowed', 'id-exhausted']);

/**
 * Resolve the `kind` axis from the three flag shapes. PURE.
 *
 * REPLAYS `we:scripts/backlog.mjs`'s precedence rather than improving on it: explicit `kind` wins; else a
 * `type` of `decision` wins (a decision is a decision whatever `workItem` says); else `workItem`; else the
 * long-standing `story` default. Changing this quietly would retype items for 45 existing call sites.
 */
export function resolveKind({ kind = '', type = '', workItem = '' } = {}) {
  if (kind) return String(kind);
  if (type || workItem) return String(type) === 'decision' ? 'decision' : String(workItem || 'story');
  return 'story';
}

/** Slug from a title — the CLI's own shape, kept local because it is three lines and has no other home. */
export function slugFor(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Normalize a cross-reference. PURE, and the padding is CONDITIONAL for a reason that matters.
 *
 * A landed item is `NNN` and pads; an in-flight sibling is a hash (#2288) and must NOT — zero-padding
 * `xvatzyf` corrupts it into an id that resolves to nothing, which then reads as a dangling edge rather than
 * as the mangling it is.
 */
export function normalizeRef(ref) {
  const raw = String(ref ?? '').replace(/^#/, '').trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw;
}

/**
 * Shape the injected reader result. PURE.
 *
 * The reader supplies the existing ids, date and optional reserved numeric id.
 */
export function shapeScaffoldRead(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`scaffold.read: the injected reader returned ${typeof raw}, not a scaffold context`);
  }
  if (!Array.isArray(raw.existingIds)) {
    throw new Error(
      'scaffold.read: the reader must return `existingIds` — the allocator needs the full id set to avoid a '
      + 'collision, and an absent list would silently allocate against nothing.',
    );
  }
  return {
    existingIds: raw.existingIds.map(String),
    today: String(raw.today || ''),
    dir: String(raw.dir || ''),
    ...(raw.bornAs ? { bornAs: String(raw.bornAs) } : {}),
    ...(raw.allocatedId ? { allocatedId: String(raw.allocatedId) } : {}),
  };
}

/**
 * Decide the scaffold. PURE, and THROWS on a refusal — matching `claim`/`resolve` and the CLI's `die()`.
 */
export function planScaffold(read, input = {}, { alloc = nextHash } = {}) {
  const refuse = (reason, message) => {
    const err = new Error(`scaffold: ${message}`);
    err.reason = reason;
    throw err;
  };

  const kind = resolveKind(input);
  if (!BACKLOG_KINDS.has(kind)) {
    refuse('bad-kind', `kind must be one of ${[...BACKLOG_KINDS].join('|')} (got ${JSON.stringify(kind)})`);
  }

  const title = String(input.title || '').trim();
  if (!title) refuse('no-title', 'a new item needs a --title');

  const size = parseSize(input.size);
  // A story without a size enters the board unsized, which the readiness ranker cannot place — so the CLI
  // refuses it and so does this. A size passed for a kind that is never sized, or a non-numeric one, is
  // refused too (#x0h3pe4) — never silently dropped. One shared rule with the CLI: `sizeRefusal`.
  const sizeProblem = sizeRefusal(kind, input.size);
  if (sizeProblem) refuse(sizeProblem.reason, sizeProblem.message);

  const slug = String(input.slug || '').trim() || slugFor(title);

  const key = (id) => /^\d+$/.test(id) ? String(Number(id)) : id;
  const taken = new Set(read.existingIds.map(key));
  let num = String(read.allocatedId || read.bornAs || alloc(read.existingIds));
  if (!read.allocatedId && taken.has(key(num))) num = alloc([...read.existingIds, num]);
  if (taken.has(key(num))) {
    refuse('id-exhausted', `the id allocator returned a taken id (${num}) — refusing`);
  }
  const bornAs = /^\d+$/.test(num) ? (read.bornAs || nextHash(read.existingIds)) : null;

  const name = `${num}-${slug}.md`;
  let content = renderItem({
    // Only the file-item reader supplies a session role, so a bare scaffold cannot file an operator task.
    ...operatorTaskFields(input, { role: read.sessionRole }),
    kind,
    size: Number.isFinite(size) ? size : undefined,
    slug,
    title,
    today: read.today,
    blockedBy: String(input.blockedBy || '').split(',').map((s) => s.trim()).filter(Boolean).map(normalizeRef),
    parent: input.parent ? normalizeRef(input.parent) : undefined,
    scope: String(input.scope || '').split(',').map((s) => s.trim()).filter(Boolean),
    digest: input.digest || undefined,
    scaffoldedBy: input.session || undefined,
  });

  if (bornAs) content = stampBornAs(content, bornAs);

  return {
    num,
    id: name.replace(/\.md$/, ''),
    rel: `backlog/${name}`,
    abs: read.dir ? `${read.dir}/${name}` : name,
    kind,
    // #670 — `--session` births the item `active` and pool-excluded until `settle`d, so a half-authored card
    // is not offered to another session. Reported so the caller knows which of the two births it got.
    status: input.session ? 'active' : 'open',
    digestFilled: Boolean(input.digest),
    content,
  };
}

/** Build the declaration. `readScaffoldContext` is injected — `./scaffold-io.mjs` supplies the real reader. */
export function scaffoldOperation({ readScaffoldContext } = {}) {
  if (typeof readScaffoldContext !== 'function') {
    throw new TypeError(
      'scaffold: needs a `readScaffoldContext()` reader — the io is INJECTED so the declaration stays '
      + 'testable without `fs`; the real binding is `we:scripts/operations/scaffold-io.mjs`.',
    );
  }

  return op(SCAFFOLD_OP, {
    input: {
      title: 'string',
      ...OPERATOR_TASK_INPUT,
      // The three kind shapes, all optional: `resolveKind` replays the CLI's precedence over them.
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
    },
    verdictFrom: 'plan',
    // The raw invocation this operation was built to replace (#3224). Declared, never derived: whether
    // `we:scripts/backlog.mjs scaffold` reaches this module is visible in the import graph (it does not — unlike
    // `claim`, which routes through `claimViaOperation`), but the INTENT that this replaced it is not.
    declaresOver: DECLARED_HOMES.scaffold,

    read: compute({
      reads: [],
      fn: () => shapeScaffoldRead(readScaffoldContext()),
    }),

    plan: compute({
      reads: [
        'input.title', 'input.kind', 'input.type', 'input.workItem', 'input.size', 'input.slug',
        ...OPERATOR_TASK_READS, 'input.digest', 'input.parent', 'input.blockedBy', 'input.scope', 'input.session', 'findings.read',
      ],
      fn: (view) => planScaffold(view.findings.read, view.input),
    }),

    write: effectStep({
      reads: ['verdict'],
      effects: (view) => [{
        type: SCAFFOLD_EFFECT,
        // IDEMPOTENT: the bytes and the path are both values `plan()` computed in full, so a replay after a
        // crash between `pending` and `applied` writes the identical file. Same reasoning as `claim`'s.
        idempotent: true,
        payload: { abs: view.verdict.abs, rel: view.verdict.rel, content: view.verdict.content },
      }],
    }),
  });
}
