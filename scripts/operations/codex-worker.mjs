#!/usr/bin/env node
/* ==================== FOREGROUND ONLY ====================
 * This script is SYNCHRONOUS: it blocks until the delegated Codex task actually completes.
 * Invoke it as a normal FOREGROUND Bash call. NEVER use run_in_background: true.
 * NEVER wrap it in Monitor or a nested wait — there is nothing to watch;
 * the call itself already returns the final result when it finishes.
 * ========================================================= */
/**
 * codex-worker.mjs — codex-direct pilot: a deterministic card-to-PR wrapper, with Codex
 * doing the coding. Standalone prototype; not wired into the production dispatcher.
 * A foreground run can take longer than ten minutes. Live end-to-end validation is
 * separate from the injected orchestration tests.
 *
 * PURE: card/scope parsing, task/branch planning, conflict detection and report formatting.
 * IMPURE: runCodexWorker takes execFileSync-shaped exec, now, appendRecord and log seams.
 * writeFile is also injectable so tests need neither a real lane nor filesystem writes.
 * appendRecord(record, path) persists one JSONL row; now() returns epoch milliseconds.
 * The CLI loads a card/brief relative to this script's repo and invokes the same runner.
 * Dry-run is entirely local planning: live PR occupancy remains explicitly unchecked.
 *
 * node scripts/operations/codex-worker.mjs --card=<id> [--files=<paths>] [--dry-run] [--json]
 * node scripts/operations/codex-worker.mjs --brief-file=<path> --files=<paths> --title=<text>
 * Optional --record-file=<path> overrides ~/workspace/.operations/coordination/codex-pilot.jsonl.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RECORD_FILE = join(homedir(), 'workspace/.operations/coordination/codex-pilot.jsonl');
const MAX_BUFFER = 64 * 1024 * 1024;
// The occupancy listing is fail-closed: a result that reaches this size may be truncated, so it proves nothing.
export const OPEN_PR_LIMIT = 1000;
// Codex can write the lane's .git/config and .git/hooks, which git status/add/commit would then execute
// outside Codex's sandbox. Every wrapper git call pins these over any repo-local value.
export const GIT_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=', '-c', 'commit.gpgSign=false', '-c', 'core.attributesFile=/dev/null'];

// ── pure planning ─────────────────────────────────────────────────────────────

export function parseCard(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const scopeLine = /^scope:\s*(\[[^\n]*\]|[^\n]*)$/m.exec(frontmatter?.[1] ?? '');
  const scope = scopeLine ? JSON.parse(scopeLine[1]) : [];
  if (!Array.isArray(scope) || scope.some((path) => typeof path !== 'string')) {
    throw new Error('Card scope must be a JSON array of strings');
  }
  const status = (/^status:[ \t]*(.*)$/m.exec(frontmatter?.[1] ?? '')?.[1] ?? '')
    .trim().replace(/^(['"])(.*)\1$/, '$2');
  const heading = /^# (.+)$/m.exec(body);
  const rest = heading ? body.slice(heading.index + heading[0].length) : body;
  const doneHeading = /^## Done when[ \t]*$/m.exec(rest);
  const acceptance = doneHeading ? rest.slice(doneHeading.index + doneHeading[0].length) : '';
  return {
    title: heading?.[1].trim() ?? '',
    digest: (doneHeading ? rest.slice(0, doneHeading.index) : rest).trim(),
    doneWhen: acceptance.split(/^(?:## |Hint:)/m)[0].trim(),
    scope, status,
  };
}

function normalizePath(path) {
  return path.replace(/^(?:\.\/)+/, '');
}

export function resolveAllowedFiles({ filesFlag, card, cardPath } = {}) {
  const paths = filesFlag !== undefined ? filesFlag.split(',') : (card?.scope ?? []);
  return [...new Set([...paths, ...(cardPath ? [cardPath] : [])]
    .map((path) => normalizePath(path.trim().replace(/^we:/, ''))).filter(Boolean))];
}

function safeRelativePath(path) {
  return Boolean(path) && !/^(?:[/\\]|[a-z]:)/i.test(path)
    && !path.includes('\0') && !path.split(/[/\\]/).includes('..');
}

export function isAllowed(path, allowed) {
  const normalized = normalizePath(path);
  if (!safeRelativePath(normalized)) return false;
  return allowed.some((entry) => {
    const candidate = normalizePath(entry);
    return safeRelativePath(candidate) && (candidate.endsWith('/')
      ? normalized.startsWith(candidate) : normalized === candidate);
  });
}

export function checkAllowedDiff(changedPaths, allowed) {
  const outside = [...new Set(changedPaths.filter((path) => !isAllowed(path, allowed)))];
  return { ok: outside.length === 0, outside };
}

// Git's core.quotePath uses C escapes (including UTF-8 bytes encoded as octal), not JSON.
function unquoteGitPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes = [];
  const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' };
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length;) {
    if (inner[i] === '\\') {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 1 + octal[0].length;
      } else {
        bytes.push(...Buffer.from(escapes[inner[i + 1]] ?? inner[i + 1] ?? '\\'));
        i += 2;
      }
    } else {
      const char = String.fromCodePoint(inner.codePointAt(i));
      bytes.push(...Buffer.from(char));
      i += char.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function renamePaths(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (quoted && text[i] === '\\') { i++; continue; }
    if (text[i] === '"') quoted = !quoted;
    if (!quoted && text.startsWith(' -> ', i)) return [text.slice(0, i), text.slice(i + 4)];
  }
  return [text];
}

export function parsePorcelain(text) {
  return [...new Set(String(text).split('\n').filter(Boolean).flatMap((line) => {
    const paths = /[RC]/.test(line.slice(0, 2)) ? renamePaths(line.slice(3)) : [line.slice(3)];
    return paths.map(unquoteGitPath);
  }))];
}

/**
 * Everything the lane changed since `baseSha` (the HEAD captured before Codex ran): `dirty` is the working
 * tree + index, `committed` is what Codex committed despite rule 4. Rename detection is off so a rename's
 * SOURCE path is reported too — otherwise a committed `git mv outside/x scripts/x` hides the deletion.
 * `git` is a (...args) => stdout runner already pinned to the lane.
 */
