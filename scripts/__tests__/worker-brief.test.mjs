/** @file Tests for the generated standard worker rules and injectable CLI. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, renderWorkerBrief } from '../worker-brief.mjs';
import { resolveBuildPolicy } from '../lib/build-policy.mjs';
import { readRegistry, resolveFreeScopeSettings } from '../operations/free-scope-io.mjs';
import { main as freeScopeMain } from '../operations/free-scope-cli.mjs';
import { heartbeatScope, partitionRegistry, registerScope } from '../operations/free-scope.mjs';

const params = { purpose: 'fix-widget', files: ['scripts/x.mjs', 'plateau-app:src/y.ts'], owner: 'tok12345' };
const files = 'we:scripts/x.mjs,plateau-app:src/y.ts';
const defaultProof = 'Prove the change on the live case with before/after evidence (command + output), not only unit tests.';
const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, writeFile: vi.fn(), newOwner: () => 'tok12345' });

describe('renderWorkerBrief', () => {
  it('keeps the main-based lane and overlap-only stacking instructions in step 3', () => {
    const brief = renderWorkerBrief(params);
    const lane = brief.slice(brief.indexOf('3. **Lane.**'), brief.indexOf('4. **Codex'));
    for (const text of ['origin/main', 'gh pr view <N> --json files', 'edge-loaded',
      'ONLY when your declared files overlap', 'No overlap', '--files']) expect(lane).toContain(text);
  });

  it('states the harness-tracked background rule in step 4', () => {
    const brief = renderWorkerBrief(params);
    const codex = brief.slice(brief.indexOf('4. **Codex'), brief.indexOf('5. **Red-green'));
    for (const text of ['timeout: 600000', "don't start a second copy", 'harness-tracked', '~180s',
      'nohup', 'setsid', 'SYNCHRONOUS']) expect(codex).toContain(text);
  });

  it('prints the four R302 speed rules before step 1 and keeps no contradicting Codex or verify line', () => {
    const brief = renderWorkerBrief(params);
    const speed = brief.slice(brief.indexOf('**Speed.**'), brief.indexOf('1. **Free-scope pre-check.**'));
    for (const rule of [
      'For Forge/remote work, do a real live Forge run in the first 15 minutes.',
      'Narrow tests while iterating; ONE full verify at the end (re-run only if code changed after it).',
      'Make small fixes (a few lines, a known finding) yourself; send Codex only larger builds.',
      'For a Codex follow-up fix, pass `--resume=<threadId>` from its previous run, with the exact file, line range and finding in the task.',
    ]) expect(speed).toContain(rule);
    expect(brief).not.toContain('Codex for scoped coding');
    expect(brief).not.toContain('single-file fix with clear');
    const codex = brief.slice(brief.indexOf('4. **Codex'), brief.indexOf('5. **Red-green'));
    expect(codex).toContain('Do small fixes (a few lines, a known finding) yourself.');
    expect(codex).toContain('--resume=<threadId>');
    expect(brief.slice(brief.indexOf('6. **One PR.**'), brief.indexOf('7. **Pre-push'))).toContain('verify ONCE at the end');
  });

  it('renders every standard section in order and the qualified scope in commands under the standard policy', () => {
    // Pin the standard: the live platform preference deliberately selects related tests.
    const policy = resolveBuildPolicy({ env: {}, tool: {}, platform: {} });
    const brief = renderWorkerBrief({ ...params, policy });
    const sections = ['## Standard worker rules', '**Scope.**', '1. **Free-scope pre-check.**',
      '2. **Register your scope.**', '3. **Lane.**', '4. **Codex for larger builds.**',
      '5. **Red-green tests through the heavy queue.**', '6. **One PR.**',
      '7. **Pre-push recheck.**', '**Proof.**', '**Waiting (rule 23).**',
      '**Processes.**', '**Git.**', '**Trust boundary.**', '**Times**', '**Report**'];
    let previous = -1;
    for (const section of sections) {
      const index = brief.indexOf(section);
      expect(index, section).toBeGreaterThan(previous);
      previous = index;
    }
    for (const text of [
      '- we:scripts/x.mjs', '- plateau-app:src/y.ts',
      `free-scope-cli.mjs check --files=${files}`,
      `register --agent=fix-widget --owner=tok12345 --purpose="fix-widget" --files=${files} --heartbeat`,
      'free-scope-cli.mjs release --agent=fix-widget --owner=tok12345',
      'lane-pool.mjs acquire --purpose=fix-widget --adopt',
      'lane-pool.mjs release --lane=<N> --session=<holder slug it printed>',
      'codex-direct-task.mjs --task-file=<f> --dir=<lane> --gate=full',
      'npm run test:unit -- <test files>', 'operations/run.mjs verify --checkout=<lane>',
      'open-pr --ref=lane/fix-widget',
      `check --files=${files} --exclude-agent=fix-widget --exclude-owner=tok12345`,
      defaultProof, 'report it as PENDING', 'exact command', '10\nminutes',
      '`pkill`, `killall`', 'operator\'s dev server', 'No `--force`', 'no `--no-verify`',
      'no history rewrite', 'no `git add -A`', 'America/New_York (ET)', 'at most 8 lines',
    ]) expect(brief).toContain(text);
    expect(brief).not.toContain('8. **Edge.**');
    expect(brief).not.toContain('daemon-overlay.mjs add --clone=');
    // An UNKNOWN verdict (exit 2) is never free: both checks must say to stop on it, not only on OCCUPIED.
    const section = (from, to) => brief.slice(brief.indexOf(from), brief.indexOf(to));
    for (const text of [section('1. **Free-scope pre-check.**', '2. **Register'),
      section('7. **Pre-push recheck.**', '**Proof.**')]) {
      expect(text).toMatch(/OCCUPIED/);
      expect(text).toMatch(/UNKNOWN/);
      expect(text).toMatch(/exit(?:s)? 2/);
    }
  });

  it('requires the trust-boundary section in the PR body and stops if the card lacks it', () => {
    expect(renderWorkerBrief(params)).toContain("**Trust boundary.** A build of a trust-boundary item must carry the card's `Trust boundary and threat model` section into the PR body; if the card lacks one, stop and report.");
  });

  it('tells the worker to stop and report when open-pr is refused by the PR limit, never to self-allow (xfaz7ho)', () => {
    expect(renderWorkerBrief(params)).toContain('If open-pr is refused by the PR limit, stop and report — never run pr-limit allow yourself.');
  });

  it('includes the optional edge section as the last numbered rule', () => {
    const brief = renderWorkerBrief({ ...params, edgeClone: '/tmp/edge' });
    expect(brief).toContain('8. **Edge.**');
    expect(brief).toContain('daemon-overlay.mjs add --clone=/tmp/edge --ref=lane/');
    expect(brief).toContain('--by=chalbert');
    expect(brief).toContain('WE_DAEMON_REBUILD_LOCK_WAIT_MS=900000 node scripts/lib/daemon-load-overlay.mjs --clone=/tmp/edge --ref=lane/');
    expect(brief).toContain('(gated; run once, foreground)');
    expect(brief).toContain('git -C /tmp/edge merge-base --is-ancestor <sha> HEAD');
    expect(brief.indexOf('8. **Edge.**')).toBeLessThan(brief.indexOf('**Proof.**'));
  });

  it('accepts custom proof, report length, and plateau-app lane selection without mutating input', () => {
    const input = Object.freeze({ ...params, files: Object.freeze([...params.files]),
      repo: 'plateau-app', proof: 'Show command=a and output=b.', reportLines: 4 });
    const brief = renderWorkerBrief(input);
    expect(brief).toContain('--adopt --repo=<plateau-app checkout>');
    expect(brief).toContain('**Proof.** Show command=a and output=b.');
    expect(brief).toContain('at most 4 lines');
    expect(brief).not.toContain(defaultProof);
    expect(renderWorkerBrief(input)).toBe(brief);
  });

  // A plateau-app lane has no scripts/verify-lane.mjs, so Codex's full or related gate would be gate-unavailable.
  it.each([['full', 'standards'], ['related', 'standards'], ['none', 'none']])('a plateau-app brief under finalGate=%s sends Codex --gate=%s', (finalGate, codexGate) => {
    const policy = resolveBuildPolicy({ env: {}, tool: {}, platform: { finalGate } });
    const brief = renderWorkerBrief({ ...params, repo: 'plateau-app', policy });
    expect(brief).toContain(`--dir=<lane> --gate=${codexGate}\``);
    expect(renderWorkerBrief({ ...params, policy })).toContain(`--dir=<lane> --gate=${finalGate}\``);
  });
});

describe('main', () => {
  it.each([
    ['--files=a'], ['--purpose=Bad_slug', '--files=a'], ['--purpose=ok'],
    ['--purpose=ok', '--files='], ['--purpose=ok', '--files=a,'],
    ['--purpose=ok', '--files=a', '--unknown=x'],
    ['--purpose=ok', '--files=a', '--repo=other'],
    ...['0', '-1', '1.5', 'nope', ''].map(n => ['--purpose=ok', '--files=a', `--report-lines=${n}`]),
  ])('rejects invalid arguments %j with usage and no output', async (...argv) => {
    const deps = io();
    expect(await main(argv, deps)).toBe(2);
    expect(deps.stderr.write.mock.calls.flat().join('')).toContain('Usage:');
    expect(deps.stdout.write).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('prints help without required parameters', async () => {
    const deps = io();
    expect(await main(['--help'], deps)).toBe(0);
    expect(deps.stdout.write.mock.calls.flat().join('')).toContain('Usage:');
    expect(deps.stderr.write).not.toHaveBeenCalled();
  });

  it('prints the rendered brief to stdout', async () => {
    const deps = io();
    expect(await main(['--purpose=fix-widget', `--files=${files}`], deps)).toBe(0);
    expect(deps.stdout.write).toHaveBeenCalledWith(renderWorkerBrief(params));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('writes --out through injected writeFile and preserves equals signs in values', async () => {
    const deps = io();
    expect(await main(['--purpose=fix-widget', `--files=${files}`, '--out=brief.md',
      '--edge-clone=/tmp/edge', '--repo=plateau-app', '--report-lines=3', '--proof=command=a'], deps)).toBe(0);
    expect(deps.writeFile).toHaveBeenCalledWith('brief.md', renderWorkerBrief({
      ...params, files, edgeClone: '/tmp/edge', repo: 'plateau-app', reportLines: 3, proof: 'command=a',
    }), 'utf8');
    expect(deps.stdout.write).not.toHaveBeenCalled();
  });

  it('reports output failures with exit 1', async () => {
    const deps = io();
    deps.writeFile.mockRejectedValue(new Error('disk full'));
    expect(await main(['--purpose=ok', '--files=a', '--out=brief.md'], deps)).toBe(1);
    expect(deps.stderr.write.mock.calls.flat().join('')).toContain('disk full');
  });
});

describe('per-dispatch owner token', () => {
  // Run the printed commands through the real CLI and registry, with only PR IO and time injected.
  const withRegistry = (window, check) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-brief-renewal-'));
    const env = { WE_AGENT_SCOPES_PATH: path.join(root, 'agents.json'), WE_FREE_SCOPE_STALE_AFTER_MINUTES: String(window) };
    const start = Date.parse('2026-11-01T00:00:00Z');
    const brief = renderWorkerBrief({ ...params, freeScope: resolveFreeScopeSettings({ env, platform: {} }) });
    const command = kind => new RegExp('`node scripts/operations/free-scope-cli.mjs (' + kind + '[^`]+)`').exec(brief)[1]
      .replaceAll('"', '').split(' ');
    const run = (argv, minute) => {
      let out = '', err = '';
      const now = () => start + minute * 60e3;
      const code = freeScopeMain(argv, { env, now,
        collect: ({ files }) => ({ files: files.split(','), nowMs: now(), unreadable: [], prs: [], agents: readRegistry(env.WE_AGENT_SCOPES_PATH) }),
        stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } },
      });
      return { code, out, err };
    };
    try { check({ brief, run, register: command('register'), heartbeat: command('check --files=[^`]+--exclude-agent='),
      entries: () => readRegistry(env.WE_AGENT_SCOPES_PATH), start }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  };

  it.each([45, 10])('printed %s-minute-window workflow renews ownership past the four-hour TTL', window => {
    withRegistry(window, ({ brief, run, register, heartbeat, entries, start }) => {
      const cadence = Number(/every ([\d.]+) minutes/.exec(brief)[1]);
      expect(run(register, 0).code).toBe(0);
      for (let minute = cadence; minute <= 260; minute += cadence) {
        expect(partitionRegistry(entries(), start + minute * 60e3).live, `reservation at minute ${minute}`).toHaveLength(1);
        expect(run(heartbeat, minute)).toMatchObject({ code: 0, err: '' });
        // Follow the brief's renewal instruction when present, rather than assuming checks renew the TTL.
        if (brief.includes('After every successful heartbeat check, re-run the exact register command above')) {
          expect(run(register, minute)).toMatchObject({ code: 0, err: '' });
        }
        expect(run(['check', `--files=${files}`, '--exclude-agent=competitor', '--exclude-owner=other'], minute).code).toBe(1);
      }
    });
  });

  it('requires stopping on a lost-reservation warning even when the heartbeat exits zero, then re-registering', () => {
    withRegistry(45, ({ brief, run, register, heartbeat }) => {
      expect(run(register, 0).code).toBe(0);
      for (let minute = 20; minute <= 240; minute += 20) {
        const result = run(heartbeat, minute);
        expect(result.code).toBe(0);
        if (minute === 240) expect(result.err).toContain('reservation is gone');
      }
      expect(brief).toContain('reservation is gone');
      expect(brief).toContain('stop editing even if the check exits 0');
      expect(brief).toContain('Resume only after the exact register command above succeeds');
      const prePush = brief.slice(brief.indexOf('7. **Pre-push recheck.**'));
      expect(prePush).toContain("Apply step 2's lost-reservation warning and renewal rules before proceeding");
      expect(fs.readFileSync('skills-src/worker-brief/SKILL.md', 'utf8')).toContain('same-owner TTL renewal');
      expect(run(register, 240)).toMatchObject({ code: 0, err: '' });
      expect(run(['check', `--files=${files}`], 240).code).toBe(1);
    });
  });

  it('keeps renewal subject to owner and occupied-scope refusals after expiry', () => {
    withRegistry(45, ({ brief, run, register }) => {
      expect(run(register, 0).code).toBe(0);
      const competitor = register.map(arg => arg === '--owner=tok12345' ? '--owner=other' : arg);
      expect(run(competitor, 240).code).toBe(0);
      expect(run(register, 240).code).toBe(2);
      const otherSlug = register.map(arg => arg === '--agent=fix-widget' ? '--agent=other-worker' : arg);
      expect(run(otherSlug, 240).code).toBe(1);
      expect(brief).toContain('If renewal exits non-zero, stop and report');
    });
  });

  it('mints a different token per brief by default and rejects a malformed one', () => {
    const { owner, ...rest } = params;
    const token = (brief) => /--owner=(\S+) --purpose/.exec(brief)[1];
    expect(token(renderWorkerBrief(rest))).not.toBe(token(renderWorkerBrief(rest)));
    expect(() => renderWorkerBrief({ ...rest, owner: 'bad token' })).toThrow('--owner');
    // the same token is used to register, heartbeat, release and exclude yourself at the pre-push recheck
    const brief = renderWorkerBrief({ ...rest, owner: 'abc123' });
    expect(brief.match(/--(?:exclude-)?owner=abc123/g)).toHaveLength(4);
  });

  it('registers with --heartbeat and tells the worker to heartbeat with the same token every 20 minutes by default', () => {
    const freeScope = resolveFreeScopeSettings({ env: {}, platform: {} });
    const brief = renderWorkerBrief({ ...params, freeScope });
    const step2 = brief.slice(brief.indexOf('2. **Register'), brief.indexOf('3. **Lane'));
    expect(step2).toMatch(/register --agent=fix-widget --owner=tok12345 [^`]*--heartbeat`/);
    expect(step2).toContain('reuse exactly this token');
    expect(step2).toContain('keep the reservation alive');
    expect(step2).toContain('every 20 minutes');
    expect(step2).toContain('half the configured stale window, capped at 20 minutes');
    expect(step2).toContain('Keep this cadence during long commands too');
    expect(step2).toContain('if you cannot, stop work and release the scope');
    for (const moment of ['after each Codex round', 'after each narrow-test round', 'before verify']) expect(step2).toContain(moment);
    expect(step2).toContain(`check --files=${files} --exclude-agent=fix-widget --exclude-owner=tok12345`);
    expect(step2).toContain('lastSeenAt');
    expect(step2).toMatch(/OCCUPIED or UNKNOWN \(exit 2\), stop and report/);
    // the pre-push recheck and the release stay
    expect(brief).toContain('7. **Pre-push recheck.**');
    expect(step2).toContain('free-scope-cli.mjs release --agent=fix-widget --owner=tok12345');
  });

  it.each([[10, 5], [0.5, 0.25], [45, 20], [120, 20]])(
    'CLI cadence for a %s-minute window keeps the owner live at minute 11', async (window, cadence) => {
      vi.stubEnv('WE_FREE_SCOPE_STALE_AFTER_MINUTES', String(window));
      try {
        const deps = io();
        expect(await main(['--purpose=fix-widget', `--files=${files}`], deps)).toBe(0);
        const brief = deps.stdout.write.mock.calls.flat().join('');
        expect(brief).toContain(`stale about ${window} minutes`);
        const match = /every ([\d.]+) minutes/.exec(brief);
        expect(match).not.toBeNull();
        const minutes = Number(match[1]);
        expect(minutes).toBe(cadence);
        expect(minutes).toBeLessThan(window);
        const start = Date.parse('2026-11-01T00:00:00Z');
        const at = minute => new Date(start + minute * 60e3).toISOString();
        let entries = registerScope([], { agent: params.purpose, owner: params.owner,
          files: params.files, staleAfterMinutes: window }, at(0));
        for (let minute = minutes; minute <= 11; minute += minutes) {
          expect(partitionRegistry(entries, start + minute * 60e3).live).toHaveLength(1);
          const beat = heartbeatScope(entries, params.purpose, params.owner, at(minute));
          expect(beat.refreshed).toBe(1);
          entries = beat.entries;
        }
        expect(partitionRegistry(entries, start + 11 * 60e3).live).toHaveLength(1);
        expect(() => registerScope(entries, { agent: params.purpose, owner: 'competitor',
          files: params.files, staleAfterMinutes: window }, at(11))).toThrow('different owner');
      } finally { vi.unstubAllEnvs(); }
    });

  it('uses the shared platform stale window for in-process briefs', () => {
    const freeScope = resolveFreeScopeSettings({ env: {}, platform: { staleAfterMinutes: 3 } });
    const brief = renderWorkerBrief({ ...params, freeScope });
    expect(brief).toContain('stale about 3 minutes');
    expect(brief).toContain('every 1.5 minutes');
  });

  it.each(['0', '-1', '', 'nope', 'Infinity', '5e-324', '1e-12', '0.000000000001',
    String(1 / 60e3), String((2 / 60e3) * (1 - Number.EPSILON))])('refuses to print a cadence for unusable stale window %j', async value => {
    vi.stubEnv('WE_FREE_SCOPE_STALE_AFTER_MINUTES', value);
    try {
      const deps = io();
      expect(await main(['--purpose=fix-widget', `--files=${files}`], deps)).toBe(2);
      expect(deps.stdout.write).not.toHaveBeenCalled();
      expect(deps.stderr.write.mock.calls.flat().join('')).toMatch(/invalid staleAfterMinutes/i);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([1e-12, 1 / 60e3, (2 / 60e3) * (1 - Number.EPSILON)])(
    'rejects a sub-millisecond cadence from injected settings (%s minutes)', staleAfterMinutes => {
      expect(() => renderWorkerBrief({ ...params, freeScope: { staleAfterMinutes } }))
        .toThrow(/invalid staleAfterMinutes/i);
    });

  it('refuses --out without writing a brief when the stale window is too small', async () => {
    vi.stubEnv('WE_FREE_SCOPE_STALE_AFTER_MINUTES', '1e-12');
    try {
      const deps = io();
      expect(await main(['--purpose=tiny', '--files=scripts/x.mjs', '--owner=token123', '--out=brief.md'], deps)).toBe(2);
      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(deps.stdout.write).not.toHaveBeenCalled();
      expect(deps.stderr.write.mock.calls.flat().join('')).toContain('at least 1 millisecond');
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps the minimum supported window live at registration and through printed-cadence renewals', () => {
    withRegistry(2 / 60e3, ({ brief, run, register, heartbeat, entries, start }) => {
      const cadence = Number(/every (\S+) minutes/.exec(brief)[1]);
      expect(cadence * 60e3).toBe(1);
      expect(run(register, 0)).toMatchObject({ code: 0, err: '' });
      expect(partitionRegistry(entries(), start).live).toHaveLength(1);
      for (let tick = 1; tick <= 3; tick++) {
        const minute = tick * cadence;
        expect(partitionRegistry(entries(), start + minute * 60e3).live).toHaveLength(1);
        expect(run(heartbeat, minute)).toMatchObject({ code: 0, err: '' });
        expect(run(register, minute)).toMatchObject({ code: 0, err: '' });
        expect(run(['check', `--files=${files}`], minute).code).toBe(1);
      }
    });
  });
});

describe('bare paths take the --repo prefix', () => {
  it('qualifies a bare path with plateau-app: when repo is plateau-app', () => {
    const brief = renderWorkerBrief({ purpose: 'ui-fix', files: ['src/a.ts'], repo: 'plateau-app' });
    expect(brief).toContain('--files=plateau-app:src/a.ts');
  });
});

describe('worker-brief hardening (items 90, 92)', () => {
  it('rejects hostile --files and --edge-clone before they reach shell commands', () => {
    for (const bad of ['a.mjs;rm -rf ~', 'a$(id).mjs', 'a`id`', 'a b.mjs', 'a"b']) {
      expect(() => renderWorkerBrief({ ...params, files: ['ok.mjs', bad] }), bad).toThrow(/unsafe/);
      expect(() => renderWorkerBrief({ ...params, files: `ok.mjs,${bad}` }), bad).toThrow(/unsafe/);
    }
    expect(() => renderWorkerBrief({ ...params, edgeClone: '/tmp/x; id' })).toThrow(/unsafe/);
    expect(renderWorkerBrief({ ...params, edgeClone: '/tmp/clone-1' })).toContain('--clone=/tmp/clone-1');
  });

  it('step 2 and the SKILL both say to stop when register exits non-zero', () => {
    const brief = renderWorkerBrief(params);
    const step2 = brief.slice(brief.indexOf('2. **Register'), brief.indexOf('3. **Lane'));
    expect(step2).toMatch(/register exits non-zero[\s\S]*stop and report/);
    const skill = fs.readFileSync('skills-src/worker-brief/SKILL.md', 'utf8');
    expect(skill).toMatch(/register` exits non-zero[\s\S]*stop and report/);
  });
});
describe('early PR-size guidance', () => {
  it('requires a split plan for cards sized >= 8 before any build', () => {
    const brief = renderWorkerBrief({ purpose: 'size-check', files: ['scripts/example.mjs'] });
    expect(brief).toContain('If the card size is >= 8, ask for a split plan up front, before any build.');
  });

  it('checks size after the first Codex round before verify/converge and stops oversized builds', () => {
    const brief = renderWorkerBrief({ purpose: 'size-check', files: ['scripts/example.mjs'] });
    expect(brief).toContain('After the first Codex round and before verify/converge, run');
    expect(brief).toContain('node scripts/operations/run.mjs pr-size --checkout=<lane>');
    expect(brief).toContain('If over the limit, stop and propose a split plan instead of finishing the build.');
    expect(brief.indexOf('pr-size --checkout=<lane>')).toBeLessThan(brief.indexOf('6. **One PR.**'));
  });
});
