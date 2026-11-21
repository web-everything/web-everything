import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Execute the actual CLI/checkpoint in a child. Loader substitutes only external gate/forge ports;
// Git effects are recorded instead of executed. No real Git, forge, card filing or operator state.
function run({ check = true, fail = false, override = '', count = 15, exempt = false,
  body = 'Description', earlyPr = false, labelOnGreen = false, headEvidence = 'matching',
  sha = 'a'.repeat(40), remoteTip = '', remoteError = false, ancestor = true, refusePush = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-land-preflight-'));
  const trace = join(dir, 'effects.jsonl');
  const root = resolve('scripts');
  const hook = join(dir, 'pre-push');
  writeFileSync(hook, '#!/bin/sh\necho "fixture pre-push refuses" >&2\nexit 1\n');
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
        viewPr: (pr, fields) => {
          if (fields === 'headRefOid' && ${JSON.stringify(headEvidence)} === 'unreadable') throw new Error('head unreadable');
          return { labels: [], comments: [], body: 'Description', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
            headRefOid: ${JSON.stringify(headEvidence === 'missing' ? null : headEvidence === 'different' ? 'b'.repeat(40) : sha)} };
        },
        requiredChecks: () => [{ name: 'test', bucket: 'pass' }],
        ensureLabel: () => {}, addLabel: (pr, label) => effect(['add-label', label]), removeLabel: () => {} });`,
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
    const execFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args) => {
      effect([cmd, args]);
      if (cmd === 'node') return ''; // locus linter is read-only and independently tested
      if (cmd !== 'git') throw new Error('unexpected external effect: ' + cmd);
      if (args[0] === 'rev-parse') return args.includes('--absolute-git-dir') ? ${JSON.stringify(dir)} : ${JSON.stringify(sha)};
      if (args[0] === 'log') return 'fix: admission';
      if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git';
      if (args[0] === 'diff') return args.includes('--name-status') ? 'M\\tblocks/example.ts' : ${JSON.stringify(exempt ? 'scripts/conveyor/worker.mjs' : 'blocks/example.ts')};
      if (args[0] === 'ls-remote') {
        if (${remoteError}) throw new Error('ls-remote unavailable');
        return ${JSON.stringify(remoteTip)};
      }
      if (args[0] === 'merge-base') {
        if (${JSON.stringify(ancestor)} !== true) throw Object.assign(new Error('not a proven ancestor'), { status: ${ancestor === 'unreadable' ? 128 : 1} });
        return '';
      }
      if (args[0] === 'push') return ${refusePush} ? execFileSync('sh', [${JSON.stringify(hook)}], { encoding: 'utf8' }) : '';
      if (args[0] === 'show') throw new Error('no ready config');
      return '';
    }; syncBuiltinESMExports(); register(${JSON.stringify(pathToFileURL(loader).href)});`);
  try {
    const child = spawnSync(process.execPath, ['--import', preload, join(root, 'pr-land.mjs'), `--repo=${dir}`,
      '--ref=lane/preflight', '--title=fix: admission', `--body=${body}`, labelOnGreen ? '--label-on-green' : '--no-wait', '--json',
      ...(check ? ['--check'] : []), ...(override === 'forceOpen' ? ['--force-open', '--reason=operator'] : [])],
    { cwd: dir, env: { ...process.env, TMPDIR: dir, WE_POLICY_CASCADE_LOG: '0' },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (!child.stdout.trim()) throw new Error(`CLI ${child.status}: ${child.stderr}`);
    return { status: child.status, stderr: child.stderr, result: JSON.parse(child.stdout.trim().split('\n').at(-1)),
      effects: readFileSync(trace, 'utf8').trim().split('\n').map(s => JSON.parse(s)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('pr-land pre-push checkpoint', () => {
  it.each(['different', 'missing', 'unreadable'])('green checks with %s PR head evidence refuse before ready-to-merge is ever applied', headEvidence => {
    const { status, result, effects } = run({ check: false, count: 0, labelOnGreen: true, headEvidence });
    expect(status).toBe(3);
    expect(result.reason).toBe('pr-head-mismatch');
    expect(effects.filter(([cmd, label]) => cmd === 'add-label' && label === 'ready-to-merge')).toEqual([]);
  });

  it('green checks with matching PR head evidence reach the ready-to-merge write', () => {
    const { status, result, effects } = run({ check: false, count: 0, labelOnGreen: true });
    expect(status).toBe(0);
    expect(result.reason).toBe('labelled-on-green');
    expect(effects.filter(([cmd, label]) => cmd === 'add-label' && label === 'ready-to-merge')).toHaveLength(1);
  });

  it.each([false, true])('refuses an empty create body when the early PR exists=%s and no PR exists at create', earlyPr => {
    const { status, result, effects } = run({ check: false, count: 0, body: '', earlyPr });
    expect(status).toBe(3);
    expect(result.reason).toBe('empty-body');
    expect(effects.filter(([cmd]) => cmd === 'pr-lookup')).toHaveLength(earlyPr ? 2 : 1);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });
  it.each([true, false])('reports verify and soak blockers together with hints, check=%s', check => {
    const { status, result, effects } = run({ check, fail: true });
    expect(status).toBe(3);
    expect(result.blockers.map(b => b.reason)).toEqual(check
      ? ['verify-red', 'soak-declaration', 'pr-limit'] : ['verify-red', 'soak-declaration']);
    expect(result.detail).toContain('run verify-lane'); expect(result.detail).toContain('module + .soak.test.mjs');
    expect(effects.some(([cmd, args]) => cmd === 'create' || cmd === 'size-admission' || args?.[0] === 'push')).toBe(false);
  });
  it('check reports capacity as a blocker hint without push, create or card filing', () => {
    const { status, result, effects } = run();
    expect(status).toBe(3); expect(result.reason).toBe('pr-limit');
    expect(result.blockers).toMatchObject([{ gate: 'pr-limit', reason: 'pr-limit' }]);
    expect(result.detail).toContain('pr-limit: at 15/15, a real open would be refused');
    expect(effects.some(([cmd, args]) => cmd === 'create' || cmd === 'size-admission' || args?.[0] === 'push')).toBe(false);
  });
  it('check succeeds below capacity without a pr-limit blocker or info line', () => {
    const { status, result, effects } = run({ count: 0 });
    expect(status).toBe(0); expect(result.reason).toBe('check-ok');
    expect(result.detail).not.toContain('pr-limit');
    expect(result.info).toEqual([]);
    expect(effects.some(([cmd, args]) => cmd === 'create' || cmd === 'size-admission' || args?.[0] === 'push')).toBe(false);
  });
  it('over-limit create refuses with the original detail and leaves the ref pushed', () => {
    const { status, result, effects } = run({ check: false });
    expect(status).toBe(3); expect(result.reason).toBe('pr-limit');
    expect(result.detail).toContain('(ref lane/preflight left pushed on origin — re-run pr-land once the count drops, or use one of the overrides named above)');
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toBe(true);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });
  it.each(['forceOpen', 'branchAllowed', 'globalOff', 'exempt'])('%s bypasses capacity admission', override => {
    const { effects } = run({ check: false, override, exempt: override === 'exempt' });
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    const { status, result } = run({ override, exempt: override === 'exempt' });
    expect(status).toBe(0); expect(result.reason).toBe('check-ok');
    expect(result.detail).not.toContain('pr-limit');
  });
});

describe('pr-land lane publish remote-tip check', () => {
  const sha = 'a'.repeat(40);
  const different = 'a'.repeat(39) + 'b';
  const tip = value => `${value}\trefs/heads/lane/preflight`;
  const publish = options => run({ check: false, count: 0, ...options });
  const pushes = effects => effects.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push');

  it('origin equals HEAD: skips push even with a refusing hook and reaches PR creation', () => {
    const { effects, stderr } = publish({ remoteTip: tip(sha), refusePush: true });
    expect(pushes(effects)).toEqual([]);
    expect(effects).toContainEqual(['git', ['ls-remote', 'origin', 'refs/heads/lane/preflight']]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(stderr).toContain(`push skipped: origin already at ${sha}`);
  });

  it('origin behind: attempts the exact non-force push and preserves pre-push refusal', () => {
    const { status, result, effects, stderr } = publish({ remoteTip: tip(different), refusePush: true });
    expect(effects).toContainEqual(['git', ['merge-base', '--is-ancestor', different, sha]]);
    expect(pushes(effects)).toEqual([['git', ['push', 'origin', `${sha}:refs/heads/lane/preflight`]]]);
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(stderr).toContain('fixture pre-push refuses');
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });

  it('origin missing: attempts push and reaches PR creation', () => {
    const { effects } = publish({ remoteTip: '' });
    expect(pushes(effects)).toHaveLength(1);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
  });

  it.each(['ahead', 'diverged', 'ancestry unreadable'])('origin %s: refuses before push or PR creation', state => {
    const { status, result, effects } = publish({ remoteTip: tip(different), ancestor: state === 'ancestry unreadable' ? 'unreadable' : false });
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(pushes(effects)).toEqual([]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });

  it.each([
    ['failed read', '', true],
    ['garbage', 'unreadable', false],
    ['short SHA', tip(sha.slice(0, 8)), false],
    ['wrong ref', `${sha}\trefs/heads/lane/other`, false],
    ['ambiguous output', `${tip(sha)}\n${tip(different)}`, false],
  ])('ls-remote %s: falls through to guarded push', (_name, remoteTip, remoteError) => {
    const { status, result, effects, stderr } = publish({ remoteTip, remoteError, refusePush: true });
    expect(pushes(effects)).toHaveLength(1);
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(stderr).not.toContain('push skipped');
  });

  it('invalid refSha cannot authorize a skip even when the remote output matches', () => {
    const { effects, stderr } = publish({ sha: 'a'.repeat(8), remoteTip: tip('a'.repeat(8)), refusePush: true });
    expect(pushes(effects)).toHaveLength(1);
    expect(stderr).not.toContain('push skipped');
  });
});
