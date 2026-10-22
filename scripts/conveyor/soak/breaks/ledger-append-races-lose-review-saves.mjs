/**
 * Live 2026-10-21: concurrent review writers exhausted five slow worktree-push
 * attempts; referral holds / rulings were never saved (#5502 #5530 #5773 #5742
 * #5768). Replay with real local git, six processes, two boards and a slow
 * receive hook. Production imports follow sourceRoot, including on the RED tree.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const REPO = CONSTELLATION_REPOS.we.slug;
const PRS = [11, 12, 13, 14, 15, 16];

// The worker's process group contains every node/git/hook descendant, so even a
// hung synchronous production call is bounded and reaped before scratch cleanup.
function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

function appender(script, board, pr) {
  let signalReady;
  const ready = new Promise(resolveReady => { signalReady = resolveReady; });
  const child = spawn(process.execPath, [script, board, String(pr)], {
    cwd: board, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 55_000, killSignal: 'SIGKILL',
  });
  let out = '', err = '';
  child.stdout.on('data', data => { out = (out + data).slice(-65_536); });
  child.stderr.on('data', data => { err = (err + data).slice(-65_536); });
  child.on('message', message => { if (message === 'ready') signalReady(true); });
  child.on('error', error => { err += error.message; signalReady(false); });
  const done = new Promise(resolveDone => child.on('close', (code, signal) => {
    signalReady(false);
    resolveDone({ pr, code, signal, out, err });
  }));
  return { ready, done, start: () => { if (child.connected) child.send('append'); } };
}

// Exported solely for the isolated worker below: no production module is loaded
// in the caller's environment, which may point at a real ~/.claude or git config.
export async function replay(sourceRoot) {
  const violations = [];
  const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
  const { withBareOrigin, git, writeLocalIdentity } = await load('scripts/operations/__tests__/helpers/real-repo.mjs');
  const { ledgerGitPath, LEDGER_TRANSPORT_BRANCH } = await load('scripts/lib/verdict-ledger-io.mjs');
  await withBareOrigin(async ctx => {
    const path = ledgerGitPath(REPO);
    ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { [path]: '' });
    writeFileSync(join(ctx.origin, 'hooks/pre-receive'), '#!/bin/sh\nsleep 1.5\n', { mode: 0o755 });
    const second = join(ctx.tmp, 'board-b');
    git(['clone', '--quiet', ctx.origin, second], { cwd: ctx.tmp });
    writeLocalIdentity(second);
    const script = join(ctx.tmp, 'append-one.mjs');
    writeFileSync(script, `
      const load = path => import(new URL(path, ${JSON.stringify(pathToFileURL(`${sourceRoot}/`).href)}));
      const { appendLedgerRows } = await load('scripts/lib/verdict-ledger-io.mjs');
      const { buildVerdictRecord } = await load('scripts/lib/verdict-ledger.mjs');
      const [board, pr] = process.argv.slice(2);
      const rec = buildVerdictRecord({ repo: ${JSON.stringify(REPO)}, pr: Number(pr), verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
      const start = new Promise(resolve => process.once('message', resolve));
      process.send('ready');
      await start;
      process.disconnect();
      try {
        const result = appendLedgerRows({ board, repo: ${JSON.stringify(REPO)}, records: [rec], log: () => {} });
        process.stdout.write(JSON.stringify({ result }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.name, attempts: error.attempts, message: error.message }));
        process.exitCode = 1;
      }
    `);
    const children = PRS.map((pr, i) => appender(script, i % 2 ? second : ctx.clone, pr));
    await Promise.all(children.map(child => child.ready));
    children.forEach(child => child.start());
    const results = await Promise.all(children.map(child => child.done));
    for (const result of results) {
      let response;
      try { response = JSON.parse(result.out); } catch { /* report the exit/output below */ }
      if (response?.error === 'LedgerAppendExhaustedError') {
        violations.push(`pr ${result.pr}: not recorded (LedgerAppendExhaustedError after ${response.attempts} attempts)`);
      } else if (result.code !== 0 || response?.error || response?.result?.status !== 'appended') {
        violations.push(`pr ${result.pr}: child failed (${response?.error ?? result.signal ?? result.code}): ${response?.message ?? result.err ?? result.out}`);
      }
    }
    // Queued success is durable, but the backstop must also be able to land it.
    // Never import the new module on the pre-fix tree: absence is not our RED proof.
    if (scenario.fixPresent(sourceRoot)) {
      const { listOutboxEntries, flushLedgerOutbox } = await load('scripts/lib/verdict-ledger-outbox.mjs');
      const dir = process.env.WE_VERDICT_LEDGER_OUTBOX_DIR;
      if (listOutboxEntries(dir).length) {
        const flush = flushLedgerOutbox({ board: ctx.clone, dir, budgetMs: 20_000, log: () => {} });
        if (!flush.ok) violations.push(`backstop failed: ${flush.error}`);
      }
    }
    const rows = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, path).split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const pr of PRS) {
      const count = rows.filter(row => row.pr === pr).length;
      if (count === 0) violations.push(`pr ${pr}: row missing from origin`);
      if (count > 1) violations.push(`pr ${pr}: row present ${count} times on origin`);
    }
  });
  return { violations };
}

const scenario = {
  id: 'ledger-append-races-lose-review-saves',
  title: 'concurrent slow ledger appends save every review exactly once',
  card: 'live 2026-10-21: #5502 #5530 #5773 #5742 #5768; ledger outbox 1/6..6/6',
  fixedBy: {
    sha: '62a3d7b73', where: 'lane/ledger-outbox-main',
    paths: ['scripts/lib/verdict-ledger-io.mjs', 'scripts/lib/verdict-ledger-outbox.mjs', 'scripts/lib/verdict-ledger-plumbing.mjs'],
  },
  fixPresent(root) {
    try {
      return /import\s*\{[^}]*\bappendViaOutbox\b[^}]*\}\s*from\s*['"]\.\/verdict-ledger-outbox\.mjs['"]/.test(
        readFileSync(join(root, 'scripts/lib/verdict-ledger-io.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'we-ledger-race-soak-')));
    const home = join(scratch, 'home');
    mkdirSync(home);
    const env = {
      PATH: process.env.PATH, HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
      WE_VERDICT_LEDGER_OUTBOX: 'true', WE_VERDICT_LEDGER_FLUSH_BUDGET_MS: '20000',
      WE_VERDICT_LEDGER_OUTBOX_DIR: join(scratch, 'outbox'),
    };
    let child, timer;
    try {
      const script = `const { replay } = await import(${JSON.stringify(import.meta.url)});
        console.log(JSON.stringify(await replay(${JSON.stringify(resolve(sourceRoot))})));`;
      child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '', timedOut = false;
      child.stdout.on('data', data => { out = (out + data).slice(-65_536); });
      child.stderr.on('data', data => { err = (err + data).slice(-65_536); });
      timer = setTimeout(() => { timedOut = true; killGroup(child); }, 105_000);
      const { code, signal } = await new Promise((done, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => done({ code, signal }));
      });
      if (timedOut) return { violations: ['scenario exceeded 105000ms'] };
      if (code !== 0) return { violations: [`scenario worker failed (${signal ?? code}): ${err}`] };
      const report = JSON.parse(out);
      log?.(`six writers, two boards, 1500ms receive hook: ${JSON.stringify(report)}`);
      return { violations: report.violations };
    } catch (error) {
      return { violations: [`scenario failed: ${error.stack ?? error}`] };
    } finally {
      clearTimeout(timer);
      if (child) killGroup(child);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  judge: r => r.violations,
};

export default scenario;
