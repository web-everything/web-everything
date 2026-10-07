/**
 * @file scripts/test-cache/shadow-reporter.mjs
 * @description prepare-124 S2 — the vitest reporter for the shadow test-result cache. It never changes what runs and
 * never fails a run: every step is wrapped, and when the cache is off (CI, GITHUB_ACTIONS, WE_TEST_CACHE=0) it does
 * nothing and writes nothing. Keys are computed when paths are collected (before the files run); results are written in
 * `onFinished`. A CLI `--reporter=...` flag replaces config reporters, so such ad-hoc runs are not logged.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import { cacheDir, cacheEnabled, createKeyContext, keyFor } from '../lib/test-result-cache.mjs';
import { decideShadow, storeAllowedForRun, summarizeFile } from '../lib/test-cache-shadow.mjs';
import { isQuarantined, readEntry, writeEntry, writeQuarantine, writeShadowLog } from '../lib/test-result-store.mjs';

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
        const { record, store, quarantine } = decideShadow({ row, summary, stored, quarantined: isQuarantined(this.dir, rel), run });
        records.push(record);
        if (store) writeEntry(this.dir, row.key, store);
        if (quarantine) writeQuarantine(this.dir, rel, { ...quarantine, at: new Date().toISOString(), runId: run.runId, key: row.key });
      }
      if (records.length) writeShadowLog(this.dir, run.runId, records);
    } catch { /* shadow mode never breaks a run */ }
  }
}
