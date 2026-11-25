/** Bounded production readers shared by prototype-load and direct overlay add. */
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import fs from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { resolvePriorQuestionHashes } from '../operations/codex-audit.mjs';
import { ciUnitPlan } from '../operations/urgent-verify-marker.mjs';
import { mergeRuledWeakened } from '../operations/prototype-load.mjs';
import { readStore, storePath, withdrawnRevocations } from '../operations/ruled-weakened-store.mjs';
import { resolveOriginRepository } from '../operations/prototype-retire.mjs';
import { laneHistoryProofEnv, scrubGitLocationEnv } from './lane-git-hardening.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { ciJobLogApiArgs } from './gh-ci-log.mjs';
import { readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { resolveHotpatchKnobs } from './hotpatch-guards.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mainRef = 'refs/remotes/origin/main';
const maxAuditBytes = 16 * 1024 * 1024;
// Legacy quarantine logs have several zero-skip reasons. Unknown reasons and any emitted exclusions refuse.
const noQuarantineSkips = line => {
  const reason = stripVTControlCharacters(line).split('red-main-quarantine skip:')[1]?.trim();
  return !!reason && !reason.includes('→') && /^(?:redMainMode is (?:stop|quarantine)(?: \([^\r\n]*\))?(?: — running everything)?|(?:quarantine list unreadable \([^\r\n]*\)|job context unknown|this PR's changed files are unknown|error \([^\r\n]*\)) — running everything|main runs every test|no live quarantine entry|PR #\d+ is the main-fix PR — it runs the quarantined tests|skipping 0 quarantined test file\(s\)(?:; [^\r\n]*)?)$/.test(reason);
};
export function createHotpatchReaders({ cwd = root, env = process.env, exec = execFileSync, files = fs } = {}) {
  const opts = { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 };
  // Read-only git only (fetch objects, rev-parse, show, diff, merge-base): never a publish, so no push-gate site.
  const injected = exec;
  const readRepo = args => String(injected('git', args, { ...opts, env: laneHistoryProofEnv(scrubGitLocationEnv(env)) }));
  let calls = 0;
  const gh = args => {
    if (++calls > 100) throw new Error('hotpatch API budget exceeded');
    return { code: 0, stdout: String(execFileSyncThrottled('gh', args, { ...opts,
    throttle: { caller: 'hotpatch-admission', noMemo: true, ...(exec !== execFileSync ? { exec: (a, o) => exec('gh', a, o) } : {}) } })) };
  };
  let origin, platform, tool;
  const prepare = sha => {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid hotpatch sha');
    // A reader instance can outlive an admission. Refresh main on every git evidence read,
    // including repeated reads of the same head; a failed refresh must never reuse old evidence.
    // Populate only objects and remote-tracking main; no working tree or lifecycle operation.
    readRepo(['fetch', '--no-tags', 'origin', `+refs/heads/main:${mainRef}`, sha]);
    if (readRepo(['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha) throw new Error('unreadable hotpatch commit');
  };
  const preferences = () => {
    if (!platform) {
      const read = readPlatformPreferences({ env, readFile: (p, e) => files.readFileSync(p, e) });
      if (read.errors.length) throw new Error('unreadable hotpatch preferences');
      platform = read.prefs;
      tool = JSON.parse(files.readFileSync(join(root, 'scripts/settings/prototype-load.json'), 'utf8'));
    }
  };
  const api = path => {
    origin ??= resolveOriginRepository({ git: args => ({ code: 0, stdout: readRepo(args) }), gh });
    if (!origin.repo) throw new Error('unreadable hotpatch repository');
    const r = origin.gh(['api', `repos/${origin.repo}/${path}`]);
    if (r.code !== 0) throw new Error('unreadable hotpatch CI');
    return JSON.parse(r.stdout);
  };
  return {
    checks: sha => api(`commits/${sha}/check-runs?filter=all&per_page=100`),
    workflows: sha => api(`actions/runs?head_sha=${sha}&per_page=100`),
    fullSuite: (sha, workflows) => {
      const ci = workflows.workflow_runs.filter(r => r.head_sha === sha && r.path === '.github/workflows/ci.yml');
      if (!ci.length) throw new Error('missing CI execution');
      for (const run of ci) {
        if (!Number.isSafeInteger(run.id) || !['push', 'merge_group', 'workflow_dispatch'].includes(run.event)
          || run.status !== 'completed' || run.conclusion !== 'success') return false;
        const data = api(`actions/runs/${run.id}/jobs?filter=all&per_page=100`);
        if (!Number.isInteger(data.total_count) || data.total_count < 1 || data.total_count > 100
          || !Array.isArray(data.jobs) || data.jobs.length !== data.total_count) throw new Error('incomplete CI jobs');
        const groups = [
          [/^test-shard \(/, /^Unit suite /],
          [/^integration-part \(/, /^Real-git integration suite /],
          [/^soak-shard \(/, /^Soak shard /],
          [/^smoke$/, /^(?:Build WE docs \(deploy smoke\)|Interaction lane)$/],
        ];
        // Expected matrix size comes from the (unchanged-checked) CI definition: a partial matrix never passes.
        prepare(sha);
        const jobsDef = yaml.safeLoad(readRepo(['show', `${mainRef}:.github/workflows/ci.yml`]))?.jobs ?? {};
        const expected = [
          jobsDef['test-shard']?.strategy?.matrix?.shard,
          jobsDef['integration-part']?.strategy?.matrix?.group,
          jobsDef['soak-shard']?.strategy?.matrix?.shard,
        ];
        if (!expected.every(values => Array.isArray(values) && values.length > 0 && values.length <= 64
          && values.every(v => typeof v === 'string' || Number.isSafeInteger(v))
          && new Set(values.map(String)).size === values.length)) throw new Error('unreadable CI matrix');
        if (new Set(data.jobs.map(j => j.id)).size !== data.jobs.length) throw new Error('duplicate CI jobs');
        for (const [index, [jobName, stepName]] of groups.entries()) {
          const jobs = data.jobs.filter(j => jobName.test(j.name));
          if (!jobs.length || (index < 3 && jobs.length !== expected[index].length)) return false;
          if (index < 3) {
            const prefix = ['test-shard', 'integration-part', 'soak-shard'][index];
            if (!expected[index].every(value => jobs.filter(j => j.name === `${prefix} (${value})`).length === 1)) return false;
          }
          for (const job of jobs) {
            if (!Number.isSafeInteger(job.id) || job.head_sha !== sha || job.status !== 'completed' || job.conclusion !== 'success'
              || !Array.isArray(job.steps) || !job.steps.some(s => stepName.test(s.name) && s.status === 'completed' && s.conclusion === 'success')) return false;
            if (job.name === 'smoke') {
              if (!['Build WE docs (deploy smoke)', 'Interaction lane'].every(name => job.steps.some(s => s.name === name && s.status === 'completed' && s.conclusion === 'success'))) return false;
              continue;
            }
            const log = origin.gh(ciJobLogApiArgs(`repos/${origin.repo}/actions/jobs/${job.id}/logs`));
            if (log.code !== 0) throw new Error('unreadable execution log');
            const decisions = log.stdout.split('\n').filter(line => line.includes('red-main-quarantine skip:'));
            if (!decisions.length || !decisions.every(noQuarantineSkips)) return false;
          }
        }
      }
      return true;
    },
    ciPlan: sha => { prepare(sha); return ciUnitPlan(readRepo(['show', `${mainRef}:.github/workflows/ci.yml`])); },
    paths: sha => {
      prepare(sha);
      // The PR delta alone misses CI changes made on main after the head diverged. Compare the executed
      // head tree too, since fullSuite derives its expected execution plan from main's CI definition.
      const paths = [`${mainRef}...${sha}`, `${mainRef}..${sha}`].flatMap(range => {
        const raw = readRepo(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', range]);
        if (raw && !raw.endsWith('\0')) throw new Error('incomplete hotpatch diff');
        return raw ? raw.slice(0, -1).split('\0') : [];
      });
      return [...new Set(paths)];
    },
    auditOptions: () => ({ now: Date.now(), priorQuestionHashes: resolvePriorQuestionHashes({ env, strict: true, readFile: (p, e) => files.readFileSync(p, e) }) }),
    audits: () => {
      preferences();
      const path = tool.auditRecordPath.replace(/^~\//, `${env.HOME}/`);
      try {
        const body = files.readFileSync(path, 'utf8');
        if (Buffer.byteLength(body) > maxAuditBytes) throw new Error('audit ledger exceeds 16 MiB; archive old records');
        return body.split('\n').filter(line => line.trim()).map(line => {
          const record = JSON.parse(line);
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid audit record');
          return record;
        });
      }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    covers: (base, sha) => {
      prepare(sha);
      try { readRepo(['merge-base', '--is-ancestor', base, mainRef]); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    },
    ruledWeakened: () => {
      preferences();
      const store = readStore({ path: storePath(env), fs: files, warn: message => { throw new Error(message); } });
      if (store.error) throw new Error('unreadable audit rulings');
      const revoked = withdrawnRevocations({ fs: files, env });
      return [...mergeRuledWeakened(platform.prototypeLoad?.ruledWeakened, tool.ruledWeakened), ...store.entries].filter(e => !revoked(e));
    },
    settings: () => {
      preferences();
      const layers = { platform: platform.hotpatch, tool: JSON.parse(files.readFileSync(join(root, 'scripts/settings/hotpatch.json'), 'utf8')),
        envValues: Object.fromEntries(['liveWhen', 'auditBar', 'receiptSource', 'parallel'].map(k => {
          const v = env[`WE_HOTPATCH_${k.replace(/[A-Z]/g, x => `_${x}`).toUpperCase()}`];
          return [k, k === 'parallel' && ['true', 'false'].includes(v) ? v === 'true' : v];
        })) };
      console.error(formatCascadeSourcesLine('hotpatch', resolveHotpatchKnobs(layers)));
      return layers;
    },
  };
}

/** Pre-wiring smoke probe: run explicitly on the target host with a full head SHA. It never admits or publishes.
 * Every reader is attempted even if an earlier read fails; absence of an own-sha base is an incomplete smoke.
 * Fetching objects/remote-tracking main is the same preparation as normal readers (no working-tree writes).
 */
export async function smokeHotpatchReaders(sha, readers = createHotpatchReaders()) {
  const values = {}, report = {};
  const read = async (name, ...args) => {
    try {
      values[name] = await readers[name](...args);
      report[name] = { ok: values[name] !== false };
    } catch (error) { report[name] = { ok: false, error: String(error.message ?? error) }; }
  };
  for (const name of ['settings', 'checks', 'workflows', 'ciPlan', 'paths', 'auditOptions', 'audits', 'ruledWeakened']) await read(name, sha);
  await read('fullSuite', sha, values.workflows);
  const base = Array.isArray(values.audits) ? values.audits.find(r => typeof r?.head === 'string' && r.head.toLowerCase() === sha)?.base : null;
  if (base) await read('covers', base, sha);
  else report.covers = { ok: false, error: 'missing own-sha audit base; supply a head with audit evidence' };
  return { ok: Object.values(report).every(r => r.ok), readers: report };
}
