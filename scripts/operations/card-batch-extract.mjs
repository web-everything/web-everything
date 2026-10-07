/**
 * Extract one review-rejected card from a sealed card batch into its own PR (#4703, xuz8m83).
 *
 * One card is one file is one commit, so a review finding's file path names exactly one batch member. That card goes
 * onto its own ref from main, parked `review:changes` with the findings (the normal fix loop owns it from there). The
 * other cards are rebuilt onto a fresh batch ref from main and handed to the existing seal job. The old PR is closed
 * with pointers to both. Nothing is force-pushed; no approval or verify receipt carries over (new heads, new PRs).
 * A finding that cites no card file, a non-card file, or more than one card holds the batch for a person.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLease, atomicRecord, tokenOf } from './card-batch-io.mjs';
import { CARD_BATCH_STATE_DIR, HOLD_LABEL, batchExec } from './card-batch-seal-io.mjs';
import { extractSubmitResult } from './open-pr.mjs';
import { parseRunJsonTail } from './land-prevention-card.mjs';
import { cardOnlyEligibility } from '../lib/card-batch-policy.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const MARKER = 'Card-Batch: ';
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const HUMAN_LABEL = 'review:human';
export const BATCH_REF_PREFIX = 'lane/card-batch-';
export const isCardBatchRef = ref => typeof ref === 'string' && ref.startsWith(BATCH_REF_PREFIX);
const refuse = reason => ({ action: 'refuse', reason });
const hold = reason => ({ action: 'hold', reason });

/** Cited paths of one finding: `file` and/or `files`, normalised; empty when it cites nothing. */
function citedPaths(finding) {
  const raw = [finding?.file, ...(Array.isArray(finding?.files) ? finding.files : [])];
  return raw.filter(path => typeof path === 'string' && path.trim()).map(path => path.trim().replace(/^\.\//, ''));
}

/**
 * Pure attribution. `members` carry `cardPath`. Every finding must cite a card file of this batch, and all findings
 * together must name exactly one card; anything else holds with a reason (nothing is guessed or dropped).
 */
export function attributeFindings({ findings, members }) {
  if (!Array.isArray(findings) || findings.length === 0) return hold('no findings to attribute');
  const cited = new Set();
  for (const finding of findings) {
    const paths = citedPaths(finding);
    if (paths.length === 0) return hold('a finding cites no file, so it cannot be attributed to one card');
    for (const path of paths) {
      if (!members.some(member => member.cardPath === path)) {
        return hold(`a finding cites ${path}, which is not a card file of this batch`);
      }
      cited.add(path);
    }
  }
  if (cited.size !== 1) return hold(`findings cite ${cited.size} card files (${[...cited].join(', ')}); exactly one is required`);
  const [path] = cited;
  return {
    action: 'extract',
    member: members.find(member => member.cardPath === path),
    survivors: members.filter(member => member.cardPath !== path),
  };
}

/** Markdown for the standalone PR's finding comment. */
export function renderFindingsBody({ findings, source }) {
  const lines = findings.map(finding => {
    const where = finding.file ? `\`${finding.file}${finding.line != null ? `:${finding.line}` : ''}\` — ` : '';
    return `- ${where}${finding.summary ?? finding.message ?? finding.title ?? finding.body ?? '(no text)'}`;
  });
  return `Extracted from card batch PR ${source.repo}#${source.pr}. The review findings that rejected this card:\n\n${lines.join('\n')}\n`;
}

/** Locate the sealed (or active) batch state for a PR number. Returns `{ path, state }` or null. */
export function findBatchState({ stateDir = CARD_BATCH_STATE_DIR, pr }) {
  for (const dir of [stateDir, join(stateDir, 'sealed')]) {
    let files;
    try { files = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try {
        const state = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (state.batchRef && Number(state.pr) === Number(pr)) return { path: join(dir, file), state };
      } catch { /* unreadable states are skipped; the seal scan reports them */ }
    }
  }
  return null;
}

const readJSON = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/** Git in a private bare scratch repo, with fixed identity and optional fixed dates so rebuilt commits are repeatable. */
const scratchGit = (cwd, date) => (args, options = {}) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, ...options,
  env: { ...process.env, GIT_AUTHOR_NAME: 'Card batch', GIT_AUTHOR_EMAIL: 'card-batch@localhost',
    GIT_COMMITTER_NAME: 'Card batch', GIT_COMMITTER_EMAIL: 'card-batch@localhost',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});

/** The one push argv: a plain create of a fresh ref, never forced (no flags, no `+` refspec). */
export const pushArgs = (target, { sha, ref }) => ['push', target, `${sha}:refs/heads/${ref}`];

/** Message carried over; the Card-Batch marker is re-pointed at the new batch ref so admission recovery still reads it. */
function rebrandMessage(message, batchRef) {
  return message.split('\n').map(line => {
    if (!line.startsWith(MARKER)) return line;
    try { return `${MARKER}${JSON.stringify({ ...JSON.parse(line.slice(MARKER.length)), batchRef })}`; } catch { return line; }
  }).join('\n');
}

/**
 * Run (or resume) an extraction. `exec` runs gh / node run.mjs; git runs for real against `remote`.
 * Returns `{ action: 'extracted' | 'hold' | 'refuse', ... }`.
 */
export async function extractCard(input, opts = {}) {
  const { stateDir = CARD_BATCH_STATE_DIR, exec = batchExec, clock = Date.now, remote = 'origin', base = 'main',
    leaseMs = 60 * 60_000, crashAt } = opts;
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new TypeError('remote must not be empty or start with "-"');
  const found = input.statePath ? { path: resolve(input.statePath), state: readJSON(input.statePath) } : findBatchState({ stateDir, pr: input.pr });
  if (!found?.state?.batchRef) return refuse('unknown-batch');
  const old = found.state;
  const repo = old.repo ?? old.members?.[0]?.source?.repo ?? input.repo;
  const kind = old.kind ?? input.kind;
  const repoDir = resolve(input.laneDir ?? ROOT);
  const journalPath = join(stateDir, 'extractions', `${repo.replaceAll('/', '-')}-${old.pr ?? input.pr}.json`);
  mkdirSync(dirname(journalPath), { recursive: true });
  const lockPath = `${journalPath}.lock`;
  const now = () => new Date(clock()).getTime();
  const lease = acquireLease(lockPath, `extract:${process.pid}:${randomUUID()}`, now(), leaseMs);
  if (!lease) return refuse('lease-held');
  const held = () => tokenOf(lockPath) === lease.token && now() < lease.expiresAt;
  const checkpoint = step => { if (crashAt === step) throw new Error(`card batch extract crash: ${step}`); };
  const gh = args => opts.gh ? opts.gh(args, { cwd: repoDir }) : exec('gh', args, { cwd: repoDir });
  let scratch;
  const bodyFiles = [];
  const bodyFile = text => {
    const path = join(tmpdir(), `card-batch-extract-${randomUUID()}.md`);
    writeFileSync(path, text);
    bodyFiles.push(path);
    return path;
  };
  try {
    let journal = readJSON(journalPath) ?? { pr: old.pr, repo, kind, batchRef: old.batchRef };
    const save = () => {
      if (!held()) throw new Error('lease-held');
      atomicRecord(journalPath, journal);
    };
    // The hold is journaled first (so it stays terminal), then its two GitHub effects are each journaled once done, so a
    // rerun after a failed `gh` call finishes whichever effect is still owed instead of returning silently.
    const completeHold = async () => {
      // Comment first, label last: the label is what marks the hold as seen, so it must not land while the comment is owed.
      if (!journal.heldCommented) {
        await gh(['pr', 'comment', String(old.pr), '--repo', repo, '--body-file',
          bodyFile(`Card extraction held for a person: ${journal.held.reason}. Nothing was extracted or dropped.\n`)]);
        journal.heldCommented = true;
        save();
      }
      if (!journal.heldLabelled) {
        await gh(['pr', 'edit', String(old.pr), '--repo', repo, '--add-label', HUMAN_LABEL]);
        journal.heldLabelled = true;
        save();
      }
      return hold(journal.held.reason);
    };
    if (journal.done) return { action: 'extracted', journal };
    if (journal.held) return await completeHold(); // awaited: `finally` must not release the lease mid-effect
    if (!old.sealedAt && !old.seal) return refuse('batch-not-sealed');
    if (!COMMIT_ID.test(String(old.headSha))) return refuse('head-mismatch');

    scratch = mkdtempSync(join(tmpdir(), 'card-extract-'));
    const git = scratchGit(scratch);
    const aliases = scratchGit(repoDir)(['remote']).trim().split('\n');
    let target = remote;
    if (aliases.includes(remote)) target = scratchGit(repoDir)(['remote', 'get-url', '--push', remote]).trim();
    if (!isAbsolute(target) && !/^[\w+.-]+:\/\//.test(target) && !/^[^/]+:/.test(target)) target = resolve(repoDir, target);
    if (target.startsWith('-')) throw new TypeError('remote url must not start with "-"');
    git(['init', '--bare', '-q', scratch]);

    // Built objects live only in this scratch repo, so a plan that never finished pushing is rebuilt. It is rebuilt on
    // the SAME base it was planned on: a push may already have landed one ref, and a newer main would change its sha.
    // The extracted card is pinned with it: a retry's findings may differ, but refs already pushed name this card.
    const pinnedBase = journal.plan && !journal.pushed ? journal.plan.baseSha : null;
    const pinnedCard = pinnedBase ? journal.plan.standalone.member : null;
    if (pinnedBase) journal.plan = null;
    // ── PLAN (once): attribute, then compute every ref and commit so a rerun reproduces identical shas.
    if (!journal.plan) {
      const advertised = git(['ls-remote', '--refs', target, `refs/heads/${old.batchRef}`]).trim().split(/\s+/)[0];
      if (advertised !== old.headSha) return refuse('head-mismatch');
      git(['fetch', '--no-tags', target, `refs/heads/${old.batchRef}`]);
      git(['fetch', '--no-tags', target, `refs/heads/${base}`]);
      let baseSha = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim();
      if (pinnedBase && pinnedBase !== baseSha) {
        // Reuse the planned base while it is still part of main's history; otherwise (main was rewritten) plan afresh.
        try { git(['merge-base', '--is-ancestor', pinnedBase, baseSha]); baseSha = pinnedBase; } catch { /* plan on current main */ }
      }
      const members = old.members.map(member => {
        git(['merge-base', '--is-ancestor', member.commitSha, old.headSha]);
        const rows = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', member.commitSha]).split('\0').filter(Boolean);
        if (rows.length !== 2 || rows[0] !== 'A') throw new Error(`member ${member.cardId} is not a one-file add`);
        const cardPath = rows[1];
        const mode = git(['ls-tree', member.commitSha, '--', cardPath]).split(' ')[0];
        if (!cardOnlyEligibility([{ status: 'A', mode, path: cardPath }]).ok) throw new Error(`member ${member.cardId} is not an eligible card`);
        return { ...member, cardPath };
      });
      const planned = pinnedCard && members.find(member => member.cardId === pinnedCard);
      const attribution = planned
        ? { action: 'extract', member: planned, survivors: members.filter(member => member !== planned) }
        : attributeFindings({ findings: input.findings, members });
      if (attribution.action === 'hold') {
        journal.held = { reason: attribution.reason, at: new Date(now()).toISOString() };
        save();
        return await completeHold();
      }
      const build = (parentSha, member, message, date) => {
        git(['read-tree', parentSha]);
        if (git(['ls-tree', parentSha, '--', member.cardPath]).trim()) throw new Error(`${member.cardPath} already exists on the new parent`);
        const blob = git(['rev-parse', `${member.commitSha}:${member.cardPath}`]).trim();
        git(['update-index', '--add', '--cacheinfo', '100644', blob, member.cardPath]);
        const tree = git(['write-tree']).trim();
        return scratchGit(scratch, date)(['commit-tree', tree, '-p', parentSha], { input: message }).trim();
      };
      const messageOf = member => git(['show', '-s', '--format=%B', member.commitSha]);
      const dateOf = member => git(['show', '-s', '--format=%cI', member.commitSha]).trim();
      const standaloneRef = `lane/card-extract-${attribution.member.cardId}-${attribution.member.commitSha.slice(0, 7)}`;
      const standaloneSha = build(baseSha, attribution.member, messageOf(attribution.member), dateOf(attribution.member));
      const generation = (old.generation ?? 0) + 1;
      const remainderRef = `${old.batchRef.replace(/-r\d+$/, '')}-r${generation}`;
      let parent = baseSha;
      const survivors = [];
      for (const member of attribution.survivors) {
        parent = build(parent, member, rebrandMessage(messageOf(member), remainderRef), dateOf(member));
        const { cardPath, ...rest } = member;
        survivors.push({ ...rest, commitSha: parent });
      }
      // The findings that rejected the extracted card are pinned with it. A resumed plan keeps the findings it was made
      // from; only a fresh attribution (no pinned card, or it vanished from the batch) takes this invocation's.
      if (!planned || !journal.findings) journal.findings = input.findings;
      journal.plan = {
        baseSha, standalone: { ref: standaloneRef, sha: standaloneSha, member: attribution.member.cardId },
        remainder: survivors.length ? { ref: remainderRef, sha: parent, generation, members: survivors } : null,
      };
      save();
      checkpoint('planned');
    }

    // ── PUSH: plain pushes only; an existing ref must already be at the planned sha.
    const { plan } = journal;
    const refs = [plan.standalone, plan.remainder].filter(Boolean);
    if (!journal.pushed) {
      for (const [index, entry] of refs.entries()) {
        const advertised = git(['ls-remote', '--refs', target, `refs/heads/${entry.ref}`]).trim().split(/\s+/)[0];
        if (advertised && advertised !== entry.sha) return refuse('ref-exists');
        if (advertised) continue;
        if (!held()) return refuse('lease-held');
        try { git(pushArgs(target, entry)); }
        catch (error) {
          if (/\[rejected\]|non-fast-forward|fetch first|cannot lock ref/.test(String(error.stderr))) return refuse('ff-reject');
          throw error;
        }
        checkpoint(`push-${index}`);
      }
      journal.pushed = true;
      save();
      checkpoint('pushed');
    }

    // ── OPEN: a PR may already exist for the head from a crashed run, so look before opening.
    const openParked = async (ref, sha, body) => {
      const listed = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', ref, '--state', 'all', '--json', 'number']) || '[]');
      if (listed[0]?.number) return listed[0].number;
      let report;
      try {
        report = parseRunJsonTail(await exec('node', [join(repoDir, 'scripts/operations/run.mjs'), 'open-pr', `--ref=${ref}`,
          `--sha=${sha}`, `--bodyFile=${bodyFile(body)}`, '--mode=park', '--json'], { cwd: repoDir, timeout: 45 * 60_000 }));
      } catch (error) { report = parseRunJsonTail(error.stdout); if (!report) throw error; }
      const submit = extractSubmitResult(report);
      if (submit.outcome !== 'opened' || !submit.pr) throw new Error(submit.reason ?? 'open-pr unrun');
      return submit.pr;
    };
    const source = { repo, pr: old.pr };
    if (!journal.standalonePr) {
      journal.standalonePr = await openParked(plan.standalone.ref, plan.standalone.sha,
        `Card ${plan.standalone.member} extracted from card batch ${repo}#${old.pr}; parked for the fix loop.\n`);
      save();
      checkpoint('standalone-open');
    }
    if (!journal.standaloneLabelled) {
      await exec('node', [join(repoDir, 'scripts/conveyor/reconcile-finding.mjs'), String(journal.standalonePr),
        `--body-file=${bodyFile(renderFindingsBody({ findings: journal.findings ?? input.findings, source }))}`, `--repo=${repo}`,
        '--agent=card-batch-extract'], { cwd: repoDir, timeout: 3 * 60_000 });
      journal.standaloneLabelled = true;
      save();
    }
    if (plan.remainder && !journal.remainderPr) {
      journal.remainderPr = await openParked(plan.remainder.ref, plan.remainder.sha,
        `Card-only batch ${plan.remainder.ref} (rebuilt from ${old.batchRef} after card ${plan.standalone.member} was extracted)\n\n${
          plan.remainder.members.map(member => `- ${member.cardId} — ${member.source.repo}#${member.source.pr}`).join('\n')}\n`);
      save();
      checkpoint('remainder-open');
    }
    // The remainder is a fresh batch: new manifest in `sealed/` (so the seal scan resumes it), no verify marker,
    // no approval. The hold label keeps the green draft from landing before the seal job re-verifies it.
    if (plan.remainder && !journal.remainderState) {
      if (!journal.holdApplied) {
        await gh(['pr', 'edit', String(journal.remainderPr), '--repo', repo, '--add-label', HOLD_LABEL]);
        journal.holdApplied = true;
        save();
      }
      const sealedDir = join(stateDir, 'sealed');
      mkdirSync(sealedDir, { recursive: true });
      const remainderPath = join(sealedDir, `${repo.replaceAll('/', '-')}-${old.seq}r${plan.remainder.generation}-${kind}.json`);
      atomicRecord(remainderPath, {
        kind, repo, seq: old.seq, generation: plan.remainder.generation, batchRef: plan.remainder.ref,
        headSha: plan.remainder.sha, openedAt: old.openedAt, members: plan.remainder.members,
        pr: journal.remainderPr, holdApplied: true, sealedAt: new Date(now()).toISOString(),
        seal: { reason: 'extracted' }, extractedFrom: { pr: old.pr, batchRef: old.batchRef },
      });
      journal.remainderState = remainderPath;
      save();
    }
    if (!journal.closed) {
      const pointers = [`standalone: ${repo}#${journal.standalonePr} (card ${plan.standalone.member})`,
        plan.remainder ? `remaining cards: ${repo}#${journal.remainderPr}` : 'no cards remain'];
      await gh(['pr', 'close', String(old.pr), '--repo', repo, '--comment',
        `Closed: a review finding rejected one card, so this batch was split.\n\n${pointers.map(line => `- ${line}`).join('\n')}\n`]);
      journal.closed = true;
      save();
    }
    // The old manifest records where its cards went; it is already terminal, so this is audit only.
    if (basename(dirname(found.path)) === 'sealed') {
      atomicRecord(found.path, { ...old, extractedTo: { standalone: journal.standalonePr, remainder: journal.remainderPr ?? null } });
    }
    journal.standaloneManifest = { pr: journal.standalonePr, ref: plan.standalone.ref, members: [plan.standalone.member] };
    journal.done = true;
    save();
    return { action: 'extracted', journal };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    for (const path of bodyFiles) rmSync(path, { force: true });
    if (tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true });
  }
}
