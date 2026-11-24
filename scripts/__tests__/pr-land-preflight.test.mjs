import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childFailureNote } from '../pr-land.mjs';

// Execute the actual CLI/checkpoint in a child. Loader substitutes only external gate/forge ports;
// Git effects are recorded instead of executed. No real Git, forge, card filing or operator state.
function run({ check = true, fail = false, override = '', count = 15, exempt = false,
  body = 'Description', earlyPr = false, labelOnGreen = false, headEvidence = 'matching',
  realSoak = false, diffFailure = false, rawDiff, title = 'fix: admission',
  sha = 'a'.repeat(40), remoteTip = '', forkTip = '', remoteError = false, ancestor = true, refusePush = false,
  shallow = 'false', fetchUrls = null, pushUrls = null, dryRun = false, createFails = false, fallbackGit = false,
  getUrl = null, realGit = null, lease = null, ref = 'lane/preflight', trackerText = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-land-preflight-'));
  const trace = join(dir, 'effects.jsonl');
  const root = resolve('scripts');
  const hook = join(dir, 'pre-push');
  writeFileSync(hook, '#!/bin/sh\necho "fixture pre-push refuses" >&2\nexit 1\n');
  if (lease !== null) writeFileSync(join(dir, '.lane-lease'), lease);
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
        create: p => { effect(['create', p]);
          if (${createFails}) throw new Error('validation failed: fixture create refused');
          return 'https://example.test/pull/7'; },
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
  const soakTest = 'scripts/conveyor/soak/breaks/preflight.soak.test.mjs';
  if (realSoak) {
    // Exercise the real precheck without creating any timing metadata.
    delete stubs['./lib/soak-precheck-at-open.mjs'];
  }
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
    cp.execFileSync = (cmd, args, opts) => {
      effect([cmd, args]);
      if (cmd === process.execPath && /guard-(?:git-push|prototype-tracker)\\.mjs$/.test(args[0])) {
        // Run the actual hook guards in fresh processes, with only Git/forge ports stubbed.
        effect(['guard-input', args[0], opts.input]);
        if (${refusePush}) return execFileSync('sh', [${JSON.stringify(hook)}], { encoding: 'utf8' });
        return execFileSync(cmd, ['--import', ${JSON.stringify(preload)}, ...args], opts);
      }
      if (cmd === 'node') return ''; // locus linter is read-only and independently tested
      if (cmd !== 'git') throw new Error('unexpected external effect: ' + cmd);
      // realGit: the publish step's remote reads, ancestry/shallow checks and the push run against real local
      // bare repositories; every other git call stays stubbed.
      if (${!!realGit} && (['ls-remote', 'push', 'fetch', 'cat-file'].includes(args[0]) || args.includes('merge-base') || (args[0] === 'remote' && args.includes('--all'))
        || args.includes('--is-shallow-repository') || (args[0] === 'config' && args.includes('core.sshCommand')))) return execFileSync(cmd, args, opts);
      if (args.includes('--is-shallow-repository')) { if (${JSON.stringify(shallow)} === null) throw new Error('shallow unreadable'); return ${JSON.stringify(shallow)}; }
      if (args[0] === 'rev-parse') return args.includes('--git-path') ? ${JSON.stringify(join(dir, '.lane-lease'))} : args.includes('--absolute-git-dir') ? ${JSON.stringify(dir)} : ${JSON.stringify(sha)};
      if (args[0] === 'log') return 'fix: admission';
      if (args[0] === 'remote' && args.includes('--all')) {
        // get-url --all: a string is the URL list git prints; a number is a failed read with that exit status.
        const urls = args.includes('--push') ? ${JSON.stringify(pushUrls)} : ${JSON.stringify(fetchUrls)};
        if (typeof urls === 'number') throw Object.assign(new Error('get-url failed'), { status: urls });
        return urls ?? 'https://github.com/web-everything/web-everything.git';
      }
      if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git';
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === args[3]) return '';
      if (args[0] === 'diff') {
        if (args.includes('--name-status') && ${diffFailure}) throw new Error('diff failed');
        return args.includes('--name-status') ? ${JSON.stringify(rawDiff ?? (realSoak ? `A\0${soakTest}\0` : 'M\0blocks/example.ts\0'))} : ${JSON.stringify(exempt ? 'scripts/conveyor/worker.mjs' : 'blocks/example.ts')};
      }
      // ls-remote --get-url: the URL ls-remote would contact after its own insteadOf pass (default: unchanged).
      if (args[0] === 'ls-remote' && args[1] === '--get-url') return ${JSON.stringify(getUrl)} ?? args[3];
      if (args[0] === 'ls-remote') {
        if (${remoteError}) throw new Error('ls-remote unavailable');
        // remoteTip answers for the default (upstream) URL; forkTip for any other push URL that is read.
        return args.includes('https://github.com/web-everything/web-everything.git') || args.includes('origin')
          ? ${JSON.stringify(remoteTip)} : ${JSON.stringify(forkTip)};
      }
      if (args.includes('merge-base')) {
        if (${JSON.stringify(ancestor)} !== true) throw Object.assign(new Error('not a proven ancestor'), { status: ${ancestor === 'unreadable' ? 128 : 1} });
        return '';
      }
      // The fallback merge is recorded, then refused, so the run stops before any lock, push or heal effect.
      if (args[0] === 'merge') throw new Error('fixture refuses the fallback merge');
      if (args[0] === 'push') return ${refusePush} ? execFileSync('sh', [${JSON.stringify(hook)}], { encoding: 'utf8' }) : '';
      if (args[0] === 'show' && args[1]?.includes(':backlog/3383-') && ${JSON.stringify(trackerText)} !== null) return ${JSON.stringify(trackerText)};
      if (args[0] === 'show') throw new Error('no ready config');
      return '';
    }; syncBuiltinESMExports(); register(${JSON.stringify(pathToFileURL(loader).href)});`);
  try {
    const child = spawnSync(process.execPath, ['--import', preload, join(root, 'pr-land.mjs'), `--repo=${realGit?.repo ?? dir}`,
      `--ref=${ref}`, `--title=${title}`, `--body=${body}`, labelOnGreen ? '--label-on-green' : '--no-wait', '--json',
      ...(check ? ['--check'] : []), ...(dryRun ? ['--dry-run'] : []), ...(fallbackGit ? ['--fallback-git'] : []),
      ...(override === 'forceOpen' ? ['--force-open', '--reason=operator'] : [])],
    { cwd: realSoak ? root : dir, env: { ...(realGit ? realGit.env : process.env), TMPDIR: dir, WE_POLICY_CASCADE_LOG: '0', WE_PR_OPEN_SOAK_PRECHECK: '1', PROTOTYPE_TRACKER_PUSH_OK: '0',...(fallbackGit ? { WE_MERGE_BREAK_GLASS: '1' } : {}) },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (!child.stdout.trim()) throw new Error(`CLI ${child.status}: ${child.stderr}`);
    return { status: child.status, stderr: child.stderr, result: JSON.parse(child.stdout.trim().split('\n').at(-1)),
      effects: readFileSync(trace, 'utf8').trim().split('\n').map(s => JSON.parse(s)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('pr-land pre-push checkpoint', () => {
  it.each([true, false])('refuses a failed diff before push/create, check=%s', check => {
    const { status, result, effects } = run({ count: 0, check, diffFailure: true });
    expect(status).toBe(3);
    expect(result.blockers).toMatchObject([{ reason: 'soak-declaration' }]);
    expect(result.detail).toContain('diff unavailable');
    expect(effects.some(([cmd, args]) => cmd === 'create' || args?.[0] === 'push')).toBe(false);
  });
  it.each(['X', 'U', 'Q'])('refuses unsupported daemon diff status %s before push/create', code => {
    const { status, result, effects } = run({ count: 0, check: false, realSoak: true,
      rawDiff: `${code}\0scripts/conveyor/soak/breaks/preflight.soak.test.mjs\0` });
    expect(status).toBe(3);
    expect(result.blockers).toMatchObject([{ reason: 'soak-declaration' }]);
    expect(effects.some(([cmd, args]) => cmd === 'create' || args?.[0] === 'push')).toBe(false);
  });
  it.each(['missing-nul', 'A\0\0', 'R100\0old\0', 'M\0README.md\0\0A\0new\0',
    'A\0new', 'R101\0old\0new\0', 'C1000\0old\0new\0'])('refuses malformed diff %j before push/create', rawDiff => {
    const { status, result, effects } = run({ count: 0, check: false, rawDiff });
    expect(status).toBe(3);
    expect(result.blockers).toMatchObject([{ reason: 'soak-declaration' }]);
    expect(effects.some(([cmd, args]) => cmd === 'create' || args?.[0] === 'push')).toBe(false);
  });
  it.each(['R100', 'C100', 'R095', 'C075', 'R5', 'C00'])('accepts an untimed destination of a %s record', code => {
    const rawDiff = `M\0scripts/lib/daemon-rebuild.mjs\0${code}\0old.soak.test.mjs\0scripts/conveyor/soak/breaks/preflight.soak.test.mjs\0`;
    const { status, result } = run({ count: 0, rawDiff, realSoak: true });
    expect(status).toBe(0);
    expect(result.reason).toBe('check-ok');
  });
  it.each(['é', 'a\tb', 'a\nb', 'a\rb', 'a"b', 'a\\b', '`echo x`', '--name', 'a\u2028b', 'e\u0301', 'a\u200bb', 'trailing '])('preserves NUL-delimited filename %j through the real precheck', name => {
    const rawDiff = `M\0scripts/lib/daemon-rebuild.mjs\0A\0scripts/conveyor/soak/breaks/${name}.soak.test.mjs\0M\0docs/${name}\0`;
    const { status, result, effects } = run({ count: 0, rawDiff, realSoak: true });
    expect(status).toBe(0);
    expect(result.reason).toBe('check-ok');
    expect(effects).toContainEqual(['git', ['diff', '--name-status', '-z', '-M', `origin/main...${'a'.repeat(40)}`]]);
  });
  it.each(['T', 'U', 'X'])('accepts unrelated %s status through the real precheck', code => {
    expect(run({ count: 0, realSoak: true, rawDiff: `${code}\0docs/é.md\0` }).status).toBe(0);
  });
  it('does not mistake a rename source for break evidence', () => {
    const rawDiff = 'M\0scripts/lib/daemon-rebuild.mjs\0R095\0scripts/conveyor/soak/breaks/old.mjs\0docs/new.md\0';
    expect(run({ count: 0, realSoak: true, rawDiff }).status).toBe(3);
  });
  it('still refuses a daemon fix without a break before push/create', () => {
    const { status, result, effects } = run({ count: 0, check: false, realSoak: true,
      rawDiff: 'M\0scripts/lib/daemon-rebuild.mjs\0' });
    expect(status).toBe(3);
    expect(result.blockers).toMatchObject([{ reason: 'soak-declaration' }]);
    expect(effects.some(([cmd, args]) => cmd === 'create' || args?.[0] === 'push')).toBe(false);
  });
  it.each(['test: add soak coverage', 'fix: admission'])('admits an untimed test for %s without reading timing files', title => {
    const { status, result, effects } = run({ count: 0, realSoak: true, title });
    expect(status).toBe(0);
    expect(result.reason).toBe('check-ok');
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'show' && args[1]?.endsWith('.timing.json'))).toBe(false);
  });
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

  it.each(['lane/daemon-poc', 'lane/mechanical-dispatcher'])('already-published %s with a stale tracker reaches PR creation with empty guard updates', ref => {
    const { status, result, effects, stderr } = publish({
      ref, remoteTip: `${sha}\trefs/heads/${ref}`,
      trackerText: '# Prototype tracker\n\n## Session update (2000-01-01) — stale fixture\nNo recent work.\n',
    });
    expect(result.reason).not.toBe('push-failed');
    expect(status).toBe(0);
    expect(pushes(effects)).toEqual([]);
    expect(effects.filter(([cmd]) => cmd === 'guard-input').map(([, path, input]) => [path.split('/').at(-1), input])).toEqual([
      ['guard-git-push.mjs', ''], ['guard-prototype-tracker.mjs', ''],
    ]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(stderr).toContain(`push skipped: origin already at ${sha}`);
  });

  it('origin equals HEAD: runs the pre-push hook, skips the network push and reaches PR creation', () => {
    const { effects, stderr } = publish({ remoteTip: tip(sha) });
    expect(pushes(effects)).toEqual([]);
    const guards = effects.filter(([cmd, args]) => cmd === process.execPath && /guard-.*\.mjs$/.test(args[0]));
    const hookGuards = Array.from(readFileSync(resolve('.githooks/pre-push'), 'utf8').matchAll(/node scripts\/(guard-[\w-]+\.mjs)/g), m => m[1]);
    expect(hookGuards).not.toEqual([]);
    expect(guards.map(([, args]) => args[0].split('/').at(-1))).toEqual(hookGuards);
    // The tip is read from the resolved PUSH URL, never from the remote name (which reads the fetch URL).
    expect(effects).toContainEqual(['git', ['remote', 'get-url', '--push', '--all', 'origin']]);
    expect(effects).toContainEqual(['git', ['ls-remote', '--', 'https://github.com/web-everything/web-everything.git', 'refs/heads/lane/preflight']]);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote' && args.includes('origin'))).toBe(false);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(stderr).toContain(`push skipped: origin already at ${sha}`);
  });

  it.each([
    ['pinned runner', JSON.stringify({ at: sha }), 'pinned runner cannot push'],
    ['expired pin at a different commit', JSON.stringify({ at: different, expiresAt: 0 }), 'pinned runner cannot push'],
    ['corrupt lane lease', '{broken', 'cannot read lane lease'],
    ['invalid lane lease shape', '[]', 'cannot read lane lease'],
  ])('origin equals HEAD: %s still refuses before PR creation', (_name, lease, diagnostic) => {
    const { status, result, effects, stderr } = publish({ remoteTip: tip(sha), lease });
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(result.detail).toContain(diagnostic);
    expect(pushes(effects)).toEqual([]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
    expect(stderr).not.toContain('push skipped');
  });

  it('origin equals HEAD: a refusing pre-push hook prevents PR creation', () => {
    const { status, result, effects } = publish({ remoteTip: tip(sha), refusePush: true });
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(pushes(effects)).toEqual([]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });

  it('a guard child failure never includes credentials from its push-URL argument', () => {
    const { status, result } = publish({ pushUrls: 'https://user:secret@fixture.test/repo.git', forkTip: tip(sha), refusePush: true });
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(result.detail).toContain('pre-push guards exit 1');
    expect(result.detail).not.toContain('user:secret');
    expect(result.detail).not.toContain('fixture.test');
  });

  it('origin behind: attempts the exact non-force push and preserves pre-push refusal', () => {
    const { status, result, effects, stderr } = publish({ remoteTip: tip(different), refusePush: true });
    expect(effects).toContainEqual(['git', ['--no-replace-objects', 'merge-base', '--is-ancestor', different, sha]]);
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

  it.each(['ahead', 'diverged'])('origin %s (merge-base proves not an ancestor): refuses before push or PR creation', () => {
    const { status, result, effects } = publish({ remoteTip: tip(different), ancestor: false });
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(result.detail).toContain(`non-fast-forward: origin/lane/preflight (${different})`);
    expect(pushes(effects)).toEqual([]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(false);
  });

  // An unreadable remote tip or ancestry must never block the push: the server validates fast-forward itself
  // (operator send-back on #7307). Only a definitive "not an ancestor" in a full (non-shallow) clone refuses.
  it.each([
    ['ancestry unreadable (tip object missing, exit 128)', { ancestor: 'unreadable' }],
    ['a shallow clone (merge-base may lie past the boundary)', { ancestor: false, shallow: 'true' }],
    ['an unreadable shallow state', { ancestor: false, shallow: null }],
    ['a garbage shallow state', { ancestor: false, shallow: 'maybe' }],
  ])('origin differs and %s: no refusal, guarded push runs and reaches PR creation', (_name, options) => {
    const { status, effects } = publish({ remoteTip: tip(different), ...options });
    expect(pushes(effects)).toEqual([['git', ['push', 'origin', `${sha}:refs/heads/lane/preflight`]]]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(status).toBe(0);
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

  // The push target is unknown (several push URLs, or an unreadable/unsafe one): nothing is read from any remote,
  // so a tip can neither skip nor refuse the push — it runs once and the server validates.
  const url = 'https://github.com/web-everything/web-everything.git';
  const fork = 'git@github.com:fork/web-everything.git';
  it.each([' ', '\t', '\r', '\u00a0'])('does not trim %j from the push URL before reading its tip', suffix => {
    const { status, effects, stderr } = publish({ pushUrls: url + suffix + '\n', remoteTip: tip(sha), forkTip: '', refusePush: true });
    expect(effects).toContainEqual(['git', ['ls-remote', '--', url + suffix, 'refs/heads/lane/preflight']]);
    expect(pushes(effects)).toHaveLength(1);
    expect(status).toBe(3);
    expect(stderr).not.toContain('push skipped');
  });

  it.each([' ', '\t', '\r', '\u00a0'])('does not trim %j from the ls-remote URL comparison', suffix => {
    const { effects, stderr } = publish({ pushUrls: url, getUrl: url + suffix + '\n', remoteTip: tip(sha), refusePush: true });
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote' && args[1] !== '--get-url')).toBe(false);
    expect(pushes(effects)).toHaveLength(1);
    expect(stderr).not.toContain('push skipped');
  });
  it.each([
    ['two remote.origin.url values (push goes to both)', { fetchUrls: `${url}\nhttps://mirror.test/we.git`, pushUrls: `${url}\nhttps://mirror.test/we.git` }],
    ['two push URLs', { pushUrls: `${url}\n${fork}` }],
    ['an extra blank URL line', { pushUrls: `${url}\n\n` }],
    ['an empty push URL read', { pushUrls: '' }],
    ['the push URL read fails (exit 2)', { pushUrls: 2 }],
    ['the push URL starts with "-" (would be read as an ls-remote option)', { pushUrls: '--upload-pack=touch /tmp/x' }],
  ])('origin equals HEAD but %s: no remote read, never skips, pushes exactly once', (_name, urls) => {
    const { status, result, effects, stderr } = publish({ remoteTip: tip(sha), forkTip: tip(sha), ...urls, refusePush: true });
    expect(effects).toContainEqual(['git', ['remote', 'get-url', '--push', '--all', 'origin']]);
    expect(effects.some(([cmd, args]) => cmd === 'git' && (args[0] === 'ls-remote' || args.includes('merge-base')))).toBe(false);
    expect(pushes(effects)).toEqual([['git', ['push', 'origin', `${sha}:refs/heads/lane/preflight`]]]);
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(stderr).not.toContain('push skipped');
  });

  // A separate pushurl / pushInsteadOf rewrite: the tip is read from the PUSH URL. The fetch URL's tip (upstream)
  // never skips, refuses or is even read (operator send-back on #7307).
  it('pushurl differs, the fork lacks the branch, upstream holds an unrelated tip: push runs, no exit 3', () => {
    const { status, effects } = publish({ remoteTip: tip(different), ancestor: false, pushUrls: fork, forkTip: '' });
    expect(effects).toContainEqual(['git', ['ls-remote', '--', fork, 'refs/heads/lane/preflight']]);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote' && args.includes(url))).toBe(false);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args.includes('merge-base'))).toBe(false);
    expect(pushes(effects)).toEqual([['git', ['push', 'origin', `${sha}:refs/heads/lane/preflight`]]]);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
    expect(status).toBe(0);
  });

  it.each([
    ['C holds HEAD (would falsely skip)', { forkTip: tip(sha), refusePush: true }, 3],
    ['C holds an unrelated tip (would falsely refuse)', { forkTip: tip(different), ancestor: false }, 0],
  ])('ls-remote would re-rewrite the push URL to another repo (chained insteadOf) and %s: no tip read, push runs', (_name, options, expected) => {
    const { status, effects, stderr } = publish({ pushUrls: fork, getUrl: 'https://elsewhere.test/c.git', ...options });
    expect(effects).toContainEqual(['git', ['ls-remote', '--get-url', '--', fork]]);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote' && args.includes('refs/heads/lane/preflight'))).toBe(false);
    expect(pushes(effects)).toEqual([['git', ['push', 'origin', `${sha}:refs/heads/lane/preflight`]]]);
    expect(stderr).not.toContain('push skipped');
    expect(status).toBe(expected);
  });

  it.each([false, true])('pushurl differs and the fork already holds HEAD: guards run before skipping, refusal=%s', refusePush => {
    const { status, result, effects, stderr } = publish({ remoteTip: tip(different), pushUrls: fork, forkTip: tip(sha), refusePush });
    expect(pushes(effects)).toEqual([]);
    const guards = effects.filter(([cmd, args]) => cmd === process.execPath && /guard-.*\.mjs$/.test(args[0]));
    expect(guards.map(([, args]) => args)).toEqual((refusePush
      ? ['guard-git-push.mjs'] : ['guard-git-push.mjs', 'guard-prototype-tracker.mjs'])
      .map(guard => [resolve('scripts', guard), 'origin', fork]));
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(!refusePush);
    expect(status).toBe(refusePush ? 3 : 0);
    if (refusePush) {
      expect(result.reason).toBe('push-failed');
      expect(stderr).not.toContain('push skipped');
    } else {
      expect(stderr).toContain(`push skipped: origin already at ${sha}`);
    }
  });

  it('pushurl differs and the fork tip is provably not an ancestor: refuses before push', () => {
    const { status, result, effects } = publish({ remoteTip: tip(sha), pushUrls: fork, forkTip: tip(different), ancestor: false });
    expect(effects).toContainEqual(['git', ['--no-replace-objects', 'merge-base', '--is-ancestor', different, sha]]);
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    expect(pushes(effects)).toEqual([]);
  });

  // The break-glass fallback must merge the commit this run published, never the fetch-side tracking ref:
  // with a separate push URL `origin/<ref>` is another repository's tip, and a failed fetch leaves it stale.
  it.each([
    ['a single shared URL', {}],
    ['a separate pushurl', { pushUrls: 'git@github.com:fork/web-everything.git', remoteTip: tip(different) }],
  ])('--fallback-git with %s merges the pushed refSha, not origin/<ref>', (_name, urls) => {
    const { status, result, effects } = publish({ createFails: true, fallbackGit: true, ...urls });
    const merges = effects.filter(([cmd, args]) => cmd === 'git' && args[0] === 'merge');
    expect(merges).toEqual([['git', ['merge', '--no-ff', sha, '-m', 'merge lane/preflight (pr-land git fallback)']]]);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'fetch')).toBe(false);
    expect(status).toBe(3);
    expect(result.reason).toBe('fallback-failed');
  });

  it('dry-run plan names the skip when origin already holds HEAD', () => {
    const { status, result, effects } = publish({ dryRun: true, remoteTip: tip(sha) });
    expect(status).toBe(0); expect(result.reason).toBe('dry-run');
    expect(result.plan).toContain(`push skipped: origin already at ${sha}`);
    expect(result.plan.some(line => line.startsWith('git push '))).toBe(false);
    expect(pushes(effects)).toEqual([]);
  });

  it.each([
    ['origin behind', { remoteTip: tip(different) }],
    ['pushurl configured', { remoteTip: tip(sha), pushUrls: 'git@github.com:fork/x.git' }],
    ['push URL unreadable', { remoteTip: tip(sha), pushUrls: 128 }],
  ])('dry-run plan keeps the push line when %s', (_name, options) => {
    const { status, result, effects } = publish({ dryRun: true, ...options });
    expect(status).toBe(0);
    expect(result.plan.some(line => line.startsWith(`git push origin HEAD:refs/heads/lane/preflight`))).toBe(true);
    expect(result.plan.some(line => line.startsWith('push skipped'))).toBe(false);
    expect(pushes(effects)).toEqual([]);
  });
});

