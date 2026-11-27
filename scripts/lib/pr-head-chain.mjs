/** Per-head authorship facts in the existing PR verdict ledger. Head AND base are required witnesses. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { canonicalRepoSlug } from './repo-slug.mjs';
import { validateLedgerEvent, parseLedgerEvents, verdictLedgerPath, buildLedgerEvent, appendVerdict } from './verdict-ledger.mjs';
import { gitRangeCommits } from './git-pr-commits.mjs';
import { laneGitConfigArgs, scrubInheritedGitEnv } from './lane-git-hardening.mjs';
import { isAiCommit, isAiGeneratedPr, isMechanicalMergeCommit, isDrainBookkeepingCommit } from './ai-pr-authorship.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const HEAD_CHAIN_WRITERS = Object.freeze(['pr-land', 'fix-run', 'rebase-drop', 'await-verify', 'queue-numbering', 'load-flake', 'backfill']);
export const HEAD_CHAIN_INDEX_MAX_BYTES = 16 * 1024 * 1024;
/** Run only in a fresh bare repo. No lane config or inherited history redirection enters the proof. */
export function recordPrHead(input, { env = process.env, scratchRoot = tmpdir(), append = appendVerdict,
  alert = appendHeadChainAlert, warn = s => process.stderr.write(`${s}\n`), now = Date.now, store } = {}) {
  let scratch;
  const repo = canonicalRepoSlug(input?.repo);
  try {
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !HEAD_CHAIN_WRITERS.includes(input.source)
      || !/^[a-f0-9]{40}$/.test(input.headSha ?? '')) throw new Error('invalid-head-input');
    scratch = mkdtempSync(join(scratchRoot, 'pr-head-proof-'));
    const gitEnv = { ...scrubInheritedGitEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['GIT_EXEC_PATH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TEMPLATE_DIR']) delete gitEnv[key];
    const run = args => {
      try { return String(execFileSync('git', [...laneGitConfigArgs(), ...args], { cwd: scratch, env: gitEnv,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })); }
      catch (error) { throw new Error(`git-${args[0]}-failed: ${String(error.stderr ?? error.message).slice(-160)}`); }
    };
    run(['init', '--bare', '--template=']);
    for (const ref of [input.headRef, input.baseRef]) run(['check-ref-format', `refs/heads/${ref}`]);
    run(['fetch', '--no-tags', `https://github.com/${repo}.git`,
      `+refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`, input.headSha]);
    if (run(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('shallow-history');
    if (run(['rev-parse', '--verify', `${input.headSha}^{commit}`]).trim() !== input.headSha) throw new Error('unresolved-head');
    const baseSha = run(['rev-parse', '--verify', `refs/remotes/origin/${input.baseRef}^{commit}`]).trim();
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('unresolved-base');
    const facts = commitFacts(gitRangeCommits(baseSha, input.headSha, { run }));
    const row = buildLedgerEvent({ type: 'author', repo, pr: input.pr, headSha: input.headSha, parentSha: input.parentSha ?? null,
      headRef: input.headRef, baseRef: input.baseRef, baseSha, ...facts, at: new Date(now()).toISOString(),
      source: input.source, writer: input.source, author: input.author ?? input.source });
    if (Buffer.byteLength(JSON.stringify(row)) > 2048) throw new Error('head-row-too-large');
    const result = append(row, store ? { store } : {});
    if (!result?.ok || result.ledgerWriteMiss) throw new Error('ledger-write-miss');
    return { ok: true, row };
  } catch (error) {
    const reason = String(error?.message ?? 'record-unreadable').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
    warn(`head-chain: record-miss ${repo}#${input?.pr}@${String(input?.headSha ?? '').slice(0, 8)} ${reason}; paged fallback required`);
    alert({ kind: 'record-miss', repo, pr: input?.pr, headSha: input?.headSha, reason });
    return { ok: false, reason };
  } finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch { warn('head-chain: scratch-cleanup-miss; operator cleanup required'); }
    }
  }
}
export function headChainLedgerPath(repo) { return verdictLedgerPath(canonicalRepoSlug(repo)); }
export function commitFacts(commits) {
  if (!Array.isArray(commits) || !commits.every(c => /^[a-f0-9]{40}$/.test(c?.oid ?? ''))
    || new Set(commits.map(c => c.oid)).size !== commits.length) throw new Error('invalid-commit-range');
  const substantive = commits.filter(c => !isMechanicalMergeCommit(c) && !isDrainBookkeepingCommit(c));
  return { commits: { count: commits.length, substantive: substantive.length, ai: substantive.filter(isAiCommit).length,
    nonAi: substantive.filter(c => !isAiCommit(c)).map(c => c.oid).slice(0, 20),
    digest: `sha256:${createHash('sha256').update([...new Set(commits.map(c => c.oid))].sort().join('\n')).digest('hex')}` },
  authorship: isAiGeneratedPr({ commits }) ? 'ai' : substantive.length === 0 ? 'none' : 'human' };
}
export function indexPrHeads(rows) {
  const index = new Map();
  for (const raw of rows) {
    if (raw?.type !== 'author' || !raw.headSha) continue;
    // A later invalid/unknown writer row must not revive an earlier matching positive row.
    const key = `${canonicalRepoSlug(raw.repo)}#${raw.pr}@${raw.headSha}`;
    const checked = validateLedgerEvent(raw);
    index.set(key, checked.valid && HEAD_CHAIN_WRITERS.includes(raw.source) ? checked.record : null);
  }
  return index;
}
export function lookupPrHead(index, { repo, pr, headSha, baseSha, headRef, baseRef } = {}) {
  if (!headSha || !baseSha || !headRef || !baseRef) return null;
  const row = index?.get(`${canonicalRepoSlug(repo)}#${pr}@${headSha}`);
  return row && canonicalRepoSlug(row.repo) === canonicalRepoSlug(repo) && row.pr === pr && row.headSha === headSha
    && row.baseSha === baseSha && row.headRef === headRef && row.baseRef === baseRef ? row : null;
}
export function loadHeadChainIndex(repo, { path = headChainLedgerPath(repo), read = readFileSync, stat = statSync, alert = appendHeadChainAlert } = {}) {
  try {
    if (stat(path).size > HEAD_CHAIN_INDEX_MAX_BYTES) throw new Error('index-too-large');
    const text = read(path, 'utf8');
    if (Buffer.byteLength(text) > HEAD_CHAIN_INDEX_MAX_BYTES) throw new Error('index-too-large');
    return indexPrHeads(parseLedgerEvents(text));
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'missing' : error?.message === 'index-too-large' ? 'index-too-large' : 'index-unreadable';
    alert({ kind: reason, repo: canonicalRepoSlug(repo), reason });
    return new Map();
  }
}
/** Bounded diagnostic sink, never authority. Write failures remain visible on stderr. */
export function appendHeadChainAlert(entry, { root = resolveCoordinationRoot(), now = Date.now, warn = s => process.stderr.write(`${s}\n`) } = {}) {
  const path = join(root, 'head-chain', 'alerts.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    let lines = [];
    try {
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error('alerts-too-large');
      lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    writeFileSync(path, [...lines.slice(-1439), JSON.stringify({ ...entry, at: new Date(now()).toISOString() })].join('\n') + '\n');
    return true;
  } catch (error) { warn(`head-chain: alert-write-miss ${error?.code ?? 'unreadable'}; operator inspection required`); return false; }
}
