/** Read-only item query (#4198); reuse the shared source, stores and PR map. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createAgentActivityReader, claudeProjectsDir, projectSlugFor } from './agent-activity-io.mjs';
import { buildPrToCardMap } from './pr-ownership-io.mjs';
import { listCompletionSessions, tryReadCompletion, resolveCompletionsDir } from './completion-store.mjs';
import { tryReadRun, resolveRunsDir } from './run-store.mjs';
import { jobLogPath, reviewJobsDir } from './review-job-store.mjs';
import { parseSessionSlug } from '../conveyor/session-slug.mjs';
import { CONSTELLATION_REPOS, capableRepos } from '../lib/constellation-repos.mjs';
import { itemSelector, selectItemActivity } from './item-activity.mjs';

export function createItemActivityReader({
  readSources = createAgentActivityReader(), completionsDir = resolveCompletionsDir(),
  runsDir = resolveRunsDir(), jobsDir = reviewJobsDir(), projectsDir = claudeProjectsDir(),
  listCompletions = () => listCompletionSessions(completionsDir),
  readCompletion = (slug) => tryReadCompletion(slug, completionsDir),
  readRun = (id) => tryReadRun(id, runsDir),
  exec = execFileSync, now = Date.now, prToCard, metadata,
  viewPr = (repo, number) => JSON.parse(exec('gh', ['pr', 'view', String(number), '--repo', CONSTELLATION_REPOS[repo].slug,
    '--json', 'number,title,headRefName'], { encoding: 'utf8', timeout: 30_000 })),
  // Card ids can live only in branch names, which GitHub's PR text search does not cover.
  // Bulk-read candidates once per repo; only identities beyond this bounded window need individual views.
  listPrs = (repo) => JSON.parse(exec('gh', ['pr', 'list', '--repo', CONSTELLATION_REPOS[repo].slug,
    '--state', 'all', '--limit', '10000', '--json', 'number,title,headRefName'],
  { encoding: 'utf8', timeout: 30_000 })),
} = {}) {
  return (input) => {
    const selector = itemSelector(input);
    const { rows } = readSources(input);
    const gaps = [];
    const completions = [];
    for (const slug of listCompletions()) {
      try { const record = readCompletion(slug); if (record) completions.push(record); }
      catch (error) { gaps.push(`${slug}: completion unreadable: ${error.message}`); }
    }
    let map = prToCard;
    if (map === undefined) {
      const repos = metadata ? metadata.map((r) => ({ repo: r.repo, prs: [...r.prs] })) : [];
      if (!metadata) {
        const wanted = new Map();
        const add = (repo, number) => wanted.set(`${repo}:${number}`, { repo, number });
        if (selector.pr) add(selector.repo, selector.pr);
        else {
          for (const repo of Object.keys(capableRepos())) {
            try {
              const prs = listPrs(repo, selector.card);
              if (!Array.isArray(prs)) throw new Error('expected PR array');
              repos.push({ repo, prs });
              if (prs.length === 10000) gaps.push(`${repo}: candidate PR listing may be truncated`);
            } catch (error) { gaps.push(`${repo}: required PR metadata unavailable: ${error.message}`); }
          }
          for (const slug of [...rows.map((r) => r.name ?? r.codexSlug), ...completions.map((r) => r.session)]) {
            const p = parseSessionSlug(slug);
            if (p && !p.itemKind) add(p.repo, Number(p.id));
          }
        }
        for (const { repo, number } of wanted.values()) {
          if (repos.some((r) => r.repo === repo && r.prs.some((p) => Number(p.number) === number))) continue;
          try {
            const pr = viewPr(repo, number);
            if (!pr || Number(pr.number) !== number || typeof pr.title !== 'string' || typeof pr.headRefName !== 'string') throw new Error('invalid PR metadata');
            repos.push({ repo, prs: [pr] });
          } catch (error) { gaps.push(`${repo}:${number}: required PR metadata unavailable: ${error.message}`); }
        }
      }
      map = buildPrToCardMap(repos);
    }
    const selected = selectItemActivity(input, { rows, completions, prToCard: map, gaps });
    const observedAt = now();
    const fileEvidence = (path, issues, label) => {
      try {
        if (!path || !isAbsolute(path)) throw new Error('no absolute recorded path');
        accessSync(path, constants.R_OK);
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error('not a regular file');
        return { transcriptPath: path, lastEventAt: new Date(stat.mtimeMs).toISOString(), transcriptAgeMs: Math.max(0, observedAt - stat.mtimeMs) };
      } catch (error) {
        issues.push(`${label}: transcript unavailable (${error.message})`);
        return { transcriptPath: null, lastEventAt: null, transcriptAgeMs: null };
      }
    };
    const runs = selected.runs.map(({ source, evidenceGaps, ...run }) => {
      let path = source.transcriptPath;
      // A completed detached review has no Claude session. Its primary evidence is the canonical job log.
      if (source.kind === 'review-job' || (source.kind === 'completion' && run.role === 'review' && !source.sessionId)) path = jobLogPath(source.name, jobsDir);
      const primary = fileEvidence(path, evidenceGaps, 'Primary');
      const jurors = [];
      if (run.operationRunId) {
        try {
          const record = readRun(run.operationRunId);
          if (!record) throw new Error('run record missing');
          for (const t of record.telemetry ?? []) {
            let transcript = t.transcriptFile;
            // Only explicit Claude provider evidence permits a Claude session path. Never guess from a Codex thread id.
            if (!transcript && t.servedBackend === 'claude' && t.sessionId && record.input?.cwd) {
              transcript = join(projectsDir, projectSlugFor(record.input.cwd), `${t.sessionId}.jsonl`);
            }
            const pointer = fileEvidence(transcript, evidenceGaps, `Juror ${t.lens ?? t.sessionId ?? 'unknown'}`);
            jurors.push({ sessionId: t.sessionId ?? null, lens: t.lens ?? null, ...pointer });
          }
          if (!jurors.length) evidenceGaps.push('Associated run has no juror telemetry');
        } catch (error) { evidenceGaps.push(`Operation-run evidence unavailable: ${error.message}`); }
      } else if (run.role === 'review') evidenceGaps.push('Operation-run linkage unknown; nested juror evidence unavailable');
      return { ...run, ...primary, jurors, evidenceGaps };
    });
    return { runs, gaps: [...selected.gaps, ...runs.flatMap((r) => r.evidenceGaps.map((g) => `${r.runId}: ${g}`))] };
  };
}
