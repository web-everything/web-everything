/** Advisory only: a stale finding remains pending until the operator rules. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { codexJudgeSpawn } from '../lib/codex-judge-spawn.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from '../lib/mandate-fence.mjs';
import { resolveRunsDir } from '../operations/run-store.mjs';

const toolFile = resolve(dirname(fileURLToPath(import.meta.url)), '../settings/referral-reverify.json');
const validMax = v => Number.isInteger(v) && v >= 0 && v <= 10;
export function resolveReferralReverifyMax(env = process.env, { tool } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = JSON.parse(readFileSync(toolFile, 'utf8'))?.referralReverify; } catch { /* standard/platform */ }
  }
  const raw = env?.WE_REFERRAL_REVERIFY_MAX;
  const r = cascadePolicy('referralReverify', block, {
    env, standard: { maxPerPrHead: 3 },
    envValues: { maxPerPrHead: typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : undefined },
    valid: { maxPerPrHead: validMax },
  });
  return { maxPerPrHead: r.value.maxPerPrHead, source: r.sources.maxPerPrHead };
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
// Findings and evidence must not inject HTML markers (especially executable ruling records).
const prose = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ghOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024 };
const shape = {
  type: 'object', additionalProperties: false, required: ['reproduces', 'evidence'],
  properties: { reproduces: { type: 'boolean' }, evidence: { type: 'string' } },
};

/** At most two bounded GitHub reads, shared by every finding in this invocation. Compare immutable SHAs. */
function currentDiff(repo, prNumber, head) {
  const pr = JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(prNumber), '--repo', repo,
    '--json', 'headRefOid,baseRefOid'], ghOptions));
  if (pr.headRefOid !== head || !/^[a-f0-9]{40}$/.test(pr.baseRefOid)) throw new Error('current head unavailable or moved');
  return execFileSyncThrottled('gh', ['api', `repos/${repo}/compare/${pr.baseRefOid}...${head}`,
    '-H', 'Accept: application/vnd.github.diff'], ghOptions);
}

