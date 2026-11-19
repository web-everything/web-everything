import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Execute the actual CLI/checkpoint in a child. Loader substitutes only external gate/forge ports;
// Git effects are recorded instead of executed. No real Git, forge, card filing or operator state.
function run({ check = true, fail = false, override = '', count = 15, exempt = false,
  body = 'Description', earlyPr = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-land-preflight-'));
  const trace = join(dir, 'effects.jsonl');
  const queue = join(dir, 'queue.json');
  const root = resolve('scripts');
  const sha = 'a'.repeat(40);
  const record = `import { appendFileSync } from 'node:fs'; const effect = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');`;
  const stubs = {
    './operations/canonical-audit-gate.mjs': 'export const checkCanonicalAuditForOpen = () => ({ ok: true });',
    './lib/lane-verify.mjs': `export const readVerifyMarker = () => null;
      export const verifyGateDecision = () => (${JSON.stringify(fail ? { ok: false, reason: 'verify-red', detail: 'verification red' } : { ok: true })});`,
    './lib/soak-precheck-at-open.mjs': `export const soakPrecheckEnabled = () => true;
      export const soakPrecheckAtOpen = () => (${JSON.stringify(fail ? { ok: false, message: 'missing soak break' } : { ok: true, skipped: 'fixture' })});`,
    './lib/pr-limit.mjs': `export const countOpenPrsForRepo = () => ({ count: ${count}, limit: 15 });
      export const isBranchAllowedLive = () => ${override === 'branchAllowed'};
      export const isGlobalOffLive = () => ${override === 'globalOff'};`,
    './lib/forge-land-provider.mjs': `${record}
      let lookups = 0;
      export const createGhLandProvider = () => ({ listOpenByHead: () => {
        effect(['pr-lookup']); return ++lookups === 1 && ${earlyPr} ? [{ number: 7 }] : []; },
        create: p => { effect(['create', p]); return 'https://example.test/pull/7'; },
        viewPr: () => ({ labels: [], comments: [], body: 'Description' }),
        ensureLabel: () => {}, addLabel: () => {}, removeLabel: () => {} });`,
    './lib/pr-size-admission.mjs': `${record} export const createSizeAdmissionRunner = () => async request => {
      effect(['size-admission']); return { body: request.body, status: 'small' }; };`,
    './conveyor/fix-procedure.mjs': 'export const pushRefusal = () => null; export const repoKeyForCheckout = () => "we";',
    './conveyor/infra-blocked.mjs': 'export const originSlugOf = () => "web-everything/web-everything";',
  };
  const loader = join(dir, 'loader.mjs');
  writeFileSync(loader, `const stubs = ${JSON.stringify(stubs)}; const root = ${JSON.stringify(pathToFileURL(root + '/').href)};
    export async function resolve(specifier, context, next) {
      if (context.parentURL === root + 'pr-land.mjs' && stubs[specifier]) {
        const original = new URL(specifier, context.parentURL).href;
        return { url: 'data:text/javascript,' + encodeURIComponent('export * from ' + JSON.stringify(original) + ';' + stubs[specifier]), shortCircuit: true };
      }
      return next(specifier, context);
    }`);
  const preload = join(dir, 'preload.mjs');
  writeFileSync(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports, register } from 'node:module';
    ${record}
    cp.execFileSync = (cmd, args) => {
      effect([cmd, args]);
      if (cmd === 'node') return ''; // locus linter is read-only and independently tested
      if (cmd !== 'git') throw new Error('unexpected external effect: ' + cmd);
      if (args[0] === 'rev-parse') return args.includes('--absolute-git-dir') ? ${JSON.stringify(dir)} : ${JSON.stringify(sha)};
      if (args[0] === 'log') return 'fix: admission';
      if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git';
      if (args[0] === 'diff') return args.includes('--name-status') ? 'M\\tblocks/example.ts' : ${JSON.stringify(exempt ? 'scripts/conveyor/worker.mjs' : 'blocks/example.ts')};
      if (args[0] === 'push') return '';
      if (args[0] === 'show') throw new Error('no ready config');
      return '';
    }; syncBuiltinESMExports(); register(${JSON.stringify(pathToFileURL(loader).href)});`);
  try {
    const child = spawnSync(process.execPath, ['--import', preload, join(root, 'pr-land.mjs'), `--repo=${dir}`,
      '--ref=lane/preflight', '--title=fix: admission', `--body=${body}`, '--no-wait', '--json',
      ...(check ? ['--check'] : []), ...(override === 'forceOpen' ? ['--force-open', '--reason=operator'] : [])],
    { cwd: dir, env: { ...process.env, WE_PR_LIMIT_QUEUE_FILE: queue, TMPDIR: dir, WE_POLICY_CASCADE_LOG: '0' },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (!child.stdout.trim()) throw new Error(`CLI ${child.status}: ${child.stderr}`);
    return { status: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)),
      effects: readFileSync(trace, 'utf8').trim().split('\n').map(s => JSON.parse(s)),
      queue: existsSync(queue) ? JSON.parse(readFileSync(queue, 'utf8')) : [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('pr-land pre-push checkpoint', () => {
  it.each([false, true])('refuses an empty create body when the early PR exists=%s and no PR exists at create', earlyPr => {
    const { status, result, effects, queue } = run({ check: false, count: 0, body: '', earlyPr });
    expect(status).toBe(3);
    expect(result.reason).toBe('empty-body');
    expect(effects.filter(([cmd]) => cmd === 'pr-lookup')).toHaveLength(earlyPr ? 2 : 1);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
    expect(queue).toEqual([]);
  });
  it.each([true, false])('reports verify and soak blockers together with hints, check=%s', check => {
    const { status, result, effects, queue } = run({ check, fail: true });
    expect(status).toBe(3);
    expect(result.blockers.map(b => b.reason)).toEqual(['verify-red', 'soak-declaration']);
    expect(result.detail).toContain('run verify-lane'); expect(result.detail).toContain('module + .soak.test.mjs');
    expect(effects.some(([cmd, args]) => cmd === 'create' || cmd === 'size-admission' || args?.[0] === 'push')).toBe(false);
    expect(queue).toEqual([]);
  });
  it('check-ok reports would queue without push, create, card filing or queue write', () => {
    const { status, result, effects, queue } = run();
    expect(status).toBe(0); expect(result.reason).toBe('check-ok');
    expect(result.detail).toContain('pr-limit: would queue (15/15)');
    expect(effects.some(([cmd, args]) => cmd === 'create' || cmd === 'size-admission' || args?.[0] === 'push')).toBe(false);
    expect(queue).toEqual([]);
  });
  it('over-limit create leaves the ref pushed and persists a ready PR, never a refusal', () => {
    const { status, result, effects, queue } = run({ check: false });
    expect(status).toBe(0); expect(result.reason).toBe('pr-limit-queued');
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toBe(true);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
    expect(queue).toMatchObject([{ ref: 'lane/preflight', draft: false, body: expect.stringContaining('Description') }]);
  });
  it.each(['forceOpen', 'branchAllowed', 'globalOff', 'exempt'])('%s bypasses queue admission', override => {
    const { effects, queue } = run({ check: false, override, exempt: override === 'exempt' });
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(queue).toEqual([]);
  });
});