export function collectScopeChanges(git, baseSha) {
  const dirty = parsePorcelain(git('status', '--porcelain=v1', '-uall', '--no-renames'));
  const committed = [...new Set(String(git('diff', '--name-only', '--no-renames', '--no-ext-diff', baseSha, 'HEAD'))
    .split('\n').filter(Boolean).map(unquoteGitPath))];
  return { dirty, committed };
}

export function findScopeConflicts(openPrs, allowed) {
  return openPrs.flatMap((pr) => {
    const files = [...new Set(pr.files.map(({ path }) => path).filter((path) => isAllowed(path, allowed)))];
    return files.length ? [{ number: pr.number, title: pr.title, files }] : [];
  });
}

export const REPO_RULES_PREAMBLE = `1. You are in a lane clone of the repo. Only create/edit files in the ALLOWED list below; any other change makes the whole run be refused. Never edit outside this checkout.
2. Work red-green: first add/adjust a unit test that fails for the missing behaviour, then make it pass.
3. Run tests only via npm run test:unit -- <test files> (never the whole suite).
4. No network except what git/gh need; never npm install. Do not commit, push, or open a PR — the wrapper does that.
5. Keep the diff minimal and in the existing style; read AGENTS.md for repo conventions.
6. If the Done-when is a TODO placeholder, replace it in the card file with a concrete executable line naming the test file(s) that prove the change.
7. End with a short final message: what changed and which tests prove it.`;

export function composeTask({ cardId, title, digest, doneWhen, allowed, briefText }) {
  return `${REPO_RULES_PREAMBLE}\n\n# Card #${cardId ?? 'brief'}: ${title}\n\n## Problem\n${briefText ?? digest ?? ''}\n\n## Done when\n${doneWhen ?? ''}\n\n## Allowed files\n${allowed.join('\n')}\n`;
}

export function planBranch(cardId, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return `lane/codex-${cardId ?? 'brief'}-${slug || 'task'}`;
}

// `redact` drops the per-step detail (local lane/task paths, changed files) for anything published to GitHub.
function stepTable(steps, { redact = false } = {}) {
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [redact ? '| Step | OK | ms |' : '| Step | OK | ms | Detail |', redact ? '| --- | --- | ---: |' : '| --- | --- | ---: | --- |',
    ...steps.map((step) => `| ${cell(step.name)} | ${step.ok ? 'yes' : 'no'} | ${step.ms} |${redact ? '' : ` ${cell(step.detail)} |`}`)].join('\n');
}

