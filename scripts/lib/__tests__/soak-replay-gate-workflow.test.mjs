// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/soak-replay-gate.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs['soak-replay-gate'].steps;
const step = steps.find((s) => s.env?.PR_TITLE);
const narrowFetchStep = steps.find((s) => s.name === 'Fetch main history (blobless)');
const evaluator = new URL('../soak-replay-gate.mjs', import.meta.url).href;
const realScripts = fileURLToPath(new URL('../../', import.meta.url));
const gateFiles = ['soak-replay-gate-cli.mjs', 'lib/soak-replay-gate.mjs', 'lib/daemon-soak-scope.mjs', 'lib/soak-gate-merge-base-diff.mjs'];
const roots = [];
const title = 'fix(daemon): recover a lost candidate';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const fork = 'c'.repeat(40);
const mainTip = 'd'.repeat(40);
const mainRefspec = '+refs/heads/main:refs/remotes/origin/main';
const filesStatus = 'M\tscripts/lib/daemon-rebuild.mjs';
const waiver = 'soak-waiver: transport-only regression fixture';

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Substitutes exist only in the temporary fixture. Execute the parsed workflow's actual shell,
// capturing its argv and passing its transported body to the real gate evaluator.
function fixture(branch, eventBody = '') {
  const root = mkdtempSync(join(tmpdir(), 'soak-workflow-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'scripts'));
  if (branch !== 'absent') writeFileSync(join(root, 'scripts/soak-replay-gate-cli.mjs'), branch === 'modern' ? '// base-sha' : '// legacy');
  const executable = (name, source) => writeFileSync(join(root, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  executable('gh', `
    const fs = require('node:fs');
    fs.appendFileSync('api.jsonl', JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN }) + '\\n');
    if (process.env.API_FAILURE === '1') { console.error('API/auth/parse failure'); process.exit(1); }
    const response = JSON.parse(fs.readFileSync('response.json', 'utf8'));
    process.stdout.write((response.body ?? '') + '\\n');
  `);
  executable('git', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('git.jsonl', JSON.stringify(args) + '\\n');
    const fail = process.env.GIT_FAIL;
    if (fail === 'fetch-head' && args[0] === 'fetch' && args[2] === ${JSON.stringify(head)}) process.exit(1);
    if (fail === 'fetch-main' && args[0] === 'fetch' && args[2] === ${JSON.stringify(mainRefspec)}) process.exit(1);
    if (fail === 'fetch-base' && args[0] === 'fetch' && args[2] === ${JSON.stringify(base)}) process.exit(1);
    if (fail === 'fetch-unshallow' && args.includes('--unshallow')) process.exit(1);
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') { console.log(process.env.SHALLOW === '1' ? 'true' : 'false'); process.exit(0); }
    if (args[0] === 'rev-parse') { if (fail === 'rev-parse') process.exit(128); console.log(process.env.MAIN_TIP); }
    if (args[0] === 'merge-base' && fail === 'no-merge-base') process.exit(1);
    if (args[0] === 'merge-base') console.log(${JSON.stringify(fork)});
    if (args[0] === 'diff') console.log(${JSON.stringify(filesStatus)});
  `);
  executable('node', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('node.jsonl', JSON.stringify(args) + '\\n');
    const value = key => args.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
    import(${JSON.stringify(evaluator)}).then(({ evaluateSoakReplayGate }) => {
      const verdict = evaluateSoakReplayGate({ title: value('title'), body: value('body'),
        files: [{ path: 'scripts/lib/daemon-rebuild.mjs', changeType: 'MODIFIED' }] });
      console.log(JSON.stringify(verdict));
      process.exit(verdict.ok ? 0 : 1);
    });
  `);
  const log = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return {
    root, log,
    runNarrowFetch({ shallow = false, gitFail = '' } = {}) {
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', narrowFetchStep.run], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GIT_FAIL: gitFail, SHALLOW: shallow ? '1' : '0', MAIN_TIP: mainTip },
      });
    },
    run(body, { apiFailure = false, gitFail = '', baseRef = 'main', tip = mainTip } = {}) {
      writeFileSync(join(root, 'response.json'), JSON.stringify({ body }));
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          PR_TITLE: title, PR_BODY: eventBody, BASE_REF: baseRef, BASE_SHA: base, HEAD_SHA: head,
          GH_TOKEN: 'fixture-token', PR_REPO: 'fixture/repo', PR_NUMBER: '42',
          API_FAILURE: apiFailure ? '1' : '0', GIT_FAIL: gitFail, MAIN_TIP: tip },
      });
    },
  };
}

