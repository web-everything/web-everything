/** Observational eligibility only: no result from this module controls dispatch. */
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { eligibility } from './dispatch-eligibility.mjs';
import { buildEligibilityFacts } from './dispatch-eligibility-facts.mjs';
import { resolveCascade, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { daemonConveyorStateRoot } from '../lib/daemon-last-good.mjs';
import { isUnderTest as isUnderTestEnv } from '../lib/under-test.mjs';

const validMode = value => value === 'off' || value === 'shadow';
let loggedMode = false;

/** dispatch.eligibility.mode: standard → platform → tool → environment. */
export function resolveShadowMode(env = process.env, { platform, tool, hermetic = isUnderTestEnv(), log = console.info } = {}) {
  if (platform === undefined && !hermetic) platform = platformPreference('dispatch', { env })?.eligibility;
  if (tool === undefined) tool = readSettings()?.dispatch?.eligibility;
  const raw = env.WE_DISPATCH_ELIGIBILITY_MODE;
  const resolved = resolveCascade({ standard: { mode: 'shadow' }, platform, tool,
    envValues: { mode: raw === undefined ? undefined : validMode(raw) ? raw : 'shadow' },
    valid: { mode: validMode } });
  const mode = resolved.value.mode;
  const source = raw !== undefined && !validMode(raw) ? 'env fallback to standard' : resolved.sources.mode;
  if (!loggedMode) {
    loggedMode = true;
    try { log(`dispatch.eligibility.mode=${mode} (${source})`); } catch { /* observational */ }
  }
  return { mode, source };
}

/** Active file plus `keep` generations; oversized evidence is refused, never truncated. */
export function createBoundedShadowLog({ file, maxBytes = 1024 * 1024, keep = 2, fs = nodeFs }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(keep) || keep < 0 || keep > 100) {
    throw new Error('Invalid shadow log bounds; operator must configure maxBytes > 0 and keep between 0 and 100');
  }
  return line => {
    const data = `${String(line).replace(/\n$/, '')}\n`;
    const bytes = Buffer.byteLength(data);
    if (bytes > maxBytes) throw new Error(`Shadow line exceeds maxBytes=${maxBytes}; evidence skipped, operator must inspect the PR or raise the log limit`);
    fs.mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size + bytes > maxBytes) {
      if (keep === 0) fs.unlinkSync(file);
      else {
        if (fs.existsSync(`${file}.${keep}`)) fs.unlinkSync(`${file}.${keep}`);
        for (let n = keep - 1; n >= 1; n--) {
          if (fs.existsSync(`${file}.${n}`)) fs.renameSync(`${file}.${n}`, `${file}.${n + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
      }
    }
    fs.appendFileSync(file, data);
  };
}

/** Shared defaults; injected callers and tests never fall through to a home-directory writer. */
export function eligibilityShadowDeps({ hermetic = isUnderTestEnv(), ...injected } = {}) {
  const { mode } = resolveShadowMode(process.env, { hermetic });
  return { mode,
    appendLine: hermetic || mode === 'off' ? () => {} : createBoundedShadowLog({
      file: join(daemonConveyorStateRoot(process.env), '.conveyor', 'dispatch-eligibility-shadow.jsonl'),
    }),
    // No extra local IO: absent facts remain unread in the fact builder.
    readLocals: entry => ({ rounds: { attempts: entry.attempts, cap: entry.cap } }),
    ...injected };
}

/** Errors are visible but must never escape into dispatch planning, including a broken reporter. */
export function reportShadowError(error) {
  try { console.warn(`eligibility shadow skipped evidence; inspect the PR: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`); }
  catch { /* diagnostics cannot affect dispatch */ }
}

export function runEligibilityShadow({ dispatch = [], prs = [], mode = 'shadow', appendLine = () => {},
  readLocals = () => undefined, now = () => new Date(), pathId = 'reconcile-core', onError = reportShadowError } = {}) {
  const result = { checked: 0, disagreements: 0 };
  if (mode === 'off') return result;
  for (const entry of dispatch) {
    if (!['fix', 'ci-heal'].includes(entry.kind)) continue;
    result.checked++;
    try {
      const pr = prs.find(p => p.number === entry.prNumber) ?? {};
      const facts = buildEligibilityFacts({ pr, comments: pr.comments, commentsComplete: pr.commentsComplete === true,
        population: entry.kind, locals: readLocals(entry, pr) });
      const gate = eligibility(pr, facts);
      if (gate.dispatch === true) continue;
      result.disagreements++;
      appendLine(JSON.stringify({ at: new Date(now()).toISOString(), pathId, pr: entry.prNumber,
        head: pr.headRefOid ?? null, path: 'dispatch', gate: gate.hold ? 'hold' : 'unknown',
        reasons: [gate.hold ?? gate.unknown] }));
    } catch (error) {
      try { onError(error); } catch { /* keep checking the next entry */ }
    }
  }
  return result;
}
