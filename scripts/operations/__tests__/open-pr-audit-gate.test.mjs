import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { classifySubmit } from '../open-pr.mjs';
import { admitCanonicalAudit } from '../../pr-land.mjs';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const message = `no canonical codex-audit record for ${sha}. Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${sha}`;
function runner(canonicalAudit) {
  const spawn = vi.fn(() => ({ status: 0, stdout: '{"pr":7}' }));
  const review = vi.fn(() => ({ action: 'pass' }));
  const run = createPrLandRunner({ canonicalAudit, prePrReview: review, spawn, env: {}, prepGate: () => ({ ok: true }), readPrepBody: () => '' });
  return { run, spawn, review };
}

// Keep both producers' default checker. Replace only filesystem/process effects in a child,
// never the checker or evaluator; no real Git, credentials, network, or .git writes.
function defaultProducer({ direct = false, dry = false, records = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'default-audit-gate-'));
  const trace = join(dir, 'effects.jsonl');
  const preload = join(dir, 'effects.mjs');
  const audit = join(dir, 'audit.jsonl');
  const prefs = join(dir, 'prefs.json');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  writeFileSync(audit, records.map(r => JSON.stringify(r)).join('\n'));
  writeFileSync(prefs, '{}');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    // The audited checkout (dir) has no scripts/settings at all, like a sibling repo: the gate must read
    // the settings beside the audit writer in this checkout, never <target>/scripts/settings.
    fs.readFileSync = (path, ...args) => String(path) === ${JSON.stringify(join(root, 'scripts/settings/prototype-load.json'))}
      ? JSON.stringify({ auditRecordPath: ${JSON.stringify(audit)} }) : read(path, ...args);
    cp.execFileSync = (cmd, args) => {
      fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([cmd, args]) + '\\n');
      if (cmd !== 'git') throw new Error('unexpected process: ' + cmd);
      const c = args[0] === '-C' ? args.slice(2) : args;
      const a = c[0] === '--no-replace-objects' ? c.slice(1) : c;
      if (a[0] === 'rev-parse') return ${JSON.stringify(sha)};
      if (a[0] === 'fetch' && a.join(' ') === 'fetch origin main') return '';
      if (a[0] === 'fetch') throw new Error("couldn't find remote ref");
      if (a[0] === 'merge-base') return a.includes('--is-ancestor') ? '' : ${JSON.stringify(base)};
      if (a[0] === 'diff') return a.includes('--name-only') ? 'docs/guide.md\\n'
        : a.includes('--name-status') ? 'M\\tdocs/guide.md\\n'
        : 'diff --git a/docs/guide.md b/docs/guide.md\\n+documentation only\\n';
      throw new Error('unexpected git: ' + a.join(' '));
    };
    syncBuiltinESMExports();
  `);
  const argv = [`--repo=${dir}`, '--ref=lane/audit', `--sha=${sha}`, '--title=docs: update guide', '--body=Documentation update', '--json', ...(dry ? ['--dry-run'] : [])];
  let entry = join(root, 'scripts/pr-land.mjs');
  if (!direct) {
    entry = join(dir, 'open.mjs');
    writeFileSync(entry, `
      import { createPrLandRunner } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/operations/open-pr-io.mjs')).href)};
      import { appendFileSync } from 'node:fs';
      const run = createPrLandRunner({ cwd: ${JSON.stringify(dir)}, env: process.env,
        prePrReview: () => ({ action: 'pass' }), prepGate: () => ({ ok: true }),
        spawn: (_cmd, args) => {
          appendFileSync(${JSON.stringify(trace)}, JSON.stringify(['publication', args]) + '\\n');
          return { status: 0, stdout: '{"pr":7}' };
        } });
      console.log(JSON.stringify(run({ argv: ${JSON.stringify(argv)} })));
    `);
  }
  try {
    let status = 0, stdout;
    try {
      stdout = execFileSync(process.execPath, ['--import', preload, entry, ...argv], {
        cwd: dir, env: { ...process.env, WE_PLATFORM_PREFERENCES_FILE: prefs, WE_POLICY_CASCADE_LOG: '0' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      status = error.status; stdout = String(error.stdout || '');
      if (!stdout.trim()) throw new Error(`producer exited ${status}: ${String(error.stderr || error.message)}`);
    }
    return { status, result: JSON.parse(stdout.trim()), effects: readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('default canonical checker integration', () => {
  it.each([false, true])('default open-pr checker refuses missing evidence for docs-only changes, dry=%s', dry => {
    const { result, effects } = defaultProducer({ dry });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'canonical-audit-missing' });
    expect(result.detail).toContain(`codex-audit --base=origin/main --head=${sha}`);
    expect(effects.some(([cmd, args]) => cmd === 'publication' || args.includes('push'))).toBe(false);
  });
  it.each([false, true])('direct pr-land default checker refuses missing evidence before publication for docs-only changes, dry=%s', dry => {
    const { status, result, effects } = defaultProducer({ direct: true, dry });
    expect(status).toBe(3);
    expect(result).toMatchObject({ merged: false, reason: 'canonical-audit-missing' });
    expect(result.detail).toContain(`codex-audit --base=origin/main --head=${sha}`);
    expect(effects.some(([cmd, args]) => cmd !== 'git' || args.includes('push'))).toBe(false);
  });
  it('default open-pr admits an audited unpublished local head and delegates publication', () => {
    const record = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
    const { result, effects } = defaultProducer({ records: [record, { ...record, head: 'c'.repeat(40), fingerprint: 'd'.repeat(64) }] });
    expect(result.outcome).toBe('opened');
    expect(effects.filter(([cmd]) => cmd === 'publication')).toHaveLength(1);
    expect(effects.find(([cmd]) => cmd === 'publication')[1]).toContain(`--sha=${sha}`);
    expect(effects.some(([, args]) => args.includes('fetch') && args.some(arg => arg.includes('refs/heads/lane/audit')))).toBe(false);
  });
  it('direct pr-land default checker admits an audited unpublished local head in dry-run', () => {
    const record = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
    const { status, result, effects } = defaultProducer({ direct: true, dry: true,
      records: [record, { ...record, head: 'c'.repeat(40), fingerprint: 'd'.repeat(64) }] });
    expect(status).toBe(0);
    expect(result.reason).toBe('dry-run');
    expect(effects.some(([, args]) => args.includes('fetch') && args.some(arg => arg.includes('refs/heads/lane/audit')))).toBe(false);
    expect(effects.some(([, args]) => args.includes('push'))).toBe(false);
  });
});
describe('open-pr canonical gate', () => {
  it.each([false, true])('refuses without spawning including dry run=%s', dry => {
    const check = vi.fn(() => ({ ok: false, reason: 'canonical-audit-missing', message }));
    const { run, spawn, review } = runner(check);
    expect(run({ argv: ['--ref=lane/audit', ...(dry ? ['--dry-run'] : [])] })).toEqual({ outcome: 'refused', reason: 'canonical-audit-missing', detail: message });
    expect(spawn).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledOnce();
    if (!dry) expect(review.mock.invocationCallOrder[0]).toBeLessThan(check.mock.invocationCallOrder[0]);
  });
  it('reports WEAKENED without spawning', () => {
    const { run, spawn } = runner(() => ({ ok: false, reason: 'canonical-audit-weakened', message }));
    expect(run({ argv: ['--ref=lane/audit', '--dry-run'] }).reason).toBe('canonical-audit-weakened');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])('allows a real green record and pins the published sha, dry run=%s', dry => {
    const record = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
    const { run, spawn } = runner(request => checkCanonicalAuditForOpen({ ...request,
      env: { WE_PLATFORM_PREFERENCES_FILE: '/prefs' }, exec: () => sha, fetchMain: () => {}, ancestor: () => true, liveFingerprint: () => null,
      readFile: path => path === '/prefs' ? '{}' : path.endsWith('prototype-load.json') ? '{"auditRecordPath":"audit.jsonl"}' : JSON.stringify(record),
    }));
    expect(run({ argv: ['--ref=lane/audit', ...(dry ? ['--dry-run'] : [])] }).outcome).toBe('opened');
    expect(spawn.mock.calls[0][1]).toContain(`--sha=${sha}`);
  });
  it('check failures and incomplete decisions refuse without spawning', () => {
    for (const check of [() => { throw new Error('unreadable'); }, () => undefined]) {
      const { run, spawn } = runner(check);
      expect(run({ argv: ['--ref=lane/audit'] }).reason).toBe('canonical-audit-missing');
      expect(spawn).not.toHaveBeenCalled();
    }
  });
  it.each(['canonical-audit-missing', 'canonical-audit-weakened'])('classifies direct pr-land %s refusals', reason => {
    expect(classifySubmit({ status: 3, stdout: JSON.stringify({ reason, detail: message }) })).toMatchObject({ outcome: 'refused', reason });
  });
});
describe('direct pr-land canonical gate seam', () => {
  it.each(['canonical-audit-missing', 'canonical-audit-weakened'])('emits %s at exit 3 with the same message', reason => {
    const refuse = vi.fn();
    admitCanonicalAudit({ repo: '/repo', ref: 'lane/audit', sha }, { check: () => ({ ok: false, reason, message }), refuse });
    expect(refuse).toHaveBeenCalledWith({ repo: '/repo', merged: false, reason, detail: message }, 3);
  });
  it('green evidence does not emit a refusal', () => {
    const refuse = vi.fn();
    expect(admitCanonicalAudit({ sha }, { check: () => ({ ok: true }), refuse }).ok).toBe(true);
    expect(refuse).not.toHaveBeenCalled();
  });
  it('the direct CLI gates before its dry-run return and before publishing', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pr-land.mjs'), 'utf8');
    const gate = source.indexOf('  admitCanonicalAudit({ repo: REPO');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(source.indexOf('  if (DRY_RUN) {', gate));
    expect(gate).toBeLessThan(source.indexOf('  // 2. Publish', gate));
  });
});
