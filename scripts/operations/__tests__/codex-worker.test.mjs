import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCard, resolveAllowedFiles, isAllowed, checkAllowedDiff, parsePorcelain,
  findScopeConflicts, REPO_RULES_PREAMBLE, composeTask, planBranch, composePrBody,
  buildRunRecord, parseLastJson, runCodexWorker, GIT_HARDENING, OPEN_PR_LIMIT, collectScopeChanges,
  snapshotGitState, diffGitState, parseGitlinks, GIT_HARDENING_ENV,
} from '../codex-worker.mjs';

const BASE_SHA = 'a'.repeat(40);

const markdown = `---
status: open
scope: ["we:scripts/", "we:README.md"]
---
# Repair the worker

The worker needs a scope guard.

Keep the existing interface.

## Done when

TODO

Hint: replace the placeholder.
## Notes
Not part of the acceptance criteria.
`;
const task = {
  cardId: '123', title: 'Repair the worker', digest: 'Needs a guard.',
  doneWhen: 'TODO', allowed: ['scripts/', 'backlog/123-worker.md'],
};

describe('card and scope planning', () => {
  it('extracts frontmatter, prose and TODO without hints or later sections', () => {
    expect(parseCard(markdown)).toEqual({
      title: 'Repair the worker', digest: 'The worker needs a scope guard.\n\nKeep the existing interface.',
      doneWhen: 'TODO', scope: ['we:scripts/', 'we:README.md'], status: 'open',
    });
    expect(parseCard('# Brief\nBody\n## Done when\nRun tests\n## Later\nNo').doneWhen).toBe('Run tests');
    expect(parseCard('# Brief\nBody')).toEqual({ title: 'Brief', digest: 'Body', doneWhen: '', scope: [], status: '' });
  });

  it('defaults to card scope, strips we:, deduplicates and always permits the card', () => {
    expect(resolveAllowedFiles({ card: parseCard(markdown), cardPath: 'backlog/123-worker.md' }))
      .toEqual(['scripts/', 'README.md', 'backlog/123-worker.md']);
    expect(resolveAllowedFiles({ filesFlag: ' we:a.js,./a.js,we:backlog/123-worker.md ', card: parseCard(markdown), cardPath: 'backlog/123-worker.md' }))
      .toEqual(['a.js', 'backlog/123-worker.md']);
    expect(resolveAllowedFiles({})).toEqual([]);
  });

  it('fails closed on malformed scope and accepts quoted status', () => {
    expect(() => parseCard(markdown.replace('["we:scripts/", "we:README.md"]', '[bad YAML]'))).toThrow();
    expect(() => parseCard(markdown.replace('["we:scripts/", "we:README.md"]', '[123]'))).toThrow();
    expect(parseCard(markdown.replace('status: open', 'status: "open"')).status).toBe('open');
  });

  it('distinguishes directory prefixes from exact files and normalizes ./', () => {
    expect(isAllowed('./scripts/a.js', ['./scripts/'])).toBe(true);
    expect(isAllowed('scripts-other/a.js', ['scripts/'])).toBe(false);
    expect(isAllowed('README.md/child', ['README.md'])).toBe(false);
    expect(isAllowed('./README.md', ['README.md'])).toBe(true);
  });

  it.each(['../secret', 'scripts/../secret', './scripts/../../secret', '/scripts/a.js', 'scripts\\..\\secret'])('rejects unsafe path %s', (path) => {
    expect(isAllowed(path, ['scripts/', '../', '/'])).toBe(false);
  });

  it('reports outside paths without duplicates', () => {
    expect(checkAllowedDiff(['scripts/a.js', 'other.js', 'other.js'], ['scripts/']))
      .toEqual({ ok: false, outside: ['other.js'] });
    expect(checkAllowedDiff(['scripts/a.js'], ['scripts/'])).toEqual({ ok: true, outside: [] });
  });

  it('parses status columns, rename endpoints, spaces and Git quoted UTF-8 paths', () => {
    expect(parsePorcelain(' M scripts/a.js\n?? new file.js\nR  old.js -> scripts/new.js\n D "old\\tfile.js"\nR  "old -> name" -> "new\\\"name"\n?? "caf\\303\\251.js"\n'))
      .toEqual(['scripts/a.js', 'new file.js', 'old.js', 'scripts/new.js', 'old\tfile.js', 'old -> name', 'new"name', 'café.js']);
    expect(parsePorcelain('')).toEqual([]);
  });

  it('finds only overlapping files in open PRs', () => {
    expect(findScopeConflicts([
      { number: 4, title: 'Busy', headRefName: 'work', files: [{ path: 'scripts/a.js' }, { path: 'README.md' }, { path: 'elsewhere' }] },
      { number: 5, title: 'Free', files: [{ path: 'scripts-other/a.js' }] },
    ], ['scripts/', 'README.md'])).toEqual([{ number: 4, title: 'Busy', files: ['scripts/a.js', 'README.md'] }]);
  });
});