// Real local git (temp bare repositories, no network): the publish step's remote reads, ancestry check and push
// run for real, so these prove what git itself does with pushurl, GIT_CONFIG and a shallow clone.
describe('pr-land lane publish against real local remotes', () => {
  const ref = 'refs/heads/lane/preflight';
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const gitEnv = { ...baseEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (repo, name) => { writeFileSync(join(repo, name), name); git(repo, 'add', name); git(repo, 'commit', '-qm', name); return git(repo, 'rev-parse', 'HEAD'); };
  const tipOf = (bare) => spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: bare, env: gitEnv, encoding: 'utf8' }).stdout.trim();
  const withRepos = fn => {
    const root = mkdtempSync(join(tmpdir(), 'pr-land-realgit-'));
    try {
      const upstream = join(root, 'upstream.git'), forkRepo = join(root, 'fork.git'), other = join(root, 'other');
      git(root, 'init', '-q', '--bare', upstream); git(root, 'init', '-q', '--bare', forkRepo);
      git(root, 'init', '-q', other);
      const unrelated = commit(other, 'unrelated'); // commit B: no shared history with the work repo
      git(other, 'push', '-q', upstream, `HEAD:${ref}`);
      return fn({ root, upstream, forkRepo, other, unrelated });
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const publishReal = (repo, sha, env = {}) => run({ check: false, count: 0, sha, realGit: { repo, env: { ...gitEnv, ...env } } });
  const refuseHook = repo => { const hook = join(repo, '.git', 'hooks', 'pre-push'); writeFileSync(hook, '#!/bin/sh\necho "fixture pre-push refuses" >&2\nexit 1\n', { mode: 0o755 }); };

  it('origin.url=upstream (lane/preflight at unrelated B), origin.pushurl=fork without it: pushes to the fork, no exit 3', () => withRepos(({ root, upstream, forkRepo, unrelated }) => {
    const work = join(root, 'work'); git(root, 'init', '-q', work);
    const sha = commit(work, 'a');
    git(work, 'remote', 'add', 'origin', upstream); git(work, 'config', 'remote.origin.pushurl', forkRepo);
    git(work, 'fetch', '-q', 'origin', ref); // B is present locally, so a fetch-side ancestry check would say "not an ancestor"
    const { status, result, effects } = publishReal(work, sha);
    expect(result.reason).not.toBe('push-failed');
    expect(status).toBe(0);
    expect(tipOf(forkRepo)).toBe(sha);
    expect(tipOf(upstream)).toBe(unrelated);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
  }), 30_000);

  it('origin.pushurl=fork already at HEAD: runs repository guards and skips only the network push', () => withRepos(({ root, upstream, forkRepo }) => {
    const work = join(root, 'work'); git(root, 'init', '-q', work);
    const sha = commit(work, 'a');
    git(work, 'push', '-q', forkRepo, `HEAD:${ref}`);
    git(work, 'remote', 'add', 'origin', upstream); git(work, 'config', 'remote.origin.pushurl', forkRepo);
    const { status, stderr, effects } = publishReal(work, sha);
    expect(stderr).toContain(`push skipped: origin already at ${sha}`);
    expect(status).toBe(0);
    expect(effects.filter(([cmd, args]) => cmd === process.execPath && /guard-.*\.mjs$/.test(args[0]))).toHaveLength(2);
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toBe(false);
    expect(effects.some(([cmd]) => cmd === 'create')).toBe(true);
  }), 30_000);

  // `git config` honours GIT_CONFIG but `git push` does not: the decision must follow the real push target.
  it('GIT_CONFIG naming a different pushurl does not change the push target read (isolation)', () => withRepos(({ root, upstream, forkRepo }) => {
    const work = join(root, 'work'); git(root, 'init', '-q', work);
    const sha = commit(work, 'a');
    git(work, 'remote', 'add', 'origin', upstream);
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`, '--force'); // upstream (the real push target) already at HEAD
    const override = join(root, 'override.gitconfig');
    writeFileSync(override, `[remote "origin"]\n\tpushurl = ${forkRepo}\n`);
    refuseHook(work);
    const { status, stderr, effects } = publishReal(work, sha, { GIT_CONFIG: override });
    expect(effects.some(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote' && args.includes(forkRepo))).toBe(false);
    expect(stderr).toContain(`push skipped: origin already at ${sha}`);
    expect(status).toBe(0);
    expect(tipOf(forkRepo)).toBe('');
  }), 30_000);

  // `get-url --push` applies insteadOf once (→ fork); `ls-remote <fork>` would apply it again (→ C). The push
  // writes the fork, so a tip read from C must never skip it (self-review must-fix on #7307).
  it('chained insteadOf (origin→fork→C, C already at HEAD): reads no tip from C and pushes to the fork', () => withRepos(({ root, forkRepo }) => {
    const cRepo = join(root, 'c.git'); git(root, 'init', '-q', '--bare', cRepo);
    const work = join(root, 'work'); git(root, 'init', '-q', work);
    const sha = commit(work, 'a');
    git(work, 'push', '-q', cRepo, `HEAD:${ref}`);
    git(work, 'remote', 'add', 'origin', 'chained-origin');
    git(work, 'config', `url.${forkRepo}.insteadOf`, 'chained-origin');
    git(work, 'config', `url.${cRepo}.insteadOf`, forkRepo);
    const { status, stderr } = publishReal(work, sha);
    expect(stderr).not.toContain('push skipped');
    expect(status).toBe(0);
    expect(tipOf(forkRepo)).toBe(sha);
  }), 30_000);

  it.each([
    ['the old tip object is missing locally (merge-base exit 128)', false],
    ['the old tip object is present past the shallow boundary (merge-base would falsely say "not an ancestor")', true],
  ])('a shallow clone with origin behind still publishes when %s; the server validates', (_name, fetchOld) => withRepos(({ root, upstream }) => {
    const seed = join(root, 'seed'); git(root, 'init', '-q', seed);
    const old = commit(seed, 'c1'); commit(seed, 'c2'); const head = commit(seed, 'c3');
    git(seed, 'push', '-q', upstream, `${old}:${ref}`, '--force'); git(seed, 'push', '-q', upstream, 'HEAD:refs/heads/main');
    const work = join(root, 'work');
    git(root, 'clone', '-q', '--depth=1', '--branch=main', pathToFileURL(upstream).href, work);
    expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true');
    if (fetchOld) {
      git(work, 'fetch', '-q', '--depth=1', 'origin', ref);
      expect(spawnSync('git', ['merge-base', '--is-ancestor', old, head], { cwd: work, env: gitEnv }).status).toBe(1);
    }
    const { status, result } = publishReal(work, head);
    expect(result.reason).not.toBe('push-failed');
    expect(status).toBe(0);
    expect(tipOf(upstream)).toBe(head);
  }), 30_000);

  // A forced `ssh -o BatchMode=yes` would override core.sshCommand, so the history fetch would reach a different
  // ssh identity than the push, fail, and leave git's client-side "fetch first" rejection (self-review on #7307).
  it('a shallow clone pushing over core.sshCommand completes history through that same ssh command and publishes', () => withRepos(({ root, upstream }) => {
    const seed = join(root, 'seed'); git(root, 'init', '-q', seed);
    const old = commit(seed, 'c1'); commit(seed, 'c2'); const head = commit(seed, 'c3');
    git(seed, 'push', '-q', upstream, `${old}:${ref}`, '--force'); git(seed, 'push', '-q', upstream, 'HEAD:refs/heads/main');
    const work = join(root, 'work');
    git(root, 'clone', '-q', '--depth=1', '--branch=main', pathToFileURL(upstream).href, work);
    const fakeSsh = join(root, 'fake-ssh.sh'), used = join(root, 'fake-ssh.log');
    writeFileSync(fakeSsh, `#!/bin/sh\necho "$1" >> '${used}'\nshift\nexec sh -c "$*"\n`, { mode: 0o755 });
    git(work, 'config', 'core.sshCommand', fakeSsh); git(work, 'config', 'ssh.variant', 'simple');
    git(work, 'config', 'remote.origin.pushurl', `ssh://fixture-host${upstream}`);
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git')); // the fetch URL is unusable: history must come over ssh
    const { status, result } = publishReal(work, head);
    expect(result.reason).not.toBe('push-failed');
    expect(status).toBe(0);
    expect(tipOf(upstream)).toBe(head);
    expect(readFileSync(used, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3); // ls-remote, history fetch, push
  }), 30_000);

  it('a failed git child is reported by exit status, never by its argv (a push URL can carry credentials)', () => {
    const e = Object.assign(new Error('Command failed: git fetch -q -- https://user:SECRET-TOKEN@h/x.git lane/x\nfatal: auth'), { status: 128, signal: null });
    expect(childFailureNote(e)).toBe('exit 128');
    expect(childFailureNote({ signal: 'SIGTERM', status: null, message: 'Command failed: git fetch -- https://u:SECRET@h/x' })).toBe('signal SIGTERM');
    expect(childFailureNote({ code: 'ENOENT', message: 'spawnSync git ENOENT https://u:SECRET@h' })).toBe('ENOENT');
    expect(childFailureNote({ code: 'https://u:SECRET@h', message: 'x' })).toBe('failed');
    expect(childFailureNote(undefined)).toBe('failed');
  });

  it('a shallow clone whose push target diverged still refuses (completed history proves it), and the tip is untouched', () => withRepos(({ root, upstream }) => {
    const seed = join(root, 'seed'); git(root, 'init', '-q', seed);
    commit(seed, 'c1'); const head = commit(seed, 'c2');
    git(seed, 'push', '-q', upstream, 'HEAD:refs/heads/main');
    git(seed, 'checkout', '-q', '-b', 'side', 'HEAD~1'); const diverged = commit(seed, 'side');
    git(seed, 'push', '-q', upstream, `${diverged}:${ref}`, '--force');
    const work = join(root, 'work');
    git(root, 'clone', '-q', '--depth=1', '--branch=main', pathToFileURL(upstream).href, work);
    const { status, result } = publishReal(work, head);
    expect(status).toBe(3);
    expect(result.reason).toBe('push-failed');
    // pr-land's own ancestry proof refused (not git's client-side rejection), so history was really completed.
    expect(result.detail).toContain('on the push target is ahead or diverged');
    expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false');
    // The history fetch wrote no remote-tracking ref for the lane branch (FETCH_HEAD only).
    expect(git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/lane')).toBe('');
    expect(tipOf(upstream)).toBe(diverged);
  }), 30_000);
});