const mergeBaseAssert = (b) => ['merge-base', b, head];
const mainFetchCalls = [
  ['fetch', 'origin', mainRefspec],
  ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}'],
];

describe('soak workflow live PR body transport', () => {
  it('retains event triggers, main ancestry, and read-only authenticated PR bindings', () => {
    expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'edited']);
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(steps.find(s => s.uses?.startsWith('actions/checkout@')).with).toEqual({ ref: 'main', 'fetch-depth': 1 });
    // Narrow fetch: tip-only checkout, then complete main ancestry with blobs filtered, failing closed.
    expect(steps.indexOf(narrowFetchStep)).toBe(steps.indexOf(steps.find(s => s.uses?.startsWith('actions/checkout@'))) + 1);
    expect(narrowFetchStep.run).toContain('--unshallow --filter=blob:none');
    expect(narrowFetchStep.run).toContain('--is-shallow-repository');
    expect(narrowFetchStep.run).toContain('refs/remotes/origin/main^{commit}');
    expect(step.run).toContain('git merge-base "$BASE_SHA" "$HEAD_SHA"');
    expect(step.env).toEqual({
      PR_TITLE: '${{ github.event.pull_request.title }}',
      BASE_REF: '${{ github.event.pull_request.base.ref }}',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}', HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      GH_TOKEN: '${{ github.token }}', PR_REPO: '${{ github.repository }}', PR_NUMBER: '${{ github.event.pull_request.number }}',
    });
  });

  describe.each(['modern', 'legacy'])('%s CLI', branch => {
    const argvFor = (selectedBase, body) => [
      'scripts/soak-replay-gate-cli.mjs', `--title=${title}`, `--body=${body}`,
      ...(branch === 'modern' ? [`--base-sha=${selectedBase}`, `--head-sha=${head}`] : [`--files-status=${filesStatus}`]),
    ];

    it.each(['', waiver])('replays red → clear → red with a fixed event body %j and fresh API reads', eventBody => {
      const f = fixture(branch, eventBody);
      const bodies = ['', waiver, ''];
      expect(bodies.map(body => f.run(body).status)).toEqual([1, 0, 1]);
      expect(f.log('api.jsonl')).toEqual(bodies.map(() => ({ args: ['api', 'repos/fixture/repo/pulls/42', '--jq', '.body // ""'], token: 'fixture-token' })));
      expect(f.log('node.jsonl')).toEqual(bodies.map(body => argvFor(mainTip, body)));
      const gitCalls = [['fetch', 'origin', head], ...mainFetchCalls, mergeBaseAssert(mainTip), ...(branch === 'modern' ? [] : [
        ['merge-base', mainTip, head], ['diff', '--name-status', '-M', fork, head],
      ])];
      expect(f.log('git.jsonl')).toEqual(bodies.flatMap(() => gitCalls));
    });

    it('hands the CLI the fetched main snapshot, and a rerun after main advanced sees the newer tip', () => {
      const f = fixture(branch);
      const newer = 'e'.repeat(40);
      expect(f.run(waiver, { tip: mainTip }).status).toBe(0);
      expect(f.run(waiver, { tip: newer }).status).toBe(0);
      expect(f.log('node.jsonl')).toEqual([argvFor(mainTip, waiver), argvFor(newer, waiver)]);
    });

    it.each(['lane/4124-stack', 'release'])('keeps the event base for a non-main target %j (no main fetch)', baseRef => {
      const f = fixture(branch);
      expect(f.run(waiver, { baseRef }).status).toBe(0);
      expect(f.log('node.jsonl')).toEqual([argvFor(base, waiver)]);
      expect(f.log('git.jsonl')).toEqual([['fetch', 'origin', head], ['fetch', 'origin', base], mergeBaseAssert(base), ...(branch === 'modern' ? [] : [
        ['merge-base', base, head], ['diff', '--name-status', '-M', fork, head],
      ])]);
    });

    it.each([
      ['fetch-head', /fetch PR head/],
      ['fetch-main', /fetch current main/],
      ['rev-parse', /resolve the fetched main tip/],
      ['no-merge-base', /No merge-base between/],
    ])('refuses on %s failure without evaluating or using the stale event base', (gitFail, message) => {
      const f = fixture(branch, waiver);
      const result = f.run(waiver, { gitFail });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(message);
      expect(f.log('node.jsonl')).toEqual([]);
    });

    it('refuses a stacked PR whose event base cannot be fetched (no silent fallback)', () => {
      const f = fixture(branch, waiver);
      const result = f.run(waiver, { baseRef: 'lane/4124-stack', gitFail: 'fetch-base' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Failed to fetch event base/);
      expect(f.log('node.jsonl')).toEqual([]);
    });

    it.each([null, '', 'soak-waiver:   '])('keeps empty/null/blank-waiver body %j red', body => {
      const f = fixture(branch, waiver);
      expect(f.run(body).status).toBe(1);
      expect(f.log('node.jsonl')[0][2]).toBe(`--body=${body ?? ''}`);
    });

    it('transports multiline markdown and shell metacharacters literally', () => {
      const f = fixture(branch);
      const body = '## Fix\n"double" and \'single\'\n`touch executed` $(touch executed) $HOME\n' + waiver;
      expect(f.run(body).status).toBe(0);
      expect(f.log('node.jsonl')[0][2]).toBe(`--body=${body}`);
      expect(existsSync(join(f.root, 'executed'))).toBe(false);
    });

    it('fails retrieval explicitly without evaluating or falling back to an event waiver', () => {
      const f = fixture(branch, waiver);
      const result = f.run('', { apiFailure: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/failed to retrieve.*PR body/i);
      expect(f.log('api.jsonl')).toHaveLength(1);
      expect(f.log('node.jsonl')).toEqual([]);
    });
  });

  describe('narrow fetch fails closed', () => {
    it('passes when main history is complete, fetching unshallow + blobless', () => {
      const f = fixture('modern');
      expect(f.runNarrowFetch().status).toBe(0);
      expect(f.log('git.jsonl')[0]).toEqual(['fetch', '--no-tags', '--unshallow', '--filter=blob:none', 'origin', mainRefspec]);
    });

    it('FAILS when the repo is still shallow after the fetch', () => {
      const f = fixture('modern');
      const result = f.runNarrowFetch({ shallow: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/still shallow/);
    });

    it('FAILS when the history fetch itself fails', () => {
      const f = fixture('modern');
      const result = f.runNarrowFetch({ gitFail: 'fetch-unshallow' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/could not fetch main history/);
    });

    it('FAILS when the main tip does not resolve', () => {
      const f = fixture('modern');
      const result = f.runNarrowFetch({ gitFail: 'rev-parse' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/main tip does not resolve/);
    });
  });

  it('preserves the script-absent bootstrap before attempting retrieval', () => {
    const f = fixture('absent');
    const result = f.run('', { apiFailure: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not bootstrapped');
    expect(f.log('api.jsonl')).toEqual([]);
    expect(f.log('node.jsonl')).toEqual([]);
    expect(f.log('git.jsonl')).toEqual([]);
  });
});

// Shared mock harness for the merge_group-path steps of BOTH gate workflows (soak-replay-gate.yml, merge-gate.yml).
// Each step runs under `bash -e` ONLY — GitHub's default for a `run:` without a `shell:` key — so any pipefail a
// step needs must be set inside the step itself, and the tests prove it is.
const mgHead = 'f'.repeat(40);
const mgBase = '1'.repeat(40);
const groupPrs = { 7: { base: '2'.repeat(40), head: '3'.repeat(40) }, 8: { base: '4'.repeat(40), head: '5'.repeat(40) } };
function stepFixture(files = []) {
  const root = mkdtempSync(join(tmpdir(), 'gate-step-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'tmp'));
  for (const rel of files) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), '// fixture'); }
  const executable = (name, source) => writeFileSync(join(root, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const record = name => `require('node:fs').appendFileSync(${JSON.stringify(`${name}.jsonl`)}, JSON.stringify(process.argv.slice(2)) + '\\n');`;
  executable('git', `${record('git')}
    const args = process.argv.slice(2);
    const fail = (process.env.GIT_FAIL || '').split(',');
    if (args[0] === 'merge-base' && fail.includes('no-merge-base:' + args[1])) process.exit(1);
    if (args[0] === 'merge-base') console.log('0'.repeat(40));
    if (args[0] === 'archive') { if (fail.includes('archive')) { console.error('fatal: unable to fetch blob from promisor remote'); process.exit(128); } process.stdout.write('tar-stream'); }
  `);
  // A tar that reads its stdin and exits 0 even on a stream cut at a member boundary — what real tar does.
  executable('tar', `${record('tar')} process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
  executable('gh', `${record('gh')}
    const n = process.argv[3].split('/').pop();
    const pr = ${JSON.stringify(groupPrs)}[n];
    process.stdout.write(JSON.stringify({ title: 'fix(daemon): #' + n, body: 'soak-waiver: x', base: { sha: pr.base }, head: { sha: pr.head } }));
  `);
  executable('jq', `
    let s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => {
      const o = JSON.parse(s); const f = process.argv[3];
      const v = { '.title // ""': o.title, '.body // ""': o.body, '.base.sha': o.base.sha, '.head.sha': o.head.sha }[f];
      process.stdout.write(String(v) + '\\n');
    });
  `);
  executable('node', `${record('node')}
    if (process.argv.includes('--list-group')) console.log('7 8');
  `);
  const log = name => existsSync(join(root, `${name}.jsonl`)) ? readFileSync(join(root, `${name}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = (script, env) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: join(root, 'tmp'), ...env },
  });
  return { root, log, run };
}

// The class, not the instance: every gate step that pipes without an explicit bash `shell:` must set pipefail itself.
describe.each(['soak-replay-gate', 'merge-gate'])('%s workflow: piped steps fail closed', name => {
  const wf = yaml.load(readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const piped = wf.jobs[name].steps.filter(s => s.run && /(^|[^|])\|([^|]|$)/m.test(s.run) && s.shell !== 'bash');
  it('has at least one piped step to check', () => expect(piped.length).toBeGreaterThan(0));
  it.each(piped.map(s => [s.name, s]))('%s sets -o pipefail', (_n, s) => expect(s.run).toMatch(/^\s*set -o pipefail/m));
});

describe('soak workflow merge_group step', () => {
  const mgStep = steps.find(s => s.name?.startsWith('Merge group'));
  const env = gitFail => ({ GH_TOKEN: 'x', PR_REPO: 'fixture/repo', MG_HEAD_SHA: mgHead, MG_BASE_SHA: mgBase, MG_HEAD_REF: 'gh-readonly-queue/main/pr-7', GIT_FAIL: gitFail });
  const cliCalls = f => f.log('node').filter(a => a[0] === 'scripts/soak-replay-gate-cli.mjs').map(a => a.find(x => x.startsWith('--head-sha=')));
  const files = ['scripts/soak-replay-gate-cli.mjs', 'scripts/merge-gate-check.mjs'];

  it('evaluates every PR of the group against its own base/head', () => {
    const f = stepFixture(files);
    const result = f.run(mgStep.run, env(''));
    expect(result.status).toBe(0);
    expect(cliCalls(f)).toEqual([`--head-sha=${groupPrs[7].head}`, `--head-sha=${groupPrs[8].head}`]);
    expect(f.log('git').filter(a => a[0] === 'merge-base')).toEqual([['merge-base', groupPrs[7].base, groupPrs[7].head], ['merge-base', groupPrs[8].base, groupPrs[8].head]]);
  });

  it('merge_group rejects a PR without a merge-base: nonzero status, CLI never run for that PR, the rest still evaluated', () => {
    const f = stepFixture(files);
    const result = f.run(mgStep.run, env(`no-merge-base:${groupPrs[7].base}`));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no merge-base for PR #7/);
    expect(cliCalls(f)).toEqual([`--head-sha=${groupPrs[8].head}`]);
  });
});

describe('merge-gate workflow narrow fetch and merge-group history', () => {
  const mg = yaml.load(readFileSync(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url), 'utf8'));
  const mgSteps = mg.jobs['merge-gate'].steps;
  const checkout = mgSteps.find(s => s.uses?.startsWith('actions/checkout@'));
  const fetchStep = mgSteps.find(s => s.name === 'Fetch main history (blobless)');
  const evalStep = mgSteps.find(s => s.name === "Evaluate the drain's merge gates");
  const files = ['scripts/merge-gate-check.mjs', '.github/workflows/merge-gate.yml'];
  const mgEnv = gitFail => ({ REPO: 'fixture/repo', EVENT: 'merge_group', PR_NUMBER: '', MG_HEAD_SHA: mgHead, MG_BASE_SHA: mgBase, MG_HEAD_REF: 'gh-readonly-queue/main/pr-7', GIT_FAIL: gitFail });
  const gateRuns = f => f.log('node').filter(a => a[0] === 'scripts/lib/merge-gate-ci.mjs');

  it('checks out the main tip only, then fetches complete blobless main history in the very next step', () => {
    expect(checkout.with).toEqual({ ref: 'main', 'fetch-depth': 1 });
    expect(mgSteps.indexOf(fetchStep)).toBe(mgSteps.indexOf(checkout) + 1);
    expect(fetchStep.run).toContain("--unshallow --filter=blob:none origin '+refs/heads/main:refs/remotes/origin/main'");
  });

  // The fetch step's own shell, against the soak fixture's git mock (same SHALLOW / GIT_FAIL knobs).
  const runFetch = opts => { const f = fixture('modern'); narrowRun(f, opts); return f; };
  const narrowRun = (f, { shallow = false, gitFail = '' } = {}) => {
    f.result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', fetchStep.run], {
      cwd: f.root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, GIT_FAIL: gitFail, SHALLOW: shallow ? '1' : '0', MAIN_TIP: mainTip },
    });
  };

  it('narrow fetch passes on complete history', () => {
    const f = runFetch();
    expect(f.result.status).toBe(0);
    expect(f.log('git.jsonl')[0]).toEqual(['fetch', '--no-tags', '--unshallow', '--filter=blob:none', 'origin', mainRefspec]);
  });

  it.each([
    [{ shallow: true }, /merge-gate: history is still shallow/],
    [{ gitFail: 'fetch-unshallow' }, /merge-gate: could not fetch main history/],
    [{ gitFail: 'rev-parse' }, /merge-gate: main tip does not resolve/],
  ])('narrow fetch fails closed on %j', (opts, message) => {
    const f = runFetch(opts);
    expect(f.result.status).not.toBe(0);
    expect(f.result.stderr).toMatch(message);
  });

  it('merge group: extracts the group backlog tree and runs the gate against it', () => {
    const f = stepFixture(files);
    const result = f.run(evalStep.run, mgEnv(''));
    expect(result.status).toBe(0);
    expect(f.log('git')).toContainEqual(['merge-base', mgBase, mgHead]);
    expect(f.log('tar')).toEqual([['-x', '-C', join(f.root, 'tmp/group-tree')]]);
    expect(gateRuns(f)).toHaveLength(1);
    expect(gateRuns(f)[0]).toContain(`--group-tree=${join(f.root, 'tmp/group-tree')}`);
  });

  it('merge group: no merge-base between the group base and head fails closed before the gate', () => {
    const f = stepFixture(files);
    const result = f.run(evalStep.run, mgEnv(`no-merge-base:${mgBase}`));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no merge-base between the merge group's base and head/);
    expect(gateRuns(f)).toEqual([]);
  });

  // Blobless clone: `git archive` lazily fetches backlog blobs and can die mid-stream; tar still exits 0 on a stream
  // cut at a member boundary. Under GitHub's default `bash -e` (no pipefail) that would gate a partial tree.
  it('merge group: a failed git archive (lazy blob fetch) fails the step instead of gating a partial tree', () => {
    const f = stepFixture(files);
    const result = f.run(evalStep.run, mgEnv('archive'));
    expect(result.status).not.toBe(0);
    expect(gateRuns(f)).toEqual([]);
  });
});

