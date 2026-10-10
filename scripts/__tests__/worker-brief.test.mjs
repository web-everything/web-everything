/** @file Tests for the generated standard worker rules and injectable CLI. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { main, renderWorkerBrief } from '../worker-brief.mjs';

const params = { purpose: 'fix-widget', files: ['scripts/x.mjs', 'plateau-app:src/y.ts'], owner: 'tok12345' };
const files = 'we:scripts/x.mjs,plateau-app:src/y.ts';
const defaultProof = 'Prove the change on the live case with before/after evidence (command + output), not only unit tests.';
const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, writeFile: vi.fn(), newOwner: () => 'tok12345' });

describe('renderWorkerBrief', () => {
  it('renders every standard section in order and the qualified scope in commands', () => {
    const brief = renderWorkerBrief(params);
    const sections = ['## Standard worker rules', '**Scope.**', '1. **Free-scope pre-check.**',
      '2. **Register your scope.**', '3. **Lane.**', '4. **Codex for scoped coding.**',
      '5. **Red-green tests through the heavy queue.**', '6. **One PR.**',
      '7. **Pre-push recheck.**', '**Proof.**', '**Waiting (rule 23).**',
      '**Processes.**', '**Git.**', '**Times**', '**Report**'];
    let previous = -1;
    for (const section of sections) {
      const index = brief.indexOf(section);
      expect(index, section).toBeGreaterThan(previous);
      previous = index;
    }
    for (const text of [
      '- we:scripts/x.mjs', '- plateau-app:src/y.ts',
      `free-scope-cli.mjs check --files=${files}`,
      `register --agent=fix-widget --owner=tok12345 --purpose="fix-widget" --files=${files}`,
      'free-scope-cli.mjs release --agent=fix-widget --owner=tok12345',
      'lane-pool.mjs acquire --purpose=fix-widget --adopt',
      'lane-pool.mjs release --lane=<N> --session=<holder slug it printed>',
      'codex-direct-task.mjs --task-file=<f> --dir=<lane> --gate=standards',
      'npm run test:unit -- <test files>', 'operations/run.mjs verify --checkout=<lane>',
      'open-pr --ref=lane/fix-widget',
      `check --files=${files} --exclude-agent=fix-widget --exclude-owner=tok12345`,
      defaultProof, 'report it as PENDING', 'exact command', '10\nminutes',
      '`pkill`, `killall`', 'operator\'s dev server', 'No `--force`', 'no `--no-verify`',
      'no history rewrite', 'no `git add -A`', 'America/New_York (ET)', 'at most 8 lines',
    ]) expect(brief).toContain(text);
    expect(brief).not.toContain('8. **Edge.**');
    expect(brief).not.toContain('daemon-overlay');
    // An UNKNOWN verdict (exit 2) is never free: both checks must say to stop on it, not only on OCCUPIED.
    const section = (from, to) => brief.slice(brief.indexOf(from), brief.indexOf(to));
    for (const text of [section('1. **Free-scope pre-check.**', '2. **Register'),
      section('7. **Pre-push recheck.**', '**Proof.**')]) {
      expect(text).toMatch(/OCCUPIED/);
      expect(text).toMatch(/UNKNOWN/);
      expect(text).toMatch(/exit(?:s)? 2/);
    }
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
  it('mints a different token per brief by default and rejects a malformed one', () => {
    const { owner, ...rest } = params;
    const token = (brief) => /--owner=(\S+) --purpose/.exec(brief)[1];
    expect(token(renderWorkerBrief(rest))).not.toBe(token(renderWorkerBrief(rest)));
    expect(() => renderWorkerBrief({ ...rest, owner: 'bad token' })).toThrow('--owner');
    // the same token is used to register, release and exclude yourself at the pre-push recheck
    const brief = renderWorkerBrief({ ...rest, owner: 'abc123' });
    expect(brief.match(/--(?:exclude-)?owner=abc123/g)).toHaveLength(3);
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
