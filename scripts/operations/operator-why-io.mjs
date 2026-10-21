/** Operator decision 2026-10-13: manual intervention without a worker. All why IO is injectable here. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaimReader, REPO_ROOT } from './claim-io.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { cardForPr } from './pr-ownership-io.mjs';
import { checksArgv, parseJsonLines } from './pr-status-io.mjs';
import { defaultReadRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { latestUnresolvedStandDown } from '../conveyor/stand-down-answer-core.mjs';
import { standDownReason } from '../conveyor/stand-down.mjs';
import { listFixDispatchClaims, fixDispatchSessionName } from '../conveyor/fix-claim-store.mjs';
import { isClaimSessionLive } from '../conveyor/fix-dispatch-claim.mjs';
import { listBuildDispatchHolds } from '../conveyor/build-dispatch-claim.mjs';
import { listBuildBackoffs } from '../conveyor/build-dispatch-failures.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { listDaemonPlistFiles, readPlistAsJson, extractDaemonSpec, classifyDaemonSpec, tailFile } from './daemon-status-io.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { evaluatePr, rulingNeededRow, redTeamRulingRow } from './operator-queue.mjs';
import { orderReadyCandidates } from '../merge-ai-prs.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { explainWhy, lastMentionLine, commentPreview } from './operator-why.mjs';
import { readRedTeamStatusRecord, redTeamStatusDir } from '../lib/drain-red-team-evidence.mjs';

// Prefer the live head; otherwise retain usable history and report each failed candidate.
function readWhyRedTeam({ repo, pr, head, env, listFiles, readText, readStat, safe }) {
  const dir = redTeamStatusDir(env), prefix = `${encodeURIComponent(repo)}-${Number(pr)}-`;
  const files = listFiles(dir).filter(file => file.startsWith(prefix) && /^[a-f0-9]{40}\.json$/i.test(file.slice(prefix.length)));
  const liveFile = files.find(file => file.slice(prefix.length, -5) === head);
  const candidates = (liveFile ? [liveFile] : files).map(file => safe('red team', () => {
    const candidateHead = file.slice(prefix.length, -5);
    const candidate = readRedTeamStatusRecord({ repo, pr, head: candidateHead, env, readText, readStat });
    const { record, at } = candidate;
    if (record?.repo !== repo || Number(record.pr) !== Number(pr) || record.head !== candidateHead
      || typeof record.status !== 'string' || !Number.isFinite(at)) throw new Error(`invalid red-team status record: ${file}`);
    return candidate;
  }, null)).filter(Boolean).sort((a, b) => b.at - a.at);
  if (!candidates.length) {
    if (!files.length) throw new Error('no red-team status record for PR');
    return null;
  }
  const { record, at } = candidates[0];
  // The writer has no updatedAt field; the drain also uses the status file's mtime.
  return { head: record.head, state: record.status, verdict: record.result ?? null,
    updatedAt: new Date(at).toISOString(), isLiveHead: Boolean(head) && record.head === head };
}

export function createWhyReader({
  root = REPO_ROOT, home = homedir(), coordinationRoot = resolveCoordinationRoot(), run = execFileSync,
  listFiles = readdirSync, readText = path => readFileSync(path, 'utf8'), pathExists = existsSync,
  env = process.env, readStat = statSync,
  tail = tailFile, listPlists = listDaemonPlistFiles, readPlist = path => readPlistAsJson(path, { exec: run }),
  readCard = createClaimReader({ root, listFiles, readText, exec: run }),
  readComments = (pr, repo) => readCompletePrComments(pr, { repo, exec: run }),
  readRequiredChecks = repo => defaultReadRequiredStatusChecks({ repo, gh: args => String(run('gh', args, { encoding: 'utf8', timeout: 60000 })) }),
  readChecks = (repo, sha) => parseJsonLines(run('gh', checksArgv({ repo, sha }), { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })),
  readClaims = () => listFixDispatchClaims(join(coordinationRoot, 'fix-dispatch-claims')),
  readBuildHolds = () => listBuildDispatchHolds({ lockRoot: join(coordinationRoot, 'build-dispatch-holds'), nowMs: now() }),
  readBackoffs = () => { const path = join(coordinationRoot, 'build-dispatch-failures.json'); if (pathExists(path)) JSON.parse(readText(path)); return listBuildBackoffs({ path, now: now() }); },
  // readFailureState repairs corrupt ledgers by renaming them. Read its format without that mutation.
  readPrepareFailures = () => { const path = join(coordinationRoot, 'prepare-failures.json'); return pathExists(path) ? JSON.parse(readText(path)) : { failures: {} }; },
  readAgents = () => JSON.parse(run('claude', ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 })),
  listPrs = (repo, { state = 'open' } = {}) => JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--state', state, '--limit', '10000', '--json', 'number,title,headRefName,labels,state'], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })),
  now = Date.now,
} = {}) {
  return ({ pr = 0, item = '', repo }) => {
    const subject = { kind: pr ? 'pr' : 'item', id: pr || item.trim() }, gaps = [];
    const safe = (source, fn, fallback) => { try { return fn(); } catch (error) { gaps.push({ source, error: String(error?.message ?? error).split('\n')[0] }); return fallback; } };
    const facts = { subject, repo, gaps };
    const key = repoKeyForSlug(repo) ?? repo;
    const allPrs = safe(pr ? 'open PRs' : 'linked PRs', () => { const rows = listPrs(repo, { state: pr ? 'open' : 'all' }); if (!Array.isArray(rows)) throw new Error('expected PR array'); if (rows.length >= 10000) gaps.push({ source: pr ? 'open PRs' : 'linked PRs', error: 'listing may be truncated' }); return rows; }, []);
    if (pr) {
      facts.pr = safe('PR state', () => JSON.parse(run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,state,isDraft,labels,headRefOid,mergeable,statusCheckRollup'], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })), {});
      facts.redTeam = safe('red team', () => readWhyRedTeam({ repo, pr, head: facts.pr.headRefOid, env, listFiles, readText, readStat, safe }), null);
      const comments = safe('comments', () => readComments(pr, repo), null);
      facts.recentComments = (comments ?? []).slice(-3).map(c => ({ createdAt: c.createdAt,
        author: c.author?.login ?? null,
        body: commentPreview(c.body) }));
      if (comments) {
        facts.pr.comments = comments;
        facts.standDown = safe('stand-down', () => { const c = latestUnresolvedStandDown(comments); return c ? { ...c, reason: standDownReason(c.body) ?? 'unknown' } : null; }, null);
        facts.roundExtensions = safe('round extensions', () => countGrantedRoundExtensions(comments, { repo, pr }), null);
      }
      const required = safe('required checks', () => readRequiredChecks(repo), null);
      const checks = facts.pr.headRefOid ? safe('head checks', () => readChecks(repo, facts.pr.headRefOid), null) : null;
      if (!facts.pr.headRefOid) gaps.push({ source: 'head checks', error: 'PR head unavailable' });
      facts.checksUnavailable = !required || !checks;
      facts.checks = required && checks ? (required.checks ?? required).map(name => {
        const latest = checks.filter(c => c.name === name).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
        return latest ?? { name, conclusion: 'missing' };
      }) : [];
      if (comments) facts.queueSection = safe('operator queue', () => {
        const evaluation = evaluatePr(facts.pr);
        const human = (facts.pr.labels ?? []).some(l => (l.name ?? l) === 'review:human');
        return rulingNeededRow(repo, facts.pr) || redTeamRulingRow(repo, facts.pr) ? 'RULING NEEDED'
          : evaluation.ready ? 'NEEDS YOU' : facts.standDown ? 'STOOD DOWN' : human ? evaluation.transient ? 'PENDING' : `NOT READY: ${evaluation.reasons.join('; ')}` : 'not in the queue';
      }, 'classification unavailable');
      // Reuse the drain's pure ready-age ordering; label-age/priority context is explicitly unavailable here.
      const ready = allPrs.filter(p => (p.labels ?? []).some(l => (l.name ?? l) === 'ready-to-merge')).map(p => ({ ...p, num: p.number }));
      const ordered = orderReadyCandidates(ready, { now: now() }).ordered;
      facts.mergePosition = ordered.findIndex(p => p.num === pr) + 1 || null;
      facts.mergeOrdering = 'drain orderReadyCandidates (ready-age; ages/priority facts unknown; PR-number tie-break)';
    } else {
      facts.card = safe('card', () => { const card = readCard({ ref: item }); if (card.found === false) throw new Error('card not found'); return { ...card, type: card.type ?? readField(card.content ?? '', 'type') ?? readField(card.content ?? '', 'kind') }; }, {});
      facts.linkedPrs = allPrs.filter(p => String(cardForPr(p)) === subject.id).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number);
      // A single linked PR uses the same explanation, without enumerating all ownership sessions/lanes.
      if (facts.card.status === 'active' && facts.linkedPrs[0]) {
        const linkedFacts = createWhyReader({ root, home, coordinationRoot, run, listFiles, readText, pathExists, env, readStat, tail, listPlists, readPlist, readCard, readComments, readRequiredChecks, readChecks, readClaims, readBuildHolds, readBackoffs, readPrepareFailures, readAgents, listPrs, now })({ pr: facts.linkedPrs[0].number, repo });
        facts.linkedPrs[0] = { ...facts.linkedPrs[0], explanation: explainWhy(linkedFacts) };
        gaps.push(...linkedFacts.gaps.map(g => ({ ...g, source: `linked PR ${g.source}` })));
      }
    }
    const claims = safe('fix claims', () => readClaims(), []).filter(c => [key, repo].includes(c.meta?.repo) && c.meta?.pr === pr && ['fix', 'ci-heal'].includes(c.meta.kind));
    let agents = null;
    if (claims.length) agents = safe('claim sessions', () => { const result = readAgents(); const rows = result.agents ?? result; if (!Array.isArray(rows)) throw new Error('expected agents array'); return rows; }, null);
    facts.claims = claims.map(c => {
      const session = c.meta.who ?? fixDispatchSessionName({ repo: key, pr, kind: c.meta.kind });
      return { ...c, session, kind: c.meta.kind, live: agents ? isClaimSessionLive({ repo: key, pr, kind: c.meta.kind, agentsAll: agents, name: session }) : null };
    });
    const itemId = pr ? cardForPr(allPrs.find(p => p.number === pr)) : subject.id;
    const matches = r => String(r.num ?? r.meta?.num) === String(itemId) && (!r.meta?.repo || [key, repo].includes(r.meta.repo));
    facts.buildHolds = safe('build holds', () => readBuildHolds(), []).filter(matches);
    facts.backoffs = safe('build backoffs', () => readBackoffs(), []).filter(matches);
    facts.prepareFailures = Object.values(safe('prepare failures', readPrepareFailures, { failures: {} }).failures ?? {}).filter(matches).sort((a, b) => Number(Boolean(b.held && !b.completed)) - Number(Boolean(a.held && !a.completed)) || String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')));
    const workspace = join(home, 'workspace'), reviewRoot = join(workspace, 'wev-review-daemon', '.conveyor');
    const paths = { fix: join(workspace, 'wev-fix-daemon', '.conveyor', 'fix-dispatch-daemon.log'), review: join(reviewRoot, 'review-daemon.log'), drain: join(workspace, 'plateau-app', '.drain-daemon', 'daemon.log'), builder: join(coordinationRoot, 'build-dispatch-daemon.log') };
    const launchDir = join(home, 'Library', 'LaunchAgents');
    for (const label of safe('daemon plists', () => { const entries = listFiles(launchDir); return listPlists(launchDir, { readdir: () => entries }); }, [])) {
      safe(`plist ${label}`, () => {
        const plist = readPlist(join(launchDir, `${label}.plist`)); if (!plist) throw new Error('unreadable plist');
        const spec = extractDaemonSpec(label, plist), family = classifyDaemonSpec(spec);
        const name = spec.programArguments.some(a => a.endsWith('/build-dispatch-daemon.mjs')) ? 'builder' : ({ 'fix-dispatch-daemon': 'fix', 'review-daemon': 'review', 'build-dispatch-daemon': 'builder', 'drain-daemon': 'drain' })[family.kind] ?? (family.kind === 'pass-daemon' ? `pass:${family.pass}` : null);
        if (name && spec.logPath) paths[name] = spec.logPath;
      });
    }
    for (const file of safe('pass logs', () => listFiles(reviewRoot), [])) if (/^pass-daemon\..*\.log$/.test(file)) paths[`pass:${file.slice(12, -4)}`] ??= join(reviewRoot, file);
    facts.logs = Object.entries(paths).map(([name, path]) => ({ name, path, kb: 512, line: safe(`log ${name}`, () => {
      const result = tail(path, { maxBytes: 512 * 1024 }); if (!result || result.error) throw new Error(result?.error ?? 'log missing');
      return lastMentionLine(result.text, subject);
    }, null) }));
    return facts;
  };
}
