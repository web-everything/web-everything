/**
 * @file scripts/test-cache/shadow-reporter.mjs
 * @description prepare-124 S2 — the vitest reporter for the shadow test-result cache. It never changes what runs and
 * never fails a run: every step is wrapped, and when the cache is off (CI, GITHUB_ACTIONS, WE_TEST_CACHE=0) it does
 * nothing and writes nothing. Keys are computed when paths are collected (before the files run); results are written in
 * `onFinished`. A CLI `--reporter=...` flag replaces config reporters, so such ad-hoc runs are not logged.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cacheDir, cacheEnabled, createKeyContext, keyFor } from '../lib/test-result-cache.mjs';
import { decideShadow, isFullPass, storeAllowedForRun, summarizeFile } from '../lib/test-cache-shadow.mjs';
import {
  ADMIT_AFTER_CLEAN_RUNS, analyzeTrace, isAdmitted, nextAdmission, readTraceEvents, tmpRootsOf, traceEnabled, traceFileBase, tracedDigest, tracedMap,
} from '../lib/test-cache-trace.mjs';
import { isQuarantined, readAdmission, readEntry, writeAdmission, writeEntry, writeQuarantine, writeShadowLog } from '../lib/test-result-store.mjs';

export function laneName(root) {
  return /\/\.lanes\/[^/]+\/(lane-[^/]+)/.exec(root)?.[1] ?? root.split('/').filter(Boolean).pop() ?? 'unknown';
}

function baseSha(root) {
  try { return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

export default class ShadowReporter {
  constructor({ env = process.env, dir } = {}) {
    this.env = env;
    this.dir = dir;
    this.enabled = cacheEnabled(env);
    this.keys = new Map();
  }

  onInit(ctx) {
    this.ctx = ctx;
    this.root = ctx?.config?.root ?? process.cwd();
    this.dir ??= cacheDir(this.env);
    this.runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${process.pid}-${randomBytes(3).toString('hex')}`;
    // Workers copy this env when they start; the trace setup file reads the run id from it (prepare-124 S3).
    if (this.enabled && traceEnabled(this.env)) this.env.WE_TEST_CACHE_RUN_ID = this.runId;
  }

  /** What the tracer saw for one test file this run, analysed; null when it was not traced. */
  traceFor(rel, closure) {
    if (!this.enabled || !traceEnabled(this.env)) return null;
    const read = readTraceEvents(traceFileBase(this.dir, this.runId, rel));
    if (!read) return null;
    const fuiRoot = this.keyCtx?.fuiRoot ?? null;
    const a = analyzeTrace({
      events: read.events, root: this.root, fuiRoot, closure,
      scriptClosure: this.keyCtx ? (abs) => this.keyCtx.closureOf(abs).files : null,
      tmpRoots: tmpRootsOf([tmpdir(), this.env.TMPDIR, '/tmp', '/private/tmp', '/var/folders']),
      home: homedir(), cacheDir: this.dir,
    });
    return { ...a, tracedMap: tracedMap(a.traced, { root: this.root, fuiRoot }) };
  }

  /** Key every collected file now, before any of them runs. */
  onPathsCollected(paths = []) {
    if (!this.enabled) return;
    try {
      this.keyCtx = createKeyContext({ root: this.root, env: this.env });
      for (const abs of paths) {
        const rel = relative(this.root, abs);
        this.keys.set(rel, keyFor(rel, this.keyCtx));
      }
    } catch { /* shadow mode never breaks a run */ }
  }

  onFinished(files = [], errors = []) {
    if (!this.enabled || !this.ctx) return;
    try {
      const cfg = this.ctx.config ?? {};
      const run = {
        runId: this.runId, lane: laneName(this.root), baseSha: baseSha(this.root),
        storeAllowed: storeAllowedForRun({ testNamePattern: cfg.testNamePattern, shard: cfg.shard, runErrors: errors, watch: cfg.watch }),
      };
      const records = [];
      for (const file of files) {
        const rel = relative(this.root, file.filepath);
        const row = this.keys.get(rel) ?? (this.keyCtx ? keyFor(rel, this.keyCtx) : null);
        if (!row) continue;
        const summary = summarizeFile(file);
        const stored = row.key ? readEntry(this.dir, row.key) : null;
        const analysed = this.traceFor(rel, new Set(this.keyCtx ? this.keyCtx.closureOf(join(this.root, rel)).files : []));
        const prevAdmission = analysed ? readAdmission(this.dir, rel) : null;
        const trace = analysed && {
          denies: analysed.denies, tracedMap: analysed.tracedMap, traced: analysed.traced.length,
          admitted: isAdmitted(prevAdmission), cleanRuns: prevAdmission?.cleanRuns ?? 0,
        };
        const { record, store, quarantine } = decideShadow({ row, summary, stored, quarantined: isQuarantined(this.dir, rel), run, trace });
        records.push(record);
        if (analysed) {
          // Decision F: a clean traced full pass counts toward admission; anything else restarts it.
          const clean = run.storeAllowed && isFullPass(summary) && analysed.denies.length === 0 && !record.falseSkip;
          const next = nextAdmission(prevAdmission, { clean, digest: tracedDigest(analysed.tracedMap), reasons: analysed.denies }, ADMIT_AFTER_CLEAN_RUNS);
          if (run.storeAllowed) writeAdmission(this.dir, rel, { ...next, at: new Date().toISOString(), runId: run.runId });
        }
        if (store) writeEntry(this.dir, row.key, store);
        if (quarantine) writeQuarantine(this.dir, rel, { ...quarantine, at: new Date().toISOString(), runId: run.runId, key: row.key });
      }
      if (records.length) writeShadowLog(this.dir, run.runId, records);
      if (traceEnabled(this.env)) rmSync(join(this.dir, 'traces', this.runId), { recursive: true, force: true });
    } catch { /* shadow mode never breaks a run */ }
  }
}