describe('task, branch and reporting', () => {
  it('includes all seven numbered repository rules and the task sections', () => {
    const text = composeTask(task);
    expect(text).toContain(REPO_RULES_PREAMBLE);
    const rules = REPO_RULES_PREAMBLE.split('\n').filter((line) => /^\d+\./.test(line));
    expect(rules).toHaveLength(7);
    for (const phrase of ['lane clone', 'ALLOWED', 'refused', 'Never edit outside this checkout', 'red-green', 'fails',
      'npm run test:unit -- <test files>', 'never the whole suite', 'No network', 'never npm install',
      'Do not commit, push, or open a PR', 'minimal', 'AGENTS.md', 'TODO', 'concrete executable line', 'short final message']) {
      expect(REPO_RULES_PREAMBLE).toContain(phrase);
    }
    expect(text).toContain('Card #123: Repair the worker');
    expect(text).toContain('## Problem\nNeeds a guard.');
    expect(text).toContain('## Done when\nTODO');
    expect(text).toContain('## Allowed files\nscripts/\nbacklog/123-worker.md');
    expect(composeTask({ ...task, briefText: 'Use this brief.' })).toContain('## Problem\nUse this brief.');
    expect(composeTask({ ...task, briefText: 'Use this brief.' })).not.toContain(task.digest);
  });

  it('makes bounded, trimmed branch names for cards and briefs', () => {
    expect(planBranch('123', ' Fix THIS / bug! ')).toBe('lane/codex-123-fix-this-bug');
    expect(planBranch(undefined, 'Brief task')).toBe('lane/codex-brief-brief-task');
    expect(planBranch('123', `${'a'.repeat(39)} !!! more`)).toBe(`lane/codex-123-${'a'.repeat(39)}`);
  });

  it('produces a PR body with attribution, acceptance, scope, usage and steps', () => {
    const body = composePrBody({ ...task, diffStat: '1 file changed',
      codex: { usage: { input_tokens: 12, output_tokens: 9 }, quotaUsedPercent: 4 },
      steps: [{ name: 'verify', ok: true, ms: 35, detail: 'passed' }],
    });
    for (const phrase of ['codex-direct pilot', 'Card: #123', 'TODO', 'scripts/', '1 file changed', '12', '9', '4%', '| verify |']) expect(body).toContain(phrase);
    expect(body).not.toContain('Closes');
    expect(body.trimEnd().endsWith('🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toBe(true);
  });

  it('builds a plain run record with rounded elapsed minutes', () => {
    const steps = [{ name: 'verify', ok: true, ms: 1, detail: 'pass', extra: 'omit' }];
    expect(buildRunRecord({ cardId: '123', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:33Z', steps,
      codex: { threadId: 'thread', usage: { input_tokens: 4 }, quotaUsedPercent: 2, gate: {} }, pr: { number: 7 }, outcome: 'pr-opened',
    })).toEqual({ ts: '2026-01-01T00:01:33.000Z', card: '123', minutes: 1.6, outcome: 'pr-opened', pr: { number: 7 },
      codex: { threadId: 'thread', usage: { input_tokens: 4 }, quotaUsedPercent: 2 }, steps: [{ name: 'verify', ok: true, ms: 1, detail: 'pass' }],
    });
  });

  it('parses the last complete JSON document, including pretty output after log lines', () => {
    expect(parseLastJson('noise\n{"old":true}\nmore\n{\n  "last": {"nested": true}\n}\n')).toEqual({ last: { nested: true } });
    expect(parseLastJson('{"first":1}\n{"last":2}\n')).toEqual({ last: 2 });
    expect(parseLastJson('noise {"inline":true}')).toBeNull();
    expect(parseLastJson('{broken}\n')).toBeNull();
    expect(parseLastJson('{"valid":true}\ntrailing noise')).toBeNull();
  });
});

// All effects stay in memory: no real git, gh, Codex, lane or record file.
// `gitStates` scripts the successive `.git` snapshots (before Codex, after Codex, before open-pr); the last one repeats.
function harness({ prs = [], status = ' M scripts/a.js\n', committed = '', fail, reportChanges = true, acquire, codexOutput, prOutput, verifyOutput, failWrite, failRecord, gitStates = [{}], lsFiles = [''] } = {}) {
  const calls = [], writes = [], records = [];
  let tick = 0, snapshots = 0, lsCalls = 0;
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (fail?.(cmd, args)) throw Object.assign(new Error('command failed'), {
      stdout: args[0] === 'scripts/codex-direct-task.mjs' ? JSON.stringify({ events: { threadId: 'failed-thread' }, diff: { hasChanges: true } }) : 'x'.repeat(3000), stderr: 'failure tail',
    });
    if (cmd === 'gh') return JSON.stringify(prs);
    if (args.includes('acquire')) return acquire ?? 'acquiring\n' + JSON.stringify({ path: '/fake/lane', lane: 54, holder: 'session' });
    if (args[0] === 'scripts/codex-direct-task.mjs') return codexOutput ?? JSON.stringify({ events: { threadId: 'thread', usage: { input_tokens: 12, output_tokens: 9 } }, quotaUsedPercent: 3, gate: { pass: false }, diff: { hasChanges: reportChanges } });
    if (args.includes('rev-parse')) return `${BASE_SHA}\n`;
    if (args.includes('ls-files')) return lsFiles[Math.min(lsCalls++, lsFiles.length - 1)];
    if (args.includes('status')) return status;
    if (args.includes('--name-only')) return committed;
    if (args.includes('--stat')) return '1 file changed';
    if (args.includes('verify')) return verifyOutput ?? JSON.stringify({ verdict: { ok: true, passed: 1, failed: 0 } }, null, 2);
    if (args.includes('open-pr')) return prOutput ?? 'opened\n{"url":"https://github.com/example/repo/pull/42"}';
    return '';
  };
  return {
    calls, writes, records,
    run: () => runCodexWorker({ ...task, repoRoot: '/fake/repo', recordFile: '/fake/records.jsonl' }, {
      exec, now: () => tick++ * 10, log: () => {},
      snapshotGit: (gitDir) => {
        calls.push({ cmd: 'snapshot', args: [gitDir], opts: {} });
        return gitStates[Math.min(snapshots++, gitStates.length - 1)];
      },
      writeFile: (path, text) => {
        if (failWrite) throw new Error('write failed');
        writes.push({ path, text });
      },
      appendRecord: (record, path) => {
        if (failRecord) throw new Error('record failed');
        records.push({ record, path });
      },
    }),
  };
}

describe('worker orchestration', () => {
  it('refuses outside changes before commit and still releases and records', () => {
    const h = harness({ status: ' M outside.js\n' });
    const result = h.run();
    expect(result.outcome).toBe('refused:scope-guard');
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toContain('outside.js');
    expect(h.calls.some(({ args }) => args.includes('commit'))).toBe(false);
    expect(h.calls.some(({ args }) => args.includes('release'))).toBe(true);
    expect(h.records[0].record.outcome).toBe(result.outcome);
    expect(result.steps.slice(-2).map((step) => step.name)).toEqual(['release', 'record']);
  });

  it('refuses occupied scope before acquiring a lane', () => {
    const h = harness({ prs: [{ number: 9, title: 'Busy', files: [{ path: 'scripts/a.js' }] }] });
    const result = h.run();
    expect(result.outcome).toBe('refused:free-scope');
    expect(result.steps[0].detail).toContain('#9');
    expect(h.calls).toHaveLength(1);
    expect(h.writes).toEqual([]);
    expect(h.records).toHaveLength(1);
  });

  it('opens a PR in the specified step order despite the advisory Codex gate failing', () => {
    const h = harness();
    const result = h.run();
    expect(result.outcome).toBe('pr-opened');
    expect(result.pr.number).toBe(42);
    expect(result.steps.map((step) => step.name)).toEqual(['free-scope', 'lane-acquire', 'compose', 'codex', 'scope-guard', 'commit', 'verify', 'open-pr', 'release', 'record']);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.steps[3].detail).toMatch(/gate.*fail/i);
    expect(h.records[0]).toEqual({ record: result.record, path: '/fake/records.jsonl' });
    expect(result.record).toMatchObject({ outcome: 'pr-opened', pr: { number: 42 }, codex: { threadId: 'thread', quotaUsedPercent: 3 } });
    expect(h.calls.find(({ args }) => args.includes('add')).args).toEqual(['-C', '/fake/lane', ...GIT_HARDENING, '--literal-pathspecs', 'add', '--', 'scripts/a.js']);
    expect(h.calls.find(({ args }) => args[0] === 'scripts/codex-direct-task.mjs')).toMatchObject({
      args: ['scripts/codex-direct-task.mjs', '--task-file=/fake/lane/.git/codex-worker-task.md', '--dir=/fake/lane', '--gate=standards', '--no-stream', '--json', '--no-install'],
      opts: { cwd: '/fake/repo', timeout: 45 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    });
    expect(h.calls.find(({ args }) => args.includes('verify')).opts.timeout).toBe(40 * 60_000);
    expect(h.calls.find(({ args }) => args.includes('open-pr')).opts.cwd).toBe('/fake/lane');
    expect(h.calls.find(({ args }) => args.includes('release')).args).toEqual(['scripts/lane-pool.mjs', 'release', '--lane=54', '--session=session']);
    expect(h.writes.map(({ path }) => path)).toEqual(['/fake/lane/.git/codex-worker-task.md', '/fake/lane/.git/codex-worker-pr-body.md']);
  });

  it('guards committed changes too and refuses an empty changed set', () => {
    expect(harness({ committed: 'outside.js\n' }).run().outcome).toBe('refused:scope-guard');
    expect(harness({ status: '' }).run().outcome).toBe('refused:scope-guard');
  });

  it('skips the commit (no "nothing to commit" failure) when Codex committed its own in-scope work', () => {
    const h = harness({ status: '', committed: 'scripts/a.js\n' });
    const result = h.run();
    expect(result.outcome).toBe('pr-opened');
    expect(h.calls.some(({ args }) => args.includes('add') || args.includes('commit'))).toBe(false);
    expect(result.steps.find((step) => step.name === 'commit').detail).toMatch(/already committed/i);
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toContain('scripts/a.js');
  });

  it('commits only the dirty paths when Codex also committed part of the work', () => {
    const h = harness({ status: ' M scripts/b.js\n', committed: 'scripts/a.js\n' });
    expect(h.run().outcome).toBe('pr-opened');
    expect(h.calls.find(({ args }) => args.includes('add')).args.slice(-3)).toEqual(['add', '--', 'scripts/b.js']);
  });

  it('routes every git call through the hardened helper and never runs hooks on commit', () => {
    const h = harness();
    h.run();
    const gitCalls = h.calls.filter(({ cmd }) => cmd === 'git');
    expect(gitCalls.length).toBeGreaterThanOrEqual(5);
    for (const { args } of gitCalls) expect(args.slice(0, 2 + GIT_HARDENING.length)).toEqual(['-C', '/fake/lane', ...GIT_HARDENING]);
    expect(GIT_HARDENING).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.sshCommand=', 'commit.gpgSign=false']));
    expect(gitCalls.find(({ args }) => args.includes('commit')).args).toContain('--no-verify');
  });

  it('snapshots the lane .git before Codex runs and compares it after, before any git call', () => {
    const h = harness();
    h.run();
    const snaps = h.calls.map(({ cmd, args }, i) => (cmd === 'snapshot' ? [i, args[0]] : null)).filter(Boolean);
    // before Codex, after Codex (scope-guard), after verify (open-pr), and once more before deciding to release
    expect(snaps.map(([, dir]) => dir)).toEqual(Array(4).fill('/fake/lane/.git'));
    const codexRun = h.calls.findIndex(({ args }) => args[0] === 'scripts/codex-direct-task.mjs');
    const firstGitAfterCodex = h.calls.findIndex(({ cmd }, i) => i > codexRun && cmd === 'git');
    expect(snaps[0][0]).toBeLessThan(codexRun);
    expect(snaps[1][0]).toBeGreaterThan(codexRun);
    expect(snaps[1][0]).toBeLessThan(firstGitAfterCodex);
  });

  it('refuses a lane whose .git config/attributes Codex changed, before any git call could run a filter', () => {
    const h = harness({ gitStates: [{ config: 'a', 'info/attributes': null }, { config: 'b', 'info/attributes': 'c' }] });
    const result = h.run();
    expect(result.outcome).toBe('refused:scope-guard');
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toMatch(/\.git state changed.*config.*info\/attributes/s);
    const afterCodex = h.calls.slice(h.calls.findIndex(({ args }) => args[0] === 'scripts/codex-direct-task.mjs') + 1);
    expect(afterCodex.filter(({ cmd }) => cmd === 'git')).toEqual([]);
    expect(afterCodex.some(({ args }) => args.includes('verify') || args.includes('open-pr'))).toBe(false);
    // release runs a raw `git status` in the lane, which would execute the planted payload: it must NOT run
    expect(afterCodex.some(({ args }) => args.includes('release'))).toBe(false);
    expect(result.steps.find((step) => step.name === 'release')).toMatchObject({ ok: true, detail: expect.stringContaining('NOT released') });
  });

  it('also refuses to release a lane whose .git Codex changed when the codex step itself failed', () => {
    const h = harness({
      fail: (cmd, args) => args[0] === 'scripts/codex-direct-task.mjs',
      gitStates: [{ config: 'a' }, { config: 'evil' }],
    });
    const result = h.run();
    expect(result.outcome).toBe('failed:codex');
    expect(h.calls.some(({ args }) => args.includes('release'))).toBe(false);
    expect(result.steps.find((step) => step.name === 'release').detail).toContain('NOT released');
  });

  it('refuses a gitlink (nested repo) Codex added to the index, before git status can enter it', () => {
    const link = '160000 ' + 'b'.repeat(40) + '\t0\tsub\0';
    const h = harness({ lsFiles: ['', link] });
    const result = h.run();
    expect(result.outcome).toBe('refused:scope-guard');
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toContain('gitlink');
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toContain('sub');
    const afterCodex = h.calls.slice(h.calls.findIndex(({ args }) => args[0] === 'scripts/codex-direct-task.mjs') + 1);
    expect(afterCodex.filter(({ cmd, args }) => cmd === 'git' && !args.includes('ls-files'))).toEqual([]);
    expect(afterCodex.some(({ args }) => args.includes('release'))).toBe(false);
  });

  it('tolerates gitlinks that were already in the lane before Codex ran', () => {
    const link = '160000 ' + 'b'.repeat(40) + '\t0\tvendor/sub\0';
    expect(harness({ lsFiles: [link, link] }).run().outcome).toBe('pr-opened');
  });

  it('hands every child process (Codex, verify, open-pr, release) the git pins as GIT_CONFIG_* env', () => {
    const h = harness();
    h.run();
    expect(GIT_HARDENING_ENV).toMatchObject({
      GIT_CONFIG_COUNT: String(GIT_HARDENING.filter((arg) => arg === '-c').length),
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    });
    const pairs = Object.entries(GIT_HARDENING_ENV).filter(([key]) => key.startsWith('GIT_CONFIG_KEY_')).map(([key, name]) => `${name}=${GIT_HARDENING_ENV[key.replace('KEY', 'VALUE')]}`);
    expect(pairs).toEqual(GIT_HARDENING.filter((_, i) => i % 2 === 1));
    for (const marker of ['scripts/codex-direct-task.mjs', 'verify', 'open-pr', 'release']) {
      const call = h.calls.find(({ args }) => args[0] === marker || args.includes(marker));
      expect(call.opts.env).toMatchObject(GIT_HARDENING_ENV);
    }
  });

  it('refuses a planted git hook the same way (it would run inside the unhardened verify/open-pr)', () => {
    const h = harness({ gitStates: [{ 'hooks/pre-push': null }, { 'hooks/pre-push': 'abc' }] });
    const result = h.run();
    expect(result.outcome).toBe('refused:scope-guard');
    expect(result.steps.find((step) => step.name === 'scope-guard').detail).toContain('hooks/pre-push');
    expect(h.calls.some(({ args }) => args.includes('verify') || args.includes('open-pr'))).toBe(false);
  });

  it('re-checks .git after verify (it runs Codex-written tests) and refuses to open the PR if it changed', () => {
    const h = harness({ gitStates: [{ config: 'a' }, { config: 'a' }, { config: 'evil' }] });
    const result = h.run();
    expect(result.outcome).toBe('failed:open-pr');
    expect(result.steps.find((step) => step.name === 'open-pr').detail).toContain('config');
    expect(h.calls.some(({ args }) => args.includes('verify'))).toBe(true);
    expect(h.calls.some(({ args }) => args.includes('--stat') || args.includes('open-pr'))).toBe(false);
    expect(h.calls.some(({ args }) => args.includes('release'))).toBe(false);
  });

  it('feeds the scope guard a rename-free diff against the pre-Codex HEAD, not origin/main', () => {
    const h = harness();
    h.run();
    const revParse = h.calls.findIndex(({ args }) => args.includes('rev-parse'));
    const codexRun = h.calls.findIndex(({ args }) => args[0] === 'scripts/codex-direct-task.mjs');
    expect(revParse).toBeGreaterThan(-1);
    expect(revParse).toBeLessThan(codexRun);
    const diff = h.calls.find(({ args }) => args.includes('--name-only')).args;
    expect(diff).toContain('--no-renames');
    expect(diff.slice(-2)).toEqual([BASE_SHA, 'HEAD']);
    // the published diffstat is derived from the same vetted base, rename-free
    const stat = h.calls.find(({ args }) => args.includes('--stat')).args;
    expect(stat).toContain('--no-renames');
    expect(stat.slice(-2)).toEqual([BASE_SHA, 'HEAD']);
    expect(h.calls.some(({ args }) => args.includes('origin/main...HEAD'))).toBe(false);
    expect(h.calls.find(({ args }) => args.includes('status')).args).toContain('--no-renames');
  });

  it('fails lane-acquire (and still releases) when the pre-Codex HEAD cannot be resolved', () => {
    const h = harness({ fail: (_cmd, args) => args.includes('rev-parse') });
    expect(h.run().outcome).toBe('failed:lane-acquire');
    expect(h.calls.some(({ args }) => args.includes('release'))).toBe(true);
    expect(h.calls.some(({ args }) => args[0] === 'scripts/codex-direct-task.mjs')).toBe(false);
  });

  it('refuses incomplete PR occupancy results (listing reached its limit)', () => {
    const prs = Array.from({ length: OPEN_PR_LIMIT }, (_, i) => ({ number: i + 1, title: 't', files: [{ path: 'elsewhere' }] }));
    const h = harness({ prs });
    const result = h.run();
    expect(result.outcome).toBe('refused:free-scope');
    expect(result.steps[0].detail).toMatch(/limit/i);
    expect(h.calls.find(({ cmd }) => cmd === 'gh').args).toContain(String(OPEN_PR_LIMIT));
    expect(h.calls.some(({ args }) => args.includes('acquire'))).toBe(false);
    expect(harness({ prs: prs.slice(1) }).run().outcome).toBe('pr-opened');
  });

  it('keeps local paths and per-step detail out of the published PR body', () => {
    const body = composePrBody({ ...task, diffStat: '1 file changed', steps: [
      { name: 'lane-acquire', ok: true, ms: 5, detail: '/Users/someone/workspace/.lanes/web-everything/lane-3' },
      { name: 'compose', ok: true, ms: 1, detail: '/Users/someone/workspace/.lanes/web-everything/lane-3/.git/codex-worker-task.md' },
    ] });
    expect(body).not.toMatch(/\/Users\/|\.lanes|codex-worker-task/);
    expect(body).toContain('| lane-acquire | yes | 5 |');
    const h = harness();
    h.run();
    expect(h.writes.find(({ path }) => path.endsWith('pr-body.md')).text).not.toContain('/fake/lane');
  });

  it('fails Codex on nonzero exit but retains the report from stdout', () => {
    const h = harness({ fail: (_cmd, args) => args[0] === 'scripts/codex-direct-task.mjs' });
    const result = h.run();
    expect(result.outcome).toBe('failed:codex');
    expect(result.record.codex.threadId).toBe('failed-thread');
    expect(h.calls.some(({ args }) => args.includes('status'))).toBe(false);
    expect(h.records).toHaveLength(1);
  });

  it('fails Codex if its report contains no changes', () => {
    expect(harness({ reportChanges: false }).run().outcome).toBe('failed:codex');
  });

  it('reads the PR number from open-pr --json output that carries no URL', () => {
    const h = harness({ prOutput: JSON.stringify({ runId: 'open-pr-1', stopped: 'complete', pr: 4016 }, null, 2) });
    const result = h.run();
    expect(result.outcome).toBe('pr-opened');
    expect(result.pr.number).toBe(4016);
  });

  it('fails verify on a red verdict even though the verify process exited 0', () => {
    const h = harness({ verifyOutput: JSON.stringify({ verdict: { ok: false, passed: 0, failed: 1 } }, null, 2) });
    const result = h.run();
    expect(result.outcome).toBe('failed:verify');
    expect(h.calls.some(({ args }) => args.includes('open-pr'))).toBe(false);
    expect(result.steps.slice(-2).map((step) => step.name)).toEqual(['release', 'record']);
  });

  it('stops after failed verify, bounds error detail, and runs cleanup', () => {
    const h = harness({ fail: (_cmd, args) => args.includes('verify') });
    const result = h.run();
    expect(result.outcome).toBe('failed:verify');
    expect(result.steps.find((step) => step.name === 'verify').detail.length).toBeLessThanOrEqual(2000);
    expect(h.calls.some(({ args }) => args.includes('open-pr'))).toBe(false);
    expect(result.steps.slice(-2).map((step) => step.name)).toEqual(['release', 'record']);
  });

  it('records even when release throws', () => {
    const h = harness({ fail: (_cmd, args) => args.includes('release') });
    const result = h.run();
    expect(result.outcome).toBe('failed:release');
    expect(h.records).toHaveLength(1);
    expect(result.pr.number).toBe(42);
  });

  it.each([
    [{ acquire: '{}' }, 'lane-acquire'],
    [{ failWrite: true }, 'compose'],
    [{ codexOutput: 'not JSON' }, 'codex'],
    [{ prOutput: 'no PR URL' }, 'open-pr'],
    [{ failRecord: true }, 'record'],
    [{ fail: (_cmd, args) => args.includes('commit') }, 'commit'],
  ])('contains failure %s and still attempts recording', (options, failedStep) => {
    const h = harness(options);
    const result = h.run();
    expect(result.outcome).toBe(`failed:${failedStep}`);
    expect(result.steps.at(-1).name).toBe('record');
    if (failedStep !== 'lane-acquire') expect(h.calls.some(({ args }) => args.includes('release'))).toBe(true);
  });
});

// Real git (temp repo): the scope guard must see what git really reports, which a fake exec cannot.
describe('scope guard against a real git repo', () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  function fixture(mutate) {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-guard-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
    try {
      git('init', '-q');
      mkdirSync(join(dir, 'outside'));
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'outside/secret.js'), 'export const secret = "line one\\nline two\\nline three\\nline four";\n');
      writeFileSync(join(dir, 'scripts/a.js'), 'a\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD').trim();
      mutate({ dir, git });
      return { base, changed: collectScopeChanges((...args) => git(...args), base) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('refuses committed renames from outside scope, even with an extra allowed working-tree edit', () => {
    const { changed } = fixture(({ dir, git }) => {
      git('mv', 'outside/secret.js', 'scripts/x.js');
      git('commit', '-q', '-m', 'sneaky rename');
      writeFileSync(join(dir, 'scripts/a.js'), 'edited\n');
    });
    const guard = checkAllowedDiff([...new Set([...changed.dirty, ...changed.committed])], ['scripts/']);
    expect(guard.ok).toBe(false);
    expect(guard.outside).toEqual(['outside/secret.js']);
  });

  it('reports committed deletes, committed adds and uncommitted renames/deletes', () => {
    const { changed } = fixture(({ dir, git }) => {
      git('rm', '-q', 'outside/secret.js');
      writeFileSync(join(dir, 'scripts/new.js'), 'n\n');
      git('add', '.');
      git('commit', '-q', '-m', 'delete + add');
      git('mv', 'scripts/a.js', 'scripts/renamed.js');
    });
    expect(changed.committed.sort()).toEqual(['outside/secret.js', 'scripts/new.js']);
    expect(changed.dirty.sort()).toEqual(['scripts/a.js', 'scripts/renamed.js']);
  });

  it('is clean when nothing changed since the base', () => {
    expect(fixture(() => {}).changed).toEqual({ dirty: [], committed: [] });
  });

  it('reports untracked, spaced and unicode paths intact', () => {
    const { changed } = fixture(({ dir }) => {
      writeFileSync(join(dir, 'scripts/new file.js'), 'n\n');
      writeFileSync(join(dir, 'scripts/café.js'), 'n\n');
    });
    expect(changed.dirty.sort()).toEqual(['scripts/café.js', 'scripts/new file.js']);
  });

  // Real git, hostile repo-local config: the pinned flags must actually stop it executing.
  it('GIT_HARDENING stops repo-local hooks and fsmonitor from running (control proves the hostile config bites)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-harden-'));
    try {
      const raw = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
      const hardened = (...args) => raw(...GIT_HARDENING, ...args);
      raw('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      const marker = (name) => join(dir, '.git', name);
      const hostile = (name) => `#!/bin/sh\ntouch "${marker(name)}"\nexit 0\n`;
      mkdirSync(join(dir, '.git/hooks'), { recursive: true });
      writeFileSync(join(dir, '.git/hooks/pre-commit'), hostile('hook-ran'), { mode: 0o755 });
      writeFileSync(join(dir, 'fsmon.sh'), hostile('fsmonitor-ran'), { mode: 0o755 });
      raw('config', 'core.fsmonitor', join(dir, 'fsmon.sh'));
      const ran = (name) => { try { execFileSync('test', ['-e', marker(name)]); return true; } catch { return false; } };

      hardened('status', '--porcelain=v1');
      hardened('--literal-pathspecs', 'add', '--', 'a.txt');
      hardened('commit', '--no-verify', '-q', '-m', 'hardened');
      expect({ hook: ran('hook-ran'), fsmonitor: ran('fsmonitor-ran') }).toEqual({ hook: false, fsmonitor: false });

      writeFileSync(join(dir, 'b.txt'), 'b\n');
      raw('add', 'b.txt');
      raw('commit', '-q', '-m', 'control');
      raw('status', '--porcelain=v1');
      expect({ hook: ran('hook-ran'), fsmonitor: ran('fsmonitor-ran') }).toEqual({ hook: true, fsmonitor: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The review finding: a clean filter driver (config) assigned through .git/info/attributes runs on `git add`.
  // `-c` pins cannot name every driver, so the wrapper detects the tampering instead of trying to out-flag it.
  it('a hostile clean filter beats GIT_HARDENING alone, and the .git snapshot flags it before any git call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-filter-'));
    try {
      const raw = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
      raw('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      const gitDir = join(dir, '.git');
      const before = snapshotGitState(gitDir);
      const marker = join(gitDir, 'filter-ran');
      raw('config', 'filter.x.clean', `touch "${marker}"; cat`);
      writeFileSync(join(gitDir, 'info/attributes'), '* filter=x\n');
      expect(diffGitState(before, snapshotGitState(gitDir)).sort()).toEqual(['config', 'info/attributes']);
      raw(...GIT_HARDENING, '--literal-pathspecs', 'add', '--', 'a.txt');
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the GIT_CONFIG_* env pins stop a hostile repo-local hook and fsmonitor in a RAW git call (as the shared tools make)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-env-'));
    try {
      const raw = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
      const pinned = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...gitEnv, ...GIT_HARDENING_ENV } });
      raw('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      const marker = (name) => join(dir, '.git', name);
      const hostile = (name) => `#!/bin/sh\ntouch "${marker(name)}"\nexit 0\n`;
      mkdirSync(join(dir, '.git/hooks'), { recursive: true });
      writeFileSync(join(dir, '.git/hooks/pre-commit'), hostile('hook-ran'), { mode: 0o755 });
      writeFileSync(join(dir, 'fsmon.sh'), hostile('fsmonitor-ran'), { mode: 0o755 });
      raw('config', 'core.fsmonitor', join(dir, 'fsmon.sh'));
      pinned('status', '--porcelain=v1');
      pinned('add', 'a.txt');
      pinned('commit', '-q', '-m', 'pinned by env only (no -c, no --no-verify)');
      expect({ hook: existsSync(marker('hook-ran')), fsmonitor: existsSync(marker('fsmonitor-ran')) }).toEqual({ hook: false, fsmonitor: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseGitlinks finds a gitlink Codex planted with update-index, and nothing in an ordinary repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-gitlink-'));
    try {
      const raw = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
      raw('init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      raw('add', 'a.txt');
      raw('commit', '-q', '-m', 'base');
      expect(parseGitlinks(raw('ls-files', '--stage', '-z'))).toEqual([]);
      raw('update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},sub dir`);
      expect(parseGitlinks(raw('ls-files', '--stage', '-z'))).toEqual(['sub dir']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshotGitState flags changed, added, deleted and re-linked hooks, ignores untouched state, and tolerates a missing .git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-worker-snap-'));
    try {
      const gitDir = join(dir, '.git');
      mkdirSync(join(gitDir, 'hooks/nested'), { recursive: true });
      writeFileSync(join(gitDir, 'config'), '[core]\n');
      writeFileSync(join(gitDir, 'hooks/pre-commit'), 'one\n');
      writeFileSync(join(gitDir, 'hooks/nested/deep'), 'x\n');
      symlinkSync('/bin/true', join(gitDir, 'hooks/link'));
      const before = snapshotGitState(gitDir);
      expect(diffGitState(before, snapshotGitState(gitDir))).toEqual([]);
      writeFileSync(join(gitDir, 'hooks/pre-commit'), 'two\n');
      writeFileSync(join(gitDir, 'hooks/pre-push'), 'new\n');
      writeFileSync(join(gitDir, 'hooks/nested/deep'), 'y\n');
      rmSync(join(gitDir, 'hooks/link'));
      symlinkSync('/bin/false', join(gitDir, 'hooks/link'));
      writeFileSync(join(gitDir, 'config.worktree'), '[core]\n');
      // commondir/gitdir redirect where git reads config, attributes and hooks from; alternates/grafts/shallow redirect objects
      mkdirSync(join(gitDir, 'objects/info'), { recursive: true });
      for (const redirect of ['commondir', 'gitdir', 'objects/info/alternates', 'info/grafts', 'shallow']) {
        if (redirect === 'info/grafts') mkdirSync(join(gitDir, 'info'), { recursive: true });
        writeFileSync(join(gitDir, redirect), '/elsewhere\n');
      }
      expect(diffGitState(before, snapshotGitState(gitDir)).sort())
        .toEqual(['commondir', 'config.worktree', 'gitdir', 'hooks/link', 'hooks/nested/deep', 'hooks/pre-commit', 'hooks/pre-push', 'info/grafts', 'objects/info/alternates', 'shallow']);
      rmSync(join(gitDir, 'hooks/pre-commit'));
      expect(diffGitState(before, snapshotGitState(gitDir))).toContain('hooks/pre-commit');
      expect(snapshotGitState(join(dir, 'nope'))).toEqual(expect.any(Object));
      expect(diffGitState(snapshotGitState(join(dir, 'nope')), snapshotGitState(join(dir, 'nope')))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI planning', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../codex-worker.mjs');
  const brief = fileURLToPath(import.meta.url);

  it('dry-runs a brief from another cwd with no subprocesses or writes', () => {
    const output = execFileSync(process.execPath, [script, `--brief-file=${brief}`, '--files=scripts/', '--title=Brief task', '--dry-run', '--json'], {
      cwd: '/', encoding: 'utf8', env: { ...process.env, PATH: '/no-executables' },
    });
    const plan = JSON.parse(output);
    expect(plan.branch).toBe('lane/codex-brief-brief-task');
    expect(plan.allowed).toEqual(['scripts/']);
    expect(plan.task).toContain('## Problem');
    expect(plan.freeScope.checked).toBe(false);
  });

  it('requires files and title for a brief', () => {
    for (const flags of [[], ['--files=scripts/']]) {
      expect(() => execFileSync(process.execPath, [script, `--brief-file=${brief}`, '--dry-run', ...flags], {
        encoding: 'utf8', stdio: 'pipe',
      })).toThrow();
    }
  });
});
