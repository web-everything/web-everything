/** R1062a: the disabled live Gemini seat must not starve bounded Carbon shadows. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/review-seat-runner.mjs';
const ENV = ['WE_REVIEW_SEAT_CAP_AGY_GEMINI', 'WE_REVIEW_SEAT_CAP_CARBON_SHADOW', 'WE_REVIEW_SHADOW_AGY_PROMOTED'];
const CARBON = 'gemini-4-carbon-high';

export async function replay(sourceRoot = ROOT) {
  const { runSeatWithProvider } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
  const { reserveShadowSession } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-shadow-budget.mjs')).href);
  const saved = ENV.map(key => [key, process.env[key]]);
  const dir = mkdtempSync(join(tmpdir(), 'soak-carbon-shadow-'));
  const violations = [];
  let clock = Date.parse('2026-11-20T18:00:00Z');
  const claude = { summary: 'Claude remains authoritative', findings: [] };
  const agy = { summary: 'shadow disagrees', findings: [{ file: 'fixture.mjs', line: 1, summary: 'shadow only', disposition: 'blocker' }] };
  try {
    process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '0';
    process.env.WE_REVIEW_SEAT_CAP_CARBON_SHADOW = '5';
    process.env.WE_REVIEW_SHADOW_AGY_PROMOTED = 'true';
    const run = async (name, directive = {}, store = name) => {
      const rows = [], caps = [], calls = [];
      const out = await runSeatWithProvider({ mandate: 'fixture review', input: 'fixture diff', lens: 'correctness', runId: name,
        seatProvider: { mode: 'shadow', model: CARBON, seat: 'correctness', repo: 'fixture/repo', pr: 7,
          head: 'a'.repeat(40), ...directive } }, {
        cwd: dir, now: () => clock, log() {},
        claudeJudge: async () => ({ value: claude, telemetry: { sessionId: 'claude-session' } }),
        unwrap: result => result, wrap: (value, telemetry) => ({ value, telemetry }),
        agyJuror: async args => { calls.push(args.model); return { status: 'ok', sessionId: 'agy-session', value: agy }; },
        appendRow: row => { rows.push(row); return true; },
        reserveSession: args => { caps.push(args.dailyCap); return reserveShadowSession({ ...args, path: join(dir, store) }); },
      });
      if ((directive.mode ?? 'shadow') === 'shadow'
        && (out.value.summary !== claude.summary || out.value.findings.length !== 0 || out.telemetry.sessionId !== 'claude-session')) {
        violations.push(`${name}: shadow replaced the Claude answer`);
      }
      return { rows, caps, calls, out };
    };
    const expectRun = (name, result, status, cap) => {
      if (result.rows.length !== 1 || result.rows[0].status !== status
        || result.calls.length !== (status === 'ok' ? 1 : 0)
        || JSON.stringify(result.caps) !== JSON.stringify(cap === undefined ? [] : [cap])) {
        violations.push(`${name}: expected ${status} with reservation ${cap ?? 'none'}, got ${JSON.stringify({ rows: result.rows.map(r => r.status), calls: result.calls, caps: result.caps })}`);
      }
    };
    // Each call creates a fresh runner invocation; only the on-disk daily budget survives.
    expectRun('first seat', await run('first', { dailyCap: 2 }, 'shared'), 'ok', 2);
    expectRun('second seat', await run('second', { dailyCap: 2 }, 'shared'), 'ok', 2);
    expectRun('exhausted budget', await run('third', { dailyCap: 2 }, 'shared'), 'skipped', 2);
    clock += 24 * 3600_000;
    expectRun('next day', await run('next-day', { dailyCap: 2 }, 'shared'), 'ok', 2);
    expectRun('zero daily cap', await run('zero', { dailyCap: 0 }), 'skipped', 0);
    expectRun('other Gemini shadow', await run('non-carbon', { model: 'gemini-3-pro', dailyCap: 2 }), 'skipped');
    const live = await run('live', { mode: 'agy', onEscape: 'skip' });
    if (live.calls.length || live.caps.length || live.out.value.seatProvider.status !== 'skipped'
      || !live.out.value.seatProvider.reasons.includes('agy-gemini seat cap 0')) violations.push('live Carbon seat escaped the live cap');
    process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '20';
    const openLive = await run('live-control', { mode: 'agy', onEscape: 'skip' });
    if (openLive.calls.length !== 1 || openLive.out.value.seatProvider.provider !== 'agy') violations.push('live control did not run with an open live cap');
    process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '0';
    process.env.WE_REVIEW_SEAT_CAP_CARBON_SHADOW = '0';
    expectRun('disabled Carbon', await run('disabled', { dailyCap: 2 }), 'skipped');
    process.env.WE_REVIEW_SEAT_CAP_CARBON_SHADOW = '5';
    for (const [i, dailyCap] of [undefined, null, -1, 'invalid', 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
      expectRun(`fallback ${i}`, await run(`fallback-${i}`, { dailyCap }), 'ok', 100);
    }
    // Exercise the fallback against a full real store, not just an injected refusal.
    const fullPath = join(dir, 'full');
    for (let i = 0; i < 100; i++) {
      if (!reserveShadowSession({ dailyCap: 100, now: clock, path: fullPath }).allowed) violations.push('could not seed fallback budget');
    }
    expectRun('absent cap exhausted', await run('absent-full', {}, 'full'), 'skipped', 100);
    expectRun('invalid cap exhausted', await run('invalid-full', { dailyCap: 'invalid' }, 'full'), 'skipped', 100);
    return { violations };
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'carbon-shadow-live-seat-cap',
  title: 'Carbon shadows run under a disabled live Gemini cap while retaining their own persisted daily bound',
  card: 'R1062a / PR #7255',
  fixedBy: { sha: 'working-tree', where: SOURCE, paths: [SOURCE] },
  fixPresent(root) {
    // Independent behavioral presence check: do not infer the fix from source markers or the replay verdict.
    const code = `
      process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '0';
      process.env.WE_REVIEW_SEAT_CAP_CARBON_SHADOW = '1';
      const { runSeatWithProvider } = await import(${JSON.stringify(pathToFileURL(join(root, SOURCE)).href)});
      let calls = 0, cap;
      const out = await runSeatWithProvider({ seatProvider: { mode: 'shadow', model: 'gemini-4-carbon-high' } }, {
        claudeJudge: async () => ({ value: { findings: [] }, telemetry: { sessionId: 'claude' } }),
        unwrap: x => x, wrap: value => value, cwd: null, log() {}, appendRow: () => true,
        reserveSession: args => { cap = args.dailyCap; return { allowed: true }; },
        agyJuror: async () => { calls++; return { status: 'ok', sessionId: 'agy', value: { findings: [] } }; },
      });
      process.stdout.write(calls === 1 && cap === 100 && out.shadow.status === 'ok' ? 'exempt' : 'blocked');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !result.error && result.status === 0 && result.stdout === 'exempt';
  },
  run: ({ sourceRoot = ROOT } = {}) => replay(sourceRoot),
  judge: report => report.violations,
};