// Real Git + the real CLI: the YAML's own shell runs against an actual origin whose main moved after the event fired.
describe('soak workflow against a real Git history (stale event base)', () => {
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd, files, message) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) { git(cwd, 'rm', '-q', path); continue; }
      mkdirSync(join(cwd, path, '..'), { recursive: true });
      writeFileSync(join(cwd, path), content);
      git(cwd, 'add', path);
    }
    git(cwd, 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  // A = main at event time; B = daemon commit the PR branch inherited; C = the PR's own docs-only commit;
  // D = unrelated main commit; main has since advanced to B + D.
  function history() {
    const root = mkdtempSync(join(tmpdir(), 'soak-real-git-'));
    roots.push(root);
    const origin = join(root, 'origin.git');
    const author = join(root, 'author');
    const ci = join(root, 'ci');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(root, 'init', '-q', '-b', 'main', author);
    git(author, 'remote', 'add', 'origin', origin);
    const A = commit(author, { 'README.md': 'a\n', 'scripts/lib/daemon-old.mjs': 'old\n' }, 'A');
    git(author, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', '--no-checkout', origin, ci); // the CI checkout at event time (main at A); no worktree, the gate scripts are copied in below
    git(author, 'checkout', '-q', '-b', 'pr');
    const B = commit(author, { 'scripts/lib/daemon-rebuild.mjs': 'inherited fix\n' }, 'B daemon fix (other branch)');
    const C = commit(author, { 'docs/note.md': 'docs only\n' }, 'C docs');
    git(author, 'checkout', '-q', 'main');
    git(author, 'merge', '-q', '--ff-only', B);
    const D = commit(author, { 'unrelated.txt': 'd\n' }, 'D unrelated');
    git(author, 'push', '-q', 'origin', 'main', 'pr:refs/heads/pr');
    // main's gate scripts, as the workflow's `ref: main` checkout provides (copied, not symlinked: the CLI's
    // `import.meta.url === argv[1]` main-guard fails through a symlinked directory and would silently exit 0).
    for (const rel of gateFiles) { mkdirSync(join(ci, 'scripts', rel, '..'), { recursive: true }); copyFileSync(join(realScripts, rel), join(ci, 'scripts', rel)); }
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}\nprocess.stdout.write('\\n');\n`, { mode: 0o755 });
    const run = (headSha, { baseRef = 'main', stepTitle = title, baseSha = A } = {}) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: ci, encoding: 'utf8', timeout: 20000,
      env: { ...gitEnv, PATH: `${join(root, 'bin')}:${process.env.PATH}`, PR_TITLE: stepTitle, BASE_REF: baseRef,
        BASE_SHA: baseSha, HEAD_SHA: headSha, GH_TOKEN: 'x', PR_REPO: 'fixture/repo', PR_NUMBER: '42' },
    });
    return { root, author, ci, A, B, C, D, run };
  }

  it('A1: the stale event base blames the PR for inherited B; the fetched main tip clears it', () => {
    const h = history();
    // The pre-change wiring handed the CLI the event base A: reproduce that selection directly.
    git(h.ci, 'fetch', '-q', 'origin', h.C); // the direct call needs the head locally; the workflow fetches it itself
    const stale = spawnSync('node', ['scripts/soak-replay-gate-cli.mjs', `--title=${title}`, '--body=', `--base-sha=${h.A}`, `--head-sha=${h.C}`],
      { cwd: h.ci, encoding: 'utf8', env: { ...gitEnv, PATH: process.env.PATH } });
    expect(stale.status).toBe(1);

    const fresh = h.run(h.C);
    expect(fresh.stderr + fresh.stdout).toContain(`base = fetched main ${h.D}`);
    expect(fresh.status).toBe(0);
  });

  it('A1: a PR-owned daemon fix E on the same history still refuses without replay or waiver', () => {
    const h = history();
    git(h.author, 'checkout', '-q', 'pr');
    const E = commit(h.author, { 'scripts/lib/daemon-rebuild.mjs': 'inherited fix\nPR own fix\n' }, 'E daemon fix (this PR)');
    git(h.author, 'push', '-q', 'origin', 'pr:refs/heads/pr');
    const result = h.run(E);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/soak-replay-gate ✗/);
  });

  it('A3: deletions, renames, config and data stay in the diff and in scope', () => {
    const cases = {
      deleted: { 'scripts/lib/daemon-old.mjs': null },
      renamed: null, // filled below
      config: { 'vitest.soak.config.ts': 'export default {};\n' },
      data: { 'scripts/conveyor/soak/fixture.json': '{}\n' },
    };
    for (const [name, files] of Object.entries(cases)) {
      const h = history();
      git(h.author, 'checkout', '-q', 'pr');
      let sha;
      if (name === 'renamed') {
        git(h.author, 'mv', 'scripts/lib/daemon-old.mjs', 'scripts/lib/daemon-renamed.mjs');
        git(h.author, 'commit', '-q', '-m', 'rename');
        sha = git(h.author, 'rev-parse', 'HEAD');
      } else {
        sha = commit(h.author, files, name);
      }
      git(h.author, 'push', '-q', 'origin', 'pr:refs/heads/pr');
      expect([name, h.run(sha).status]).toEqual([name, 1]);
    }
  });

  it('A4: a lane-targeted PR keeps its event base (open stack), so its inherited B stays attributed', () => {
    const h = history();
    const result = h.run(h.C, { baseRef: 'lane/4124-stack', baseSha: h.A });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain(`base = event base ${h.A}`);
  });

  it('A2: a failing main fetch (head still fetchable) refuses instead of using the stale event base', () => {
    const h = history();
    // Origin keeps every object, so the head-by-sha fetch still succeeds; only the main refspec fetch fails.
    git(join(h.root, 'origin.git'), 'update-ref', '-d', 'refs/heads/main');
    const result = h.run(h.C);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Failed to fetch current main/);
    expect(result.stderr).not.toMatch(/Failed to fetch PR head/);
  });
});
