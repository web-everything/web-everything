/** Graduate a source slice through the existing import, verify and open-pr homes. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const GRADUATE_CHAIN_OP = 'graduate-chain';
const testPath = p => /(?:^|\/)__(?:tests|fixtures)__\//.test(p) || /\.test\.[^/]+$/.test(p);
const lines = s => String(s).trim().split('\n').filter(Boolean);
const json = r => JSON.parse(r.stdout);
const stop = (reason, detail = {}) => { throw Object.assign(new Error(reason), { reason, detail }); };

function validateInput(input) {
  if (typeof input.purpose !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(input.purpose)
    || typeof input.title !== 'string' || !input.title.trim()
    || typeof input.source !== 'string' || input.source.includes('...')
    || input.source.split('..').length > 2 || input.source.split('..').some(p => !p || p.startsWith('-'))
    || (input.stackOn && !/^\d+$/.test(String(input.stackOn)))) stop('input');
  return input;
}

/** Parse numstat strictly; binary or incomplete evidence requires a human split. */
export function measureSize(text) {
  const files = lines(text).map(line => {
    const [a, d, ...path] = line.split('\t');
    if (!/^\d+$/.test(a) || !/^\d+$/.test(d) || !path.length) stop('size-unreadable');
    const file = path.join('\t');
    return { file, lines: Number(a) + Number(d), test: testPath(file) };
  });
  return { nonTest: files.filter(f => !f.test).reduce((n, f) => n + f.lines, 0),
    test: files.filter(f => f.test).reduce((n, f) => n + f.lines, 0), files: files.length, entries: files };
}

export function suggestedSplit(entries) {
  const groups = [];
  for (const f of entries.filter(f => !f.test)) {
    const directory = f.file.split('/')[0];
    if (f.lines > 300) {
      for (let remaining = f.lines, part = 1; remaining > 0; remaining -= 300, part++) {
        groups.push({ directory, files: [f.file], nonTest: Math.min(remaining, 300), requiresManualSplit: true, part });
      }
      continue;
    }
    let group = groups.find(g => g.directory === directory && g.nonTest + f.lines <= 300);
    if (!group) groups.push(group = { directory, files: [], nonTest: 0 });
    group.files.push(f.file); group.nonTest += f.lines;
  }
  return groups;
}

