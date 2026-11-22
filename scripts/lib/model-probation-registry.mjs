/** Registry-only dependency boundary: routing must not import scoring or provider routing. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

/** The registry file this module reads and writes. */
export const PROBATION_REGISTRY_PATH = join(__dirname, 'model-probation.json');

/** Schema version every registry file carries. Bump ONLY on a breaking field change. */
export const PROBATION_REGISTRY_VERSION = 1;

/** The full status vocabulary, ordered least → most trusted. */
export const PROBATION_STATUSES = Object.freeze(['unvalidated', 'probation', 'trusted']);

/** The roles this registry tracks per `{provider, model}` identity. */
export const PROBATION_ROLES = Object.freeze(['delivery', 'advisory-review']);

/** Fail-closed default for any identity/role this registry does not name. */
export const DEFAULT_STATUS = 'unvalidated';

/**
 * Roles that structurally can NEVER gate a merge or acquire veto power, regardless of status. This is not a
 * config a status could flip — it exists so a caller asking "can this role ever block" gets a single,
 * grep-able `true`/`false` answer sourced from ONE place, backed by `review-pr.mjs`'s own mandatory/advisory
 * lens split (the actual structural enforcement lives there — `ADVISORY_LENSES` vs `MANDATORY_LENSES` — this
 * is a restatement for callers who only have this module in scope, not a second, independent enforcement
 * point that could drift from it).
 */
export const NEVER_BLOCKING_ROLES = Object.freeze(['advisory-review']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize a `{provider, model}` pair into the registry's lookup key. PURE. */
export function identityKey({ provider, model } = {}) {
  return `${String(provider ?? '').trim().toLowerCase()}::${String(model ?? '').trim()}`;
}

/**
 * Validate ONE registry entry. Never throws — a malformed registry must degrade to "nothing declared"
 * (fail-closed, per {@link normalizeRegistry}), not crash a caller mid-dispatch decision.
 * @param {object} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProbationEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, errors: ['entry is not an object'] };
  if (!isNonEmptyString(entry.provider)) errors.push('`provider` is required (e.g. "codex", "anthropic")');
  if (!isNonEmptyString(entry.model)) errors.push('`model` is required (e.g. "gpt-6-astra") — identity is ALWAYS provider+model, never provider alone');
  if (!isNonEmptyString(entry.since) || !ISO_DAY_RE.test(String(entry.since).trim())) errors.push('`since` is required and must be a YYYY-MM-DD day');
  if (!isNonEmptyString(entry.owner)) errors.push('`owner` is required — the item/epic that put this identity on probation');
  if (!entry.roles || typeof entry.roles !== 'object' || Array.isArray(entry.roles)) {
    errors.push('`roles` is required — an object mapping each declared role to a status');
  } else {
    for (const [role, status] of Object.entries(entry.roles)) {
      if (!PROBATION_ROLES.includes(role)) errors.push(`\`roles\` names unknown role ${JSON.stringify(role)} — one of ${PROBATION_ROLES.join('|')}`);
      if (!PROBATION_STATUSES.includes(status)) errors.push(`\`roles.${role}\` must be one of ${PROBATION_STATUSES.join('|')}, got ${JSON.stringify(status)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a parsed registry file into a frozen, canonical `{version, entries}`. Tolerant of a missing or
 * malformed file (⇒ an EMPTY registry, not a throw) — an unreadable registry means "nothing is declared",
 * which fails CLOSED everywhere downstream (every identity reads back {@link DEFAULT_STATUS}). Bad entries
 * are dropped and reported in `dropped` rather than taking the whole registry offline. PURE.
 * @param {unknown} parsed
 * @returns {{version: number, entries: object[], dropped: {identity: string, errors: string[]}[]}}
 */
export function normalizeRegistry(parsed) {
  const raw = (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) ? parsed.entries : [];
  const entries = [];
  const dropped = [];
  const seen = new Set();
  for (const e of raw) {
    const verdict = validateProbationEntry(e);
    const key = identityKey(e ?? {});
    if (!verdict.ok) { dropped.push({ identity: key, errors: verdict.errors }); continue; }
    if (seen.has(key)) { dropped.push({ identity: key, errors: [`duplicate identity ${JSON.stringify(key)} — first entry wins`] }); continue; }
    seen.add(key);
    entries.push(Object.freeze({ ...e, roles: Object.freeze({ ...e.roles }) }));
  }
  return Object.freeze({ version: PROBATION_REGISTRY_VERSION, entries: Object.freeze(entries), dropped: Object.freeze(dropped) });
}

/**
 * PURE lookup: what registry entry (if any) declares `{provider, model}`? Returns `null` for an unknown pair.
 * @param {{version:number, entries:object[]}} registry
 * @param {{provider:string, model:string}} identity
 * @returns {object|null}
 */
export function findEntry(registry, identity) {
  const key = identityKey(identity);
  return (registry?.entries ?? []).find((e) => identityKey(e) === key) ?? null;
}

/**
 * PURE: the declared status of `{provider, model}` for `role`. Fail-closed to {@link DEFAULT_STATUS} when the
 * identity is unlisted, the role is unlisted on that identity's entry, or `role` itself is not a known role —
 * an unknown role is refused loudly (a typo must not silently read as "unvalidated" for the WRONG reason),
 * everything else degrades quietly.
 * @param {{version:number, entries:object[]}} registry
 * @param {{provider:string, model:string, role:string}} o
 * @returns {'unvalidated'|'probation'|'trusted'}
 */
export function statusFor(registry, { provider, model, role } = {}) {
  if (!PROBATION_ROLES.includes(role)) {
    throw new TypeError(`model-probation: \`role\` must be one of ${PROBATION_ROLES.join('|')}, got ${JSON.stringify(role)}`);
  }
  const entry = findEntry(registry, { provider, model });
  const status = entry?.roles?.[role];
  return PROBATION_STATUSES.includes(status) ? status : DEFAULT_STATUS;
}

/** PURE convenience: is `{provider, model}` on probation (exactly, not `trusted`) for `role`?
 *  @test-only-export-ok: public API mirroring `liveStatusFor`'s convenience shape (`codexAdvisoryFromEnv`
 *  uses `liveStatusFor` directly today); kept for a future `delivery`-role call site (e.g. `fix-run.mjs`'s
 *  own provider selection) that is owed follow-on wiring, not built this session. */
export function isOnProbation(registry, o) {
  return statusFor(registry, o) === 'probation';
}

/** PURE convenience: is `{provider, model}` eligible for REAL work in `role` — `probation` or `trusted`?
 *  Enforced for Hydrogen delivery by agy-sandbox.mjs at routing and launch. */
export function isDispatchEligible(registry, o) {
  const status = statusFor(registry, o);
  return status === 'probation' || status === 'trusted';
}

export function readRegistry({ path = PROBATION_REGISTRY_PATH, read = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    return normalizeRegistry(JSON.parse(read(path)));
  } catch {
    return normalizeRegistry(null);
  }
}
