/** Capacity-gated R903 referral classification. All writes use record-referral-ruling. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAutoBlock } from './referral-auto-block.mjs';
import { defaultReadPr } from './advisory-label-sweep.mjs';
import { referralCardReadable, CARD_REF_RE } from '../lib/referral-card-readable.mjs';
import { cardFromText, parseFilingItems, matchItem, CARD_DEDUPE_DEFAULTS } from '../lib/card-dedupe.mjs';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { FENCED_DATA_RULE, fenceUntrusted } from '../lib/mandate-fence.mjs';
import { REFERRAL_RULER_ACTOR } from '../lib/marker-authorship.mjs';
import { createExtraSeatsIo, readSeatCapUsage } from '../operations/review-extra-seats.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { readReferralRecords, readOperatorRulings } from '../lib/jury-core.mjs';
import { defaultCodexSpawnEnv, buildCodexJudgeArgv } from '../lib/codex-judge-spawn.mjs';
import { resolveProviderCap } from '../lib/review-seat-caps.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
export function resolveAutoRuleSettings({ env = process.env, settings, log } = {}) {
  let tool = settings;
  if (tool === undefined) {
    try { tool = { enabled: JSON.parse(readFileSync(resolve(ROOT, 'scripts/settings/referral-auto-rule.json'), 'utf8')).referralAutoRuleEnabled }; }
    catch { tool = { enabled: false }; }
  }
  if (!tool || Array.isArray(tool) || typeof tool.enabled !== 'boolean') tool = { enabled: false };
  const platform = platformPreference('referralAutoRule', { env });
  return cascadePolicy('referralAutoRule', tool, { standard: { enabled: false },
    platform: platform !== undefined && (!platform || typeof platform.enabled !== 'boolean') ? { enabled: false } : platform, env, log,
    envValues: { enabled: env.WE_REFERRAL_AUTO_RULE === undefined ? undefined : env.WE_REFERRAL_AUTO_RULE === '1' },
    valid: v => typeof v === 'boolean' }).value;
}
export function autoRuleCapacity() {
  const usage = readSeatCapUsage().codex;
  return usage.cap > usage.usedToday;
}
export function buildRulerPrompt({ repo, pr, head, findings, context }) {
  return `${FENCED_DATA_RULE}\nRead-only R903 referral ruler. Inspect the exact PR head and its base diff.
card = pre-existing gap / adjacent hole / test gap / hardening; requires an existing readable we:backlog card.
real = confirmed correctness or security bug INTRODUCED by this PR. An introduced bug must never be carded.
unclear = escalate. Missing objects, base, reproduction or evidence means unclear. Never not-real or clear-human.
Quote concrete code/diff evidence including path/line and establish whether it predates this PR.
Return only JSON: {"rulings": [{key, verdict: "card"|"real"|"unclear", evidence: "quoted evidence", card: "we:backlog/...md"|null}]}.
${fenceUntrusted('material', JSON.stringify({ repo, pr, head, findings, context }))}`;
}
export function spawnReferralRuler(input, { readGh = runGhSync, execute = execFileSync,
  reserve = args => createExtraSeatsIo().reserveCalls(args), env = process.env } = {}) {
  const opts = { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 };
  const meta = JSON.parse(readGh(['pr', 'view', String(input.pr), '--repo', input.repo, '--json', 'headRefOid,baseRefOid'], opts));
  if (meta.headRefOid !== input.head) throw new Error('stale head before ruler launch');
  const diff = readGh(['pr', 'diff', String(input.pr), '--repo', input.repo], opts);
  if (diff.length > 64_000) throw new Error('oversized PR diff; operator queue retains referrals');
  input = { ...input, context: { base: meta.baseRefOid, diff } };
  // Atomic shared daily seat reservation is retained even on failure: the call was spent.
  const reservation = reserve({ provider: 'codex', want: 1,
    dailyCap: resolveProviderCap('codex', env), now: Date.now() });
  if (reservation.callIds.length !== 1) throw new Error('review seat budget exhausted; operator queue retains referrals');
  if (!env.TMPDIR) throw new Error('TMPDIR required for ruler scratch');
  const dir = mkdtempSync(join(env.TMPDIR, 'referral-ruler-'));
  try {
    const answer = join(dir, 'answer.json');
    const schema = join(dir, 'schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', additionalProperties: false, required: ['rulings'],
      properties: { rulings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { key: { type: 'string' }, verdict: { type: 'string', enum: ['card', 'real', 'unclear'] },
        evidence: { type: 'string' }, card: { type: ['string', 'null'] } }, required: ['key', 'verdict', 'evidence', 'card'] } } } }));
    execute('codex', buildCodexJudgeArgv({ schemaFile: schema, outputLastMessageFile: answer, cwd: ROOT, env }), {
      cwd: ROOT, env: defaultCodexSpawnEnv(env, { scratchHome: dir }), input: buildRulerPrompt(input), encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (statSync(answer).size > 64_000) throw new Error('oversized ruler answer; operator queue retains referrals');
    const raw = readFileSync(answer, 'utf8');
    if (raw.length > 64_000) throw new Error('oversized ruler answer; operator queue retains referrals');
    return JSON.parse(raw).rulings;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export const runAutoRuling = args => execFileSync(process.execPath,
  [resolve(ROOT, 'scripts/operations/run.mjs'), 'record-referral-ruling', ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function pending(live, number, cardReadable) {
  if (live?.state !== 'OPEN' || (live.number != null && live.number !== number)
    || !/^[a-f0-9]{40}$/i.test(live.headRefOid ?? '') || !Array.isArray(live.labels)
    || !Array.isArray(live.comments)) throw new Error('incomplete live PR evidence; operator queue retains referrals');
  if (readReferralRecords(live.comments).malformed || readOperatorRulings(live.comments).malformed)
    throw new Error('malformed referral history; operator queue retains referrals');
  // Uses rulingNeeded + ignoredRulings and the shared human-clearance check.
  return planAutoBlock(live, { mode: 'auto-block', cardReadable });
}
// Local body proof is deliberately conservative: unreadable/remote-only cards stay with the operator.
export function readCardText(ref, { stat = statSync, read = readFileSync } = {}) {
  if (!CARD_REF_RE.test(ref ?? '') || ref.includes('@')) return null;
  try {
    const path = resolve(ROOT, ref.slice(3));
    if (stat(path).size > 128 * 1024) return null;
    return read(path, 'utf8');
  } catch { return null; }
}
function cardMatchesFinding(ref, finding, readText) {
  const text = readText(ref);
  if (typeof text !== 'string' || text.length > 128 * 1024 || !finding.file) return false;
  const [item] = parseFilingItems(`1. \`we:${finding.file}${finding.line == null ? '' : `:${finding.line}`}\` — ${finding.summary}`);
  return Boolean(matchItem(item, [cardFromText({ rel: ref, text })], CARD_DEDUPE_DEFAULTS.similarity));
}
function cardEvidence(evidence) {
  return evidence.trim().length >= 60 && /\b(?:predates? (?:this |the )?PR|pre-existing|before (?:this |the )?PR)\b/i.test(evidence)
    && [...evidence.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].some(m => {
      const snippet = (m[1] ?? m[2] ?? m[3]).trim();
      return snippet.replace(/\s/g, '').length >= 12 && /[A-Za-z_$]/.test(snippet) && /[=(){}.;<>]/.test(snippet);
    });
}
export function sweepAutoRule({ repo, listPrs, readPr = defaultReadPr, capacity = autoRuleCapacity,
  spawnRuler = spawnReferralRuler, take = () => {}, cardText = readCardText, runRuling = runAutoRuling, settings, dryRun = false,
  env = process.env, log, cardReadable = ref => referralCardReadable(ref, ROOT) } = {}) {
  if (!resolveAutoRuleSettings({ settings, env, log }).enabled) return [];
  const results = [];
  // Bound per-tick reads and model cost; remaining PRs stay in the operator queue for the next tick.
  const prs = listPrs?.({ repo });
  if (!Array.isArray(prs)) return [{ num: 0, action: 'failed', findings: 0, operatorKept: 0, error: 'incomplete PR listing' }];
  for (const pr of prs.slice(0, 8)) {
    const entry = { num: pr.number, action: 'escalated', findings: 0, operatorKept: 0, escalated: [] };
    try {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) throw new Error('missing repository');
      const live = readPr({ repo, number: pr.number });
      const plan = pending(live, pr.number, cardReadable);
      if (!plan) continue;
      entry.escalated = plan.block.map(f => f.key);
      entry.operatorKept = plan.operator.length + plan.block.length;
      if (plan.block.length > 12 || JSON.stringify(plan.block).length > 64_000) {
        entry.error = 'oversized referrals; operator queue retains referrals'; results.push(entry); continue;
      }
      if (dryRun || capacity({ repo, pr: pr.number }) !== true) {
        entry.action = dryRun ? 'dry-run' : 'waiting-capacity'; results.push(entry); continue;
      }
      take();
      const answers = spawnRuler({ repo, pr: pr.number, head: plan.head, findings: plan.block });
      if (!Array.isArray(answers) || answers.length > 12 || JSON.stringify(answers).length > 64_000)
        throw new Error('incomplete or oversized ruler answer; operator queue retains referrals');
      for (const finding of plan.block) {
        const matches = answers.filter(a => a?.key === finding.key);
        const a = matches.length === 1 ? matches[0] : null;
        if (!a || !['card', 'real'].includes(a.verdict) || typeof a.evidence !== 'string' || !a.evidence.trim()
          || a.evidence.length > 3500 || (a.verdict === 'card' && (!cardEvidence(a.evidence) || typeof a.card !== 'string' || !cardReadable(a.card)
            || !cardMatchesFinding(a.card, finding, cardText)))) continue;
        const fresh = readPr({ repo, number: pr.number });
        if (String(fresh?.headRefOid).toLowerCase() !== plan.head) { entry.action = 'stale-head'; break; }
        const still = pending(fresh, pr.number, cardReadable);
        if (!still?.block.some(f => f.key === finding.key)) continue;
        runRuling([`--repo=${repo}`, `--pr=${pr.number}`, `--finding=${finding.key}`, `--expectHead=${plan.head}`,
          `--ruling=${a.verdict === 'real' ? 'block' : 'card'}`, ...(a.verdict === 'card' ? [`--card=${a.card}`] : []),
          `--actor=${REFERRAL_RULER_ACTOR}`, '--channel=referral-auto-rule', `--reason=${a.evidence}`]);
        entry.findings++;
        entry.escalated = entry.escalated.filter(k => k !== finding.key);
        entry.operatorKept--;
      }
      if (entry.action !== 'stale-head') entry.action = entry.findings ? 'auto-ruled' : 'escalated';
    } catch (e) { entry.action = 'failed'; entry.error = clean(e?.message); }
    results.push(entry);
  }
  if (prs.length > 8) results.push({ num: 0, action: 'escalated', findings: 0, operatorKept: prs.length - 8,
    error: 'PR read budget exhausted; remaining PRs stay in the operator queue' });
  return results;
}