export function composePrBody({ cardId, title, doneWhen, allowed, diffStat, codex = {}, steps = [] }) {
  const usage = codex.usage ?? {};
  return `> codex-direct pilot — coded by Codex via scripts/operations/codex-worker.mjs, wrapper-enforced scope guard

${title}

${cardId != null ? `Card: #${cardId}` : 'Card: brief'}

## Done when
${doneWhen ?? ''}

## Allowed files
${allowed.map((path) => `- ${path}`).join('\n')}

## Diffstat
\`\`\`text
${diffStat ?? ''}
\`\`\`

## Codex usage
Input tokens: ${usage.input_tokens ?? 'unknown'}; output tokens: ${usage.output_tokens ?? 'unknown'}; quota used: ${codex.quotaUsedPercent == null ? 'unknown' : `${codex.quotaUsedPercent}%`}.

## Steps
${stepTable(steps, { redact: true })}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

export function buildRunRecord({ cardId, startedAt, finishedAt, steps, codex = {}, pr = null, outcome }) {
  return {
    ts: new Date(finishedAt).toISOString(), card: cardId ?? null,
    minutes: Math.round((new Date(finishedAt) - new Date(startedAt)) / 6000) / 10,
    outcome, pr,
    codex: { threadId: codex.threadId ?? null, usage: codex.usage ?? {}, quotaUsedPercent: codex.quotaUsedPercent ?? null },
    steps: steps.map(({ name, ok, ms, detail }) => ({ name, ok, ms, detail })),
  };
}

export function parseLastJson(stdout) {
  const text = String(stdout ?? '').trimEnd();
  const starts = [...text.matchAll(/^\{/gm)];
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(text.slice(starts[i].index));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* Earlier start may enclose a complete multiline document. */ }
  }
  return null;
}

// ── impure orchestration ──────────────────────────────────────────────────────

function appendRunRecord(record, path) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function errorDetail(error) {
  return [error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(-2000);
}

/** opts supplies the already parsed card/brief (composeTask fields), allowed paths and optional IO roots. */
export function runCodexWorker(opts, {
  exec = execFileSync, now = Date.now, appendRecord = appendRunRecord,
  log = () => {}, writeFile = writeFileSync,
} = {}) {
  const { cardId, title, doneWhen, allowed } = opts;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const startedAt = now();
  const steps = [];
  const branch = planBranch(cardId, title);
  const prTitle = cardId != null ? `${title} (#${cardId})` : title;
  let lane = null, changed = [], dirty = [], baseSha = null, codex = {}, pr = null, record = null;
  let outcome = 'pr-opened';
  const command = (cmd, args, options = {}) => exec(cmd, args, {
    cwd: repoRoot, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: MAX_BUFFER, ...options,
  });
  const git = (...args) => command('git', ['-C', lane.path, ...GIT_HARDENING, ...args]);
  const fail = (name) => {
    if (outcome === 'pr-opened') outcome = `${['free-scope', 'scope-guard'].includes(name) ? 'refused' : 'failed'}:${name}`;
  };
  const step = (name, action) => {
    const start = now();
    const entry = { name, ok: false, ms: 0, detail: '' };
    try {
      entry.detail = String(action() ?? '');
      entry.ok = true;
    } catch (error) {
      entry.detail = errorDetail(error);
      fail(name);
    }
    entry.ms = Number(now()) - Number(start);
    steps.push(entry);
    log(entry);
    return entry.ok;
  };
  const forward = () => {
    if (!step('free-scope', () => {
      // free-scope.mjs has no shared interface yet; use the specified gh query directly.
      const prs = JSON.parse(command('gh', ['pr', 'list', '--repo', opts.repoSlug ?? CONSTELLATION_REPOS.we.slug, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,headRefName,files']));
      // Fail closed: a full page may have dropped an overlapping PR, so "no conflict" would be unproven.
      if (prs.length >= OPEN_PR_LIMIT) throw new Error(`Open PR listing reached its ${OPEN_PR_LIMIT} limit; scope occupancy cannot be proven`);
      const conflicts = findScopeConflicts(prs, allowed);
      if (conflicts.length) throw new Error(conflicts.map((pr) => `#${pr.number}: ${pr.files.join(', ')}`).join('\n'));
      return 'No overlapping open PR files';
    })) return;
    if (!step('lane-acquire', () => {
      let output;
      try {
        output = command('node', ['scripts/lane-pool.mjs', 'acquire', '--purpose=codex-worker', `--item=${cardId ?? 'brief'}`, '--adopt', '--json']);
      } catch (error) {
        lane = parseLastJson(error.stdout);
        throw error;
      }
      lane = parseLastJson(output);
      if (!lane?.path || typeof lane.path !== 'string') throw new Error('Lane acquisition returned no path');
      if (lane.lane == null || !lane.holder) throw new Error('Lane acquisition returned no lane/session release identity');
      // Pin the scope-guard base NOW, before Codex can touch the lane's refs: origin/main is writable by Codex.
      baseSha = String(git('rev-parse', '--verify', 'HEAD^{commit}')).trim();
      if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Could not resolve the lane HEAD before running Codex');
      return lane.path;
    })) return;
    const taskFile = join(lane.path, '.git/codex-worker-task.md');
    if (!step('compose', () => {
      writeFile(taskFile, composeTask(opts), 'utf8');
      return taskFile;
    })) return;
    if (!step('codex', () => {
      let output, executionError;
      try {
        output = command('node', ['scripts/codex-direct-task.mjs', `--task-file=${taskFile}`, `--dir=${lane.path}`, '--gate=standards', '--no-stream', '--json', '--no-install'], { timeout: 45 * 60_000 });
      } catch (error) {
        executionError = error;
        output = error.stdout;
      }
      const report = parseLastJson(output);
      codex = { threadId: report?.events?.threadId ?? null, usage: report?.events?.usage ?? {}, quotaUsedPercent: report?.quotaUsedPercent ?? null, gate: report?.gate ?? null };
      const gate = codex.gate?.pass ?? codex.gate?.ok;
      const detail = `standards gate: ${gate === true ? 'pass' : gate === false ? 'fail' : 'unknown'}`;
      if (executionError) throw new Error(`${errorDetail(executionError)}\n${detail}`);
      if (!report) throw new Error(`No Codex report parsed; ${detail}`);
      if (!report.diff?.hasChanges) throw new Error(`Codex reported no changes; ${detail}`);
      return detail;
    })) return;
    if (!step('scope-guard', () => {
      const scope = collectScopeChanges(git, baseSha);
      dirty = scope.dirty;
      changed = [...new Set([...scope.dirty, ...scope.committed])];
      const guard = checkAllowedDiff(changed, allowed);
      if (!guard.ok) throw new Error(`Outside allowed scope: ${guard.outside.join(', ')}`);
      if (!changed.length) throw new Error('No changed paths');
      return changed.join(', ');
    })) return;
    if (!step('commit', () => {
      // Lanes stay on a detached HEAD (no local branches in pool checkouts); open-pr publishes HEAD to `branch`.
      // Codex may have committed its own work despite rule 4: nothing is left to stage, and `git commit`
      // would fail "nothing to commit". The guard already vetted those commits, so publish them as they are.
      if (!dirty.length) return `Work already committed by Codex; nothing to stage (${branch})`;
      // Stage only the dirty paths: a path deleted in a Codex commit no longer matches a pathspec.
      git('--literal-pathspecs', 'add', '--', ...dirty);
      git('commit', '--no-verify', '-m', `${prTitle}\n\ncodex-direct pilot: coded by Codex, wrapped by scripts/operations/codex-worker.mjs.\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`);
      return branch;
    })) return;
    if (!step('verify', () => {
      // `run.mjs verify` exits 0 even on a RED verdict (live-proven on this wrapper's own PR), so the verdict is read, never the exit code.
      const out = command('node', ['scripts/operations/run.mjs', 'verify', `--checkout=${lane.path}`, '--json'], { timeout: 40 * 60_000 });
      const verdict = parseLastJson(out)?.verdict;
      if (verdict?.ok !== true) throw new Error(`Verify verdict not green: ${JSON.stringify(verdict ?? null).slice(0, 1800)}`);
      return `verify green (${verdict.passed} passed)`;
    })) return;
    step('open-pr', () => {
      const diffStat = String(git('diff', '--stat', '--no-renames', '--no-ext-diff', baseSha, 'HEAD')).trim();
      const bodyFile = join(lane.path, '.git/codex-worker-pr-body.md');
      writeFile(bodyFile, composePrBody({ cardId, title, doneWhen, allowed, diffStat, codex, steps }), 'utf8');
      const output = String(command('node', ['scripts/operations/run.mjs', 'open-pr', `--ref=${branch}`, `--title=${prTitle}`, `--bodyFile=${bodyFile}`, '--json'], { cwd: lane.path, timeout: 40 * 60_000 }));
      // open-pr's --json carries `"pr": <n>` (no URL) — live-proven on this wrapper's own PR; a URL is accepted too.
      const url = /https?:\/\/[^\s"<>\\]+\/pull\/(\d+)/.exec(output);
      const num = url ? Number(url[1]) : Number(/"pr":\s*(\d+)/.exec(output)?.[1] ?? /\bopened #(\d+)/.exec(output)?.[1]);
      if (!num) throw new Error(`No PR number in open-pr output: ${output.slice(-1500)}`);
      pr = { url: url?.[0] ?? `https://github.com/${opts.repoSlug ?? CONSTELLATION_REPOS.we.slug}/pull/${num}`, number: num };
      return pr.url;
    });
  };
  try {
    forward();
  } finally {
    try {
      step('release', () => {
        if (lane?.lane == null || !lane.holder) return 'Skipped: no acquired lane identity';
        command('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane.lane}`, `--session=${lane.holder}`]);
        return `Released lane ${lane.lane}`;
      });
    } finally {
      const start = now();
      const recordStep = { name: 'record', ok: true, ms: 0, detail: opts.recordFile ?? RECORD_FILE };
      steps.push(recordStep);
      // A JSONL row cannot include the duration of its own append. Its ms measures
      // preparation; a failed append is represented in the returned record instead.
      recordStep.ms = Number(now()) - Number(start);
      const buildRecord = () => buildRunRecord({ cardId, startedAt, finishedAt: now(), steps, codex, pr, outcome });
      record = buildRecord();
      try {
        appendRecord(record, opts.recordFile ?? RECORD_FILE);
      } catch (error) {
        recordStep.ok = false;
        recordStep.detail = errorDetail(error);
        fail('record');
        record = buildRecord();
      }
      log(recordStep);
    }
  }
  return { outcome, pr, steps, record };
}

// ── CLI: read-only planning, then the explicitly requested foreground run ──────

function main(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--(card|files|brief-file|title|record-file)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
    else if (arg === '--dry-run' || arg === '--json') flags[arg.slice(2)] = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!flags.card && !flags['brief-file']) throw new Error('Provide --card=<id> or --brief-file=<path>');
  if (flags.card && !/^[a-z0-9]+$/i.test(flags.card)) throw new Error('Card id must be alphanumeric');
  if (flags['brief-file'] && (!flags.files?.trim() || !flags.title?.trim())) throw new Error('--brief-file requires --files and --title');
  let card = {}, cardPath;
  if (flags.card) {
    const matches = readdirSync(join(REPO_ROOT, 'backlog')).filter((name) => name.startsWith(`${flags.card}-`) && name.endsWith('.md'));
    if (matches.length !== 1) throw new Error(`Expected one backlog card for ${flags.card}, found ${matches.length}`);
    cardPath = `backlog/${matches[0]}`;
    card = parseCard(readFileSync(join(REPO_ROOT, cardPath), 'utf8'));
  }
  const allowed = resolveAllowedFiles({ filesFlag: flags.files, card, cardPath });
  if (!allowed.length || allowed.some((path) => !safeRelativePath(path))) throw new Error('Provide a nonempty, checkout-relative allowed scope');
  const opts = {
    cardId: flags.card, title: flags.title ?? card.title, digest: card.digest,
    doneWhen: card.doneWhen ?? '', allowed,
    briefText: flags['brief-file'] ? readFileSync(resolve(REPO_ROOT, flags['brief-file']), 'utf8') : undefined,
    recordFile: flags['record-file'] ? resolve(flags['record-file']) : RECORD_FILE,
  };
  if (!opts.title?.trim()) throw new Error('The card must have a title');
  if (flags['dry-run']) {
    const plan = {
      card: opts.cardId ?? null, branch: planBranch(opts.cardId, opts.title), allowed,
      task: composeTask(opts),
      freeScope: { checked: false, conflicts: findScopeConflicts([], allowed), detail: 'Live PR scope requires gh; deferred until execution' },
    };
    console.log(flags.json ? JSON.stringify(plan, null, 2) : `${plan.task}\nBranch: ${plan.branch}\nFree-scope: ${plan.freeScope.detail}`);
    return 0;
  }
  const result = runCodexWorker(opts);
  console.log(flags.json ? JSON.stringify(result, null, 2) : `${stepTable(result.steps)}\n\n${result.outcome}${result.pr ? `: ${result.pr.url}` : ''}`);
  return result.outcome === 'pr-opened' ? 0 : result.outcome.startsWith('refused:') ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ outcome: 'failed:planning', detail: errorDetail(error) }));
    else console.error(errorDetail(error));
    process.exitCode = 1;
  }
}