function evidenceValid(result, finding) {
  if (result?.reproduces !== false || typeof result.evidence !== 'string'
    || !result.evidence.trim() || result.evidence.length > 8000 || !finding.file) return false;
  const escaped = finding.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}:[1-9]\\d*\\b(?:[ \\t]*[:—-][ \\t]*|[ \\t]+)\\S`).test(result.evidence);
}

/** Injectable IO operates on findings/results and comment bodies, never on ruling records.
 * A durable lock serializes ticks; a crashed owner keeps the lock and refuses further cost until inspected.
 * Attempts are persisted BEFORE spawning, including failures, so restarts cannot reset the budget.
 */
export async function reverifyStaleReferrals({ repo, prNumber, head, pending = [], comments = [],
  env = process.env, dir = join(dirname(resolveRunsDir()), 'referral-reverify'), now = Date.now(),
  log = line => console.error(line), spawn,
  post = body => execFileSyncThrottled('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body], ghOptions),
} = {}) {
  const keptAll = () => ({ proposed: [], kept: pending.map(f => f.key), skipped: [] });
  const { maxPerPrHead, source } = resolveReferralReverifyMax(env);
  log(`referralReverify.maxPerPrHead=${maxPerPrHead} (${source})`);
  const stale = f => Array.isArray(f.raisedHeads) && f.raisedHeads.length > 0
    && /^[a-f0-9]{40}$/.test(f.raisedHeads[0]) && f.raisedHeads[0] !== head;
  if (!pending.some(stale)) return keptAll();
  if (maxPerPrHead === 0) return { ...keptAll(), skipped: pending.filter(stale).map(f => f.key) };
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(prNumber)) return keptAll();
  const id = digest([repo, prNumber, head]);
  const marker = `<!-- referral-reverify: ${id} -->`;
  if (comments.some(c => isTrustedMarkerAuthor(c) && c.body?.includes(marker))) return keptAll();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const lock = `${path}.lock`;
  try { writeFileSync(lock, JSON.stringify({ now }), { flag: 'wx' }); }
  catch {
    log('referral reverify unavailable: inspect receipt lock; referrals still require operator ruling');
    return keptAll();
  }
  try {
    let receipt;
    try { receipt = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    receipt ??= { attempts: [], proposalAttempted: false };
    if (!Array.isArray(receipt.attempts) || typeof receipt.proposalAttempted !== 'boolean') throw new Error('unreadable receipt');
    if (receipt.proposalAttempted) return keptAll();
    const save = () => {
      writeFileSync(`${path}.next`, JSON.stringify(receipt));
      renameSync(`${path}.next`, path);
    };
    let diff;
    let diffRead = false;
    const realSpawn = async finding => {
      if (!diffRead) { diffRead = true; diff = currentDiff(repo, prNumber, head); }
      if (typeof diff !== 'string') throw new Error('current diff unavailable');
      const section = String(diff).split(/(?=^diff --git )/m)
        .filter(s => s.split('\n', 1)[0] === `diff --git a/${finding.file} b/${finding.file}`).join('\n');
      if (!section || section.length > 100_000) throw new Error('cited file diff unavailable or oversized');
      const outcome = await codexJudgeSpawn({
        repo, pr: prNumber, lens: 'referral-reverify', timeoutMs: 120_000, shape,
        mandate: `Re-check exactly one finding at its cited file:line on the supplied current-head diff. Read only; do not edit, post, or rule. Return reproduces=false only with concrete file:line evidence explaining why the defect no longer reproduces. Unknown or incomplete evidence means reproduces=true. Do not investigate other findings.\n${FENCED_DATA_RULE}`,
        input: [fenceUntrusted('findings', JSON.stringify(finding)),
          fenceUntrusted('material', JSON.stringify({ repo, prNumber, head }) + '\n' + section)].join('\n\n'),
      });
      if (outcome.timedOut) throw new Error('re-check timed out');
      return outcome.value;
    };
    const proposed = [];
    const skipped = [];
    for (const f of pending) {
      if (!stale(f)) continue;
      const findingId = digest([f.runId, f.key]);
      let attempt = receipt.attempts.find(a => a.id === findingId);
      if (!attempt) {
        if (receipt.attempts.length >= maxPerPrHead) { skipped.push(f.key); continue; }
        attempt = { id: findingId, key: f.key, now };
        receipt.attempts.push(attempt);
        save();
        try { attempt.result = await (spawn ?? realSpawn)(f); }
        catch { attempt.result = null; }
        save();
      }
      if (evidenceValid(attempt.result, f)) proposed.push({ finding: f, evidence: attempt.result.evidence });
    }
    if (skipped.length) log(`referral reverify bound: kept ${skipped.map(clean).join(', ')}; operator ruling still required`);
    if (proposed.length) {
      const body = `Referral re-verification on head ${head}: proposing not-real (stale-head-reraise).\n\n`
        + proposed.map(p => `- ${prose(p.finding.key)}: ${prose(p.evidence)}`).join('\n')
        + (skipped.length ? `\n\nNot re-checked (budget): ${skipped.map(prose).join(', ')}.` : '')
        + `\n\nThe operator still rules; all referrals remain pending until that ruling.\n\n${marker}`;
      // Reserve before posting: ambiguous transport failures must not cause duplicate proposals.
      receipt.proposalAttempted = true;
      save();
      const posted = await post(body);
      if (posted?.ok === false) throw new Error('proposal post failed');
    }
    const keys = proposed.map(p => p.finding.key);
    return { proposed: keys, kept: pending.filter(f => !keys.includes(f.key)).map(f => f.key), skipped };
  } catch {
    log('referral reverify incomplete: referrals kept; operator ruling required (inspect durable receipts)');
    return keptAll();
  } finally { unlinkSync(lock); }
}