/** All command IO is injected; filesystem resources are supplied by the tiny IO shell. */
export function runGraduateChain(input, { exec, cwd, env = {}, capsTool, capsPlatform,
  cascadePolicy, extractSubmitResult, readTemplate, writeBody, mergeEnvironment = () => ({}), cleanup = () => {} }) {
  const out = { ok: false, pr: null, branch: `lane/${input.purpose}`, sha: null,
    stopReason: null, steps: [], size: { nonTest: 0, test: 0, files: 0 } };
  let lane;
  const command = (step, cmd, args, dir = cwd, extra = {}, allowFailure = false) => {
    out.steps.push({ step, cmd, args });
    const r = exec(cmd, args, { cwd: dir, env: { ...env, ...extra } });
    if (!allowFailure && r.status !== 0) stop(step, { detail: String(r.stderr || 'command failed').slice(-1000) });
    return r;
  };
  const git = (step, args, dir = cwd, extra = {}) => command(step, 'git', args, dir, extra).stdout.trim();
  const node = (step, args, dir = cwd, extra = {}) => command(step, 'node', args, dir, extra);
  const would = (step, text) => out.steps.push({ step, would: text });
  try {
    validateInput(input);
    const repo = command('repo', 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).stdout.trim();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) stop('repo');
    const caps = cascadePolicy('graduation.openPrCaps', capsTool, {
      standard: { callerMax: 4, repoMax: 18 }, platform: capsPlatform, env,
      envValues: { callerMax: env.WE_GRADUATION_CALLER_MAX === undefined ? undefined : Number(env.WE_GRADUATION_CALLER_MAX),
        repoMax: env.WE_GRADUATION_REPO_MAX === undefined ? undefined : Number(env.WE_GRADUATION_REPO_MAX) },
      valid: v => Number.isSafeInteger(v) && v > 0,
    });
    out.capSources = caps.sources; out.caps = caps.value;
    const prs = json(command('caps', 'gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,author,headRefName', '--limit', '1000']));
    const user = json(command('caps', 'gh', ['api', 'user']));
    if (!Array.isArray(prs) || prs.length >= 1000 || !user.login || prs.some(p => !p.author?.login)) stop('caps-unreadable');
    if (prs.filter(p => p.author.login === user.login).length >= caps.value.callerMax) stop('cap-caller');
    if (prs.length > caps.value.repoMax) stop('cap-repo');
    let baseRef = 'main';
    let base = git('source', ['rev-parse', '--verify', 'origin/main^{commit}']);
    if (input.stackOn) {
      const pr = json(command('source', 'gh', ['pr', 'view', String(input.stackOn), '--repo', repo, '--json', 'headRefName,headRefOid,isCrossRepository']));
      if (!pr.headRefName || !/^[0-9a-f]{40,64}$/.test(pr.headRefOid) || pr.isCrossRepository !== false) stop('stack-base');
      baseRef = pr.headRefName; base = pr.headRefOid;
    }
    const parts = input.source.split('..');
    const tip = git('source', ['rev-parse', '--verify', `${parts.at(-1)}^{commit}`]);
    const start = parts.length === 2 ? git('source', ['rev-parse', '--verify', `${parts[0]}^{commit}`])
      : git('source', ['merge-base', 'origin/main', tip]);
    const range = `${start}..${tip}`;
    const commits = lines(git('source', ['rev-list', '--reverse', '--topo-order', range]));
    if (!commits.length) stop('empty-source');
    if (!input.dryRun) {
      lane = json(node('acquire', ['scripts/lane-pool.mjs', 'acquire', `--purpose=${input.purpose}`, '--json']));
      if (!Number.isInteger(lane.lane) || !lane.path || !lane.holder) stop('acquire-invalid');
      const session = { LANE_SESSION: lane.holder };
      if (input.stackOn) git('fetch', ['fetch', 'origin', base], lane.path, session);
      git('fetch', ['fetch', cwd, ...(input.stackOn ? [] : [base]), start, tip], lane.path, session);
    } else would('acquire', 'acquire a lane');
    const checkCwd = lane?.path || cwd;
    const merged = command('merge-tree', 'git', ['merge-tree', '--write-tree', '--name-only', `--merge-base=${start}`, base, tip],
      checkCwd, mergeEnvironment(git('merge-objects', ['rev-parse', '--git-path', 'objects'], checkCwd), checkCwd), true);
    if (merged.status === 1) stop('conflict', { files: lines(merged.stdout.split('\n\n')[0]).slice(1) });
    if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(lines(merged.stdout)[0] || '')) stop('merge-tree');
    let sizeRange = range;
    if (!input.dryRun) {
      const session = { LANE_SESSION: lane.holder };
      git('base', ['reset', '--hard', base], lane.path, session);
      git('cherry-pick', ['cherry-pick', ...commits], lane.path, session);
      out.sha = git('sha', ['rev-parse', 'HEAD'], lane.path);
      sizeRange = `${base}..${out.sha}`;
    } else { out.sha = tip; would('cherry-pick', `apply ${commits.join(' ')} over ${base}`); }
    const measured = measureSize(git('size', ['diff', '--numstat', '--no-renames', sizeRange], lane?.path || cwd));
    const { entries, ...size } = measured; out.size = size;
    if (size.nonTest > 300) stop('too-large', { suggestedSplit: suggestedSplit(entries),
      fallback: 'Split the source into smaller ranges; oversized files require a manual hunk split.' });
    if (input.dryRun) {
      for (const step of ['import-check', 'verify', 'body', 'push', 'open-pr', 'release']) would(step, step);
      out.ok = true;
    } else {
      const imported = command('import-check', 'node', ['scripts/graduation-import-check.mjs', `--snapshot=${out.sha}`, '--json'], lane.path, {}, true);
      let imports;
      try { imports = json(imported); } catch { stop('import-check'); }
      if (imported.status !== 0 || !Array.isArray(imports.findings) || imports.findings.length) stop('import-check');
      // build.finalGate comes from the settings cascade inside verify; no override is set here.
      const verified = command('verify-unrun', 'node', ['scripts/operations/run.mjs', 'verify', `--checkout=${lane.path}`, '--json'], lane.path,
        { WE_HEAVY_ADMISSION_CEILING_MS: env.WE_HEAVY_ADMISSION_CEILING_MS || '7200000' }, true);
      let verdict;
      try { verdict = json(verified).verdict; } catch { stop('verify-unrun'); }
      if (!verdict || !Array.isArray(verdict.checks) || !verdict.checks.length || verdict.checks.some(c => !['pass', 'fail'].includes(c.outcome))) stop('verify-unrun');
      if (verdict.checks.some(c => c.outcome === 'fail')) stop('verify-red');
      if (verified.status !== 0 || verdict.ok !== true) stop('verify-unrun');
      const values = { commits: git('body', ['log', '--oneline', range]),
        diffStat: git('body', ['diff', '--stat', sizeRange], lane.path), testResult: 'verify: pass', audit: input.audit || 'not supplied' };
      const template = input.bodyTemplate ? readTemplate(input.bodyTemplate) : 'Commits:\n{{commits}}\n\n{{diffStat}}\n\nTests: {{testResult}}\nAudit: {{audit}}\n';
      const bodyFile = writeBody(template.replace(/\{\{(commits|diffStat|testResult|audit)\}\}/g, (_, key) => values[key]));
      git('push', ['push', 'origin', `HEAD:refs/heads/${out.branch}`], lane.path, { LANE_SESSION: lane.holder });
      const opened = command('open-pr', 'node', ['scripts/operations/run.mjs', 'open-pr', `--ref=${out.branch}`, `--base=${baseRef}`,
        `--title=${input.title}`, `--bodyFile=${bodyFile}`, `--sha=${out.sha}`, '--json'], lane.path, { LANE_SESSION: lane.holder }, true);
      const submitted = extractSubmitResult(json(opened));
      out.pr = submitted.pr ?? null;
      if (opened.status !== 0 || submitted.outcome !== 'opened' || !Number.isInteger(out.pr) || out.pr <= 0) stop('open-pr');
      out.ok = true;
    }
  } catch (e) { out.stopReason = e.reason || 'unreadable'; Object.assign(out, e.detail || {}); }
  finally {
    if (lane?.lane !== undefined) {
      try {
        const released = json(node('release', ['scripts/lane-pool.mjs', 'release', `--lane=${lane.lane}`, `--session=${lane.holder}`, '--json']));
        if (released.released !== 1) stop('release');
      }
      catch { out.ok = false; out.stopReason = 'release'; out.releaseFailed = true; }
    }
    try { cleanup(); } catch { out.ok = false; out.stopReason ||= 'cleanup'; }
  }
  return out;
}

export function graduateChainOperation({} = {}) {
  const input = Object.fromEntries(['source', 'purpose', 'title'].map(k => [k, { type: 'string', required: true }]));
  for (const k of ['body-template', 'stack-on', 'audit']) input[k] = { type: 'string', required: false, default: '' };
  input['dry-run'] = { type: 'boolean', required: false, default: false };
  return op(GRADUATE_CHAIN_OP, { input, verdictFrom: 'result',
    plan: compute({
      reads: Object.keys(input).map(k => `input.${k}`), fn: view => validateInput({ ...view.input,
        bodyTemplate: view.input['body-template'], stackOn: view.input['stack-on'], dryRun: view.input['dry-run'] }),
    }),
    run: effect({
      reads: ['findings.plan'],
      effects: view => [{ type: 'graduate-chain.run', idempotent: false, payload: view.findings.plan }],
    }),
    result: compute({
      reads: ['findings.run'], fn: view => view.findings.run.effects[0].result,
    }),
  });
}

export function finishGraduateChain({ run, code, lines }) {
  return run?.verdict ? { code: run.verdict.ok ? 0 : 1, lines: [JSON.stringify(run.verdict)] } : { code, lines };
}
