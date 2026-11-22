/** Observe scored dispatches only. No return value from this module participates in routing. */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawArm, familyFor } from './provider-rotation.mjs';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';
import { observeCapacity } from './provider-capacity-io.mjs';
import { resolveRoutingSettings } from './routing-settings.mjs';
import { bindingWindow, launcherCapacity, scoreProvider } from './provider-capacity.mjs';
import { bankedBuckets } from './capacity-planner.mjs';

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'provider-rotation.json');
const keyLenses = ['correctness', 'security', 'red-team'];
const providerFamily = provider => ({ codex: 'openai', 'codex-alt': 'openai', openai: 'openai',
  claude: 'anthropic', anthropic: 'anthropic', 'agy-claude': 'anthropic',
  'agy-gemini': 'google', gemini: 'google', google: 'google' })[provider] ?? null;
const triple = arm => ({ provider: arm?.provider ?? null, model: arm?.model ?? null, effort: arm?.effort ?? null });

function readRotationPolicy({ env, policyPath = POLICY_PATH }) {
  if (statSync(policyPath).size > 256 * 1024) throw new Error('oversized-policy: operator must repair policy (max 256 KiB)');
  const tool = JSON.parse(readFileSync(policyPath, 'utf8')).providerRotation;
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('missing-policy');
  const platform = readPlatformPreferences({ env });
  if (platform.errors.length) throw new Error('unreadable-platform-policy');
  // No env routing override is introduced by this slice. The shared resolver logs leaf provenance.
  return cascadePolicy('providerRotation', tool, { standard: {},
    platform: platform.prefs.providerRotation, envValues: {}, env }).value;
}

function liveCapacity(kind, { env, now, records, routing = resolveRoutingSettings, observe = observeCapacity }) {
  const settings = routing({ env }).capacity;
  const observations = launcherCapacity(observe({ env, now, settings, records }), settings);
  return Object.fromEntries(observations.map(cap => {
    const scored = scoreProvider(cap, kind, { ...settings, now });
    const window = bindingWindow(cap);
    return [cap.provider, { available: cap.known === true && cap.health > 0 && !cap.held,
      usedPct: scored.usedPercent, hoursToReset: window ? (window.resetsAt - now) / 3600000 : null,
      manualResetsHeld: bankedBuckets(cap, now).reduce((sum, bucket) => sum + bucket.count, 0), label: scored.label,
      ...(cap.reservePercent !== undefined ? { reservePercent: cap.reservePercent } : {}) }];
  }));
}

function kindFor(row) {
  const dispatch = row.dispatchKind;
  if (['review-correctness', 'review-security'].includes(dispatch)) return { kind: dispatch, lens: dispatch.slice(7) };
  if (['review-seat', 'review', 'review-pr', 'red-team'].includes(dispatch) || dispatch?.startsWith('review-seat:')) {
    const lens = row.lens ?? row.seat?.lens ?? (dispatch === 'red-team' ? 'red-team' : dispatch.split(':').at(-1));
    // A whole review has no single lens. Individual seats carry their explicit lens when available.
    if (['review', 'review-pr', 'review-seat'].includes(lens)) return { kind: 'review-lens' };
    return { kind: lens === 'red-team' ? lens : ['correctness', 'security'].includes(lens) ? `review-${lens}` : 'review-lens', lens };
  }
  const mapped = { 'advisory-review': 'judge', 'probation-launch': row.taskType ?? 'build',
    'prepare-item': 'prepare', 'prepare-card': 'prepare', 'prepare-decision': 'prepare', 'prepare-complex': 'prepare',
    'prevention-card': 'doc-fix', trivial: 'doc-fix', summary: 'summary' };
  return { kind: mapped[dispatch] ?? dispatch };
}

/** Fail-soft telemetry; even an unreadable policy gets one refusal line if the sidecar is writable.
 * Injected IO keeps scorecard tests hermetic. records is the already-read store, never a second 108 MB read.
 */
export function appendRotationShadow(row, options = {}) {
  let record;
  try {
    const { kind, lens } = kindFor(row);
    const builder = row.builder ?? row.seat?.builder;
    const statedFamily = row.builderFamily ?? row.seat?.builderFamily;
    const derivedFamily = builder?.model ? familyFor(builder)
      : providerFamily(builder?.provider ?? builder ?? row.builderProvider ?? row.seat?.builderProvider);
    const builderFamily = statedFamily ?? derivedFamily;
    const required = keyLenses.includes(lens);
    record = { ts: new Date(options.now ?? Date.now()).toISOString(), kind, dispatchKind: row.dispatchKind,
      subject: row.repo && row.pr ? `${row.repo}#${row.pr}` : row.item != null ? `card:${row.item}` : null,
      handle: row.handle ?? null, actual: triple(row), shadowPick: null, mode: null,
      crossVendor: { required, builderFamily, pickFamily: null, ok: !required }, refusal: null };
    const env = options.env ?? process.env;
    const policy = Object.hasOwn(options, 'policy') ? options.policy
      : (options.readPolicy ?? readRotationPolicy)({ env, policyPath: options.policyPath });
    record.mode = policy?.mode ?? null;
    if (record.mode === 'off') return;
    // The logger stays shadow-only even if a future policy says on. Never activate routing here.
    if (record.mode !== 'shadow') record.refusal = 'shadow-only: unsupported-mode';
    else if (required && ((builder?.model && !derivedFamily) ||
      (statedFamily && derivedFamily && statedFamily !== derivedFamily))) record.refusal = 'inconsistent-builder-family';
    else {
      const capacity = options.capacity ?? liveCapacity(kind, { env, now: Date.parse(record.ts), records: options.records,
        routing: options.routing, observe: options.observe });
      const pick = (options.draw ?? drawArm)({ kind, lens, subject: record.subject, policy, capacity,
        builderFamily, counting: row.counting ?? row.seat?.counting ?? true });
      const pickFamily = pick.arm ? familyFor(pick.arm) : null;
      record.crossVendor.pickFamily = pickFamily;
      record.crossVendor.ok = !required || Boolean(builderFamily && pickFamily && builderFamily !== pickFamily);
      record.refusal = pick.refusal ?? (pick.arm ? null : 'no-eligible-arm');
      if (required && !record.crossVendor.ok) record.refusal ??= 'no-cross-vendor-seat';
      if (!record.refusal) record.shadowPick = triple(pick.arm);
    }
  } catch (error) {
    if (record) { record.shadowPick = null; record.refusal = `shadow-error: ${String(error?.message ?? error).slice(0, 300)}`; }
  }
  try {
    if (record) (options.append ?? appendFileSync)(join(dirname(options.storePath), 'rotation-shadow.jsonl'),
      `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { /* Telemetry loss cannot change the appended row or the actual dispatch. */ }
}
