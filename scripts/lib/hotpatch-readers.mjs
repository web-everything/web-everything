/** Bounded production readers shared by prototype-load and direct overlay add. */
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import fs from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  let origin, platform, tool, prepared;
  const prepare = sha => {
    if (prepared === sha) return;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid hotpatch sha');
    // Populate only objects and remote-tracking main; no working tree or lifecycle operation.
    readRepo(['fetch', '--no-tags', 'origin', 'main', sha]);
    if (readRepo(['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha) throw new Error('unreadable hotpatch commit');
    prepared = sha;
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
        if (!Number.isSafeInteger(run.id) || run.status !== 'completed' || run.conclusion !== 'success') return false;
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
        const jobsDef = yaml.safeLoad(readRepo(['show', 'origin/main:.github/workflows/ci.yml']))?.jobs ?? {};
        const expected = [
          jobsDef['test-shard']?.strategy?.matrix?.shard?.length,
          jobsDef['integration-part']?.strategy?.matrix?.group?.length,
          jobsDef['soak-shard']?.strategy?.matrix?.shard?.length,
        ];
        if (!expected.every(n => Number.isInteger(n) && n > 0)) throw new Error('unreadable CI matrix');
        for (const [index, [jobName, stepName]] of groups.entries()) {
          const jobs = data.jobs.filter(j => jobName.test(j.name));
          if (!jobs.length || (index < 3 && jobs.length !== expected[index])) return false;
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
            if (!decisions.length || decisions.some(line => line.includes('→') || !line.includes('running everything'))) return false;
          }
        }
      }
      return true;
    },
    ciPlan: sha => { prepare(sha); return ciUnitPlan(readRepo(['show', 'origin/main:.github/workflows/ci.yml'])); },
    paths: sha => {
      prepare(sha);
      const raw = readRepo(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', `origin/main...${sha}`]);
      if (raw && !raw.endsWith('\0')) throw new Error('incomplete hotpatch diff');
      return raw ? raw.slice(0, -1).split('\0') : [];
    },
    auditOptions: () => ({ now: Date.now(), priorQuestionHashes: resolvePriorQuestionHashes({ env, strict: true, readFile: (p, e) => files.readFileSync(p, e) }) }),
    audits: () => {
      preferences();
      const path = tool.auditRecordPath.replace(/^~\//, `${env.HOME}/`);
      try {
        const body = files.readFileSync(path, 'utf8');
        if (Buffer.byteLength(body) > opts.maxBuffer) throw new Error('audit ledger exceeds 2 MiB; archive old records');
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
      try { readRepo(['merge-base', '--is-ancestor', base, 'origin/main']); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    },
    ruledWeakened: () => {
      preferences();
      const store = readStore({ path: storePath(env), fs: files });
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
