import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as watcher from '../actions-policy-watch.mjs';
import { evaluatePolicy, evaluateChangelog, runWatch, parseFeed, fetchFeedText, ghReadArgs } from '../actions-policy-watch.mjs';

const cfg = {
  policyId: 17152,
  event: 'pull_request_target',
  expectedWorkflowPath: '.github/workflows/merge-gate.yml',
  keywords: ['allow-policy', 'allow policy'],
};
const policy = (workflows) => ({ id: 17152, rules: [{ event: 'pull_request_target', workflows }] });

// Synthetic offline fixtures mirroring the RSS content:encoded and Atom content fields.
const bodyFeeds = [
  '<rss><channel><item><guid>body-rss</guid><title>Actions update</title><description>short</description><content:encoded><![CDATA[<p>The allow-policy will sunset.</p>]]></content:encoded></item></channel></rss>',
  '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>body-atom</id><title>Actions update</title><summary>short</summary><content type="html">The allow policy will sunset.</content></entry></feed>',
];

describe('actions-policy-watch production regressions', () => {
  it.each([false, 1, 'policy', [], {}, { id: 17152, rules: {} }, policy(null), policy('x.yml')])(
    'fails closed for malformed policy evidence %j', (value) => {
      expect(evaluatePolicy(value, cfg).status).toBe('unknown');
    },
  );
  it.each(bodyFeeds)('matches a keyword appearing only in the full feed body', (xml) => {
    expect(evaluateChangelog(parseFeed(xml), cfg, new Set())).toHaveLength(1);
  });
  it('deduplicates matching IDs within one feed without mutating the caller set', () => {
    const seen = new Set();
    const item = { id: 'duplicate', title: 'allow-policy sunset' };
    expect(evaluateChangelog([item, item], cfg, seen)).toEqual([item]);
    expect(seen.size).toBe(0);
  });
  it('rejects matching entries without stable IDs instead of silently acknowledging them', async () => {
    const r = await runWatch({ cfg, org: 'o', ghApi: async () => JSON.stringify(policy([cfg.expectedWorkflowPath])),
      fetchFeed: async () => [{ title: 'allow-policy sunset' }] });
    expect(r.feed.status).toBe('unknown');
    expect(r.alerts[0]).toMatch(/no stable id/);
  });
  it('emits a policy alert before a pending feed settles', async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const emitted = [];
    const running = runWatch({ cfg, org: 'o', ghApi: async () => JSON.stringify(policy(['x.yml'])),
      fetchFeed: () => pending, onAlert: (alert) => emitted.push(alert) });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatch(/policy.*drift/);
    } finally { settle([]); await running; }
  });
  it('aborts a pending feed after 15 seconds, including a pending response body', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const outcome = expect(fetchFeedText('u', fetchImpl)).rejects.toThrow(/abort|timed out/);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
      const bodyOutcome = expect(fetchFeedText('u', async () => ({ ok: true, text: () => new Promise(() => {}) })))
        .rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15_000);
      await bodyOutcome;
    } finally { vi.useRealTimers(); }
  });
  it('loads the shipped config and rejects absent or malformed required settings', () => {
    const shipped = watcher.loadConfig();
    expect(shipped.keywords).toContain('pull_request_target');
    const dir = mkdtempSync(join(tmpdir(), 'policy-config-'));
    try {
      const file = join(dir, 'config.json');
      Object.keys(shipped).forEach((key) => {
        const invalid = { ...shipped };
        delete invalid[key];
        writeFileSync(file, JSON.stringify({ actionsPolicyWatch: invalid }));
        expect(() => watcher.loadConfig(file), key).toThrow();
      });
      [[], [''], [5], 'allow-policy'].forEach((keywords) => {
        writeFileSync(file, JSON.stringify({ actionsPolicyWatch: { ...shipped, keywords } }));
        expect(() => watcher.loadConfig(file)).toThrow();
      });
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('runs main twice with real saved state, exact read-only gh argv and meaningful exit codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-main-'));
    const state = join(dir, 'state.json');
    const exec = vi.fn(() => JSON.stringify(policy(['.github/workflows/merge-gate.yml'])));
    const output = [];
    const options = { argv: ['--once', '--json', '--org=o', `--state=${state}`], exec,
      fetchImpl: async () => ({ ok: true, text: async () => bodyFeeds[0] }),
      stdout: { write: (s) => output.push(s) }, stderr: { write: vi.fn() }, env: {} };
    try {
      expect(await watcher.main(options)).toBe(1);
      expect(JSON.parse(output.pop()).changelog).toHaveLength(1);
      expect(JSON.parse(readFileSync(state, 'utf8')).seen).toEqual(['body-rss']);
      expect(await watcher.main(options)).toBe(0);
      expect(JSON.parse(output.pop()).changelog).toEqual([]);
      expect(exec.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ['gh', ['api', 'orgs/o/actions/policies/17152']], ['gh', ['api', 'orgs/o/actions/policies/17152']],
      ]);
      exec.mockReturnValue(JSON.stringify(policy(['x.yml'])));
      expect(await watcher.main(options)).toBe(1);
      expect(JSON.parse(output.pop()).alerts.join(' ')).toMatch(/drift/);
      exec.mockImplementation(() => { throw new Error('403'); });
      expect(await watcher.main(options)).toBe(1);
      expect(JSON.parse(output.pop()).policy.status).toBe('unknown');
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('reports corrupt state and a competing writer without claiming a clean scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-state-'));
    const state = join(dir, 'state.json');
    const stderr = { write: vi.fn() };
    const options = { argv: ['--org=o', `--state=${state}`], env: {}, stderr, stdout: { write: vi.fn() },
      exec: vi.fn(), fetchImpl: vi.fn() };
    try {
      writeFileSync(state, '{broken');
      expect(await watcher.main(options)).toBe(1);
      expect(stderr.write).toHaveBeenLastCalledWith(expect.stringMatching(/needs-you:.*state/));
      expect(readFileSync(state, 'utf8')).toBe('{broken');
      mkdirSync(`${state}.lock`);
      expect(await watcher.main(options)).toBe(1);
      expect(stderr.write).toHaveBeenLastCalledWith(expect.stringMatching(/needs-you:.*state/));
      expect(options.exec).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true }); }
  });
  it.each([null, { scope: 'wrong', seen: [] }, { scope: 'o/17152/https://github.blog/changelog/label/actions/feed/', seen: [null] }])(
    'refuses malformed or differently scoped persisted state %j', async (saved) => {
      const dir = mkdtempSync(join(tmpdir(), 'policy-invalid-state-'));
      const state = join(dir, 'state.json');
      const stderr = { write: vi.fn() };
      try {
        writeFileSync(state, JSON.stringify(saved));
        expect(await watcher.main({ argv: ['--org=o', `--state=${state}`], stderr })).toBe(1);
        expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/state has an invalid/));
        expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual(saved);
        expect(existsSync(`${state}.lock`)).toBe(false);
      } finally { rmSync(dir, { recursive: true }); }
    },
  );
  it('delivers CLI policy alerts during a pending feed and excludes a concurrent writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-concurrent-'));
    const state = join(dir, 'state.json');
    let release;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const options = { argv: ['--org=o', `--state=${state}`], stdout, stderr,
      exec: vi.fn(() => JSON.stringify(policy(['x.yml']))),
      fetchImpl: () => { started(); return pending; } };
    const first = watcher.main(options);
    try {
      await ready;
      expect(stdout.write).toHaveBeenCalledWith(expect.stringMatching(/policy.*drift/));
      expect(await watcher.main(options)).toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/state is locked/));
      expect(options.exec).toHaveBeenCalledTimes(1);
    } finally {
      release({ ok: true, text: async () => '<rss><channel/></rss>' });
      await first;
      rmSync(dir, { recursive: true });
    }
  });
  it('reports a failed state replacement, releases its lock and retries without suppressing an unsaved alert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-write-state-'));
    const state = join(dir, 'state.json');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const options = { argv: ['--org=o', `--state=${state}`], stdout, stderr,
      exec: () => JSON.stringify(policy([cfg.expectedWorkflowPath])),
      fetchImpl: async () => {
        mkdirSync(state); // Make the atomic rename fail after the initial state read.
        return { ok: true, text: async () => bodyFeeds[0] };
      } };
    try {
      expect(await watcher.main(options)).toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/state could not be saved/));
      expect(existsSync(`${state}.lock`)).toBe(false);
      rmdirSync(state);
      expect(await watcher.main({ ...options, fetchImpl: async () => ({ ok: true, text: async () => bodyFeeds[0] }) })).toBe(1);
      expect(stdout.write.mock.calls.filter(([s]) => s.includes('mentions the allow-policy'))).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('uses the exact read-only owner discovery call and env organization fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-owner-'));
    const exec = vi.fn((_command, args) => args[0] === 'repo'
      ? JSON.stringify({ owner: { login: 'o' } }) : JSON.stringify(policy([cfg.expectedWorkflowPath])));
    const options = { argv: [`--state=${join(dir, 'state.json')}`], exec, env: {},
      fetchImpl: async () => ({ ok: true, text: async () => '<rss><channel/></rss>' }),
      stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    try {
      expect(await watcher.main(options)).toBe(0);
      expect(exec.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ['gh', ['repo', 'view', '--json', 'owner']], ['gh', ['api', 'orgs/o/actions/policies/17152']],
      ]);
      exec.mockClear();
      expect(await watcher.main({ ...options, env: { GH_ORG: 'o' } })).toBe(0);
      expect(exec.mock.calls.map(([, args]) => args)).toEqual([['api', 'orgs/o/actions/policies/17152']]);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('the executable entrypoint preserves a nonzero main exit code without invoking gh', () => {
    const child = spawnSync(process.execPath,
      [fileURLToPath(new URL('../actions-policy-watch.mjs', import.meta.url)), '--org=../invalid'],
      { encoding: 'utf8', timeout: 5_000 });
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/needs-you:.*invalid organization/);
  });
});

describe('actions-policy-watch', () => {
  it('is ok when the policy allows only merge-gate.yml', () => {
    expect(evaluatePolicy(policy(['.github/workflows/merge-gate.yml']), cfg).status).toBe('ok');
  });
  it('alerts when policy 17152 allows pull_request_target for a second workflow', () => {
    const r = evaluatePolicy(policy(['.github/workflows/merge-gate.yml', '.github/workflows/other.yml']), cfg);
    expect(r.status).toBe('drift');
    expect(r.reason).toMatch(/other\.yml/);
  });
  it('alerts when the workflow is renamed', () => {
    expect(evaluatePolicy(policy(['.github/workflows/gate.yml']), cfg).status).toBe('drift');
  });
  it('alerts when the policy is missing', () => {
    expect(evaluatePolicy(null, cfg).status).toBe('missing');
    expect(evaluatePolicy({ id: 17152, rules: [] }, cfg).status).toBe('missing');
  });
  it('an API error raises unknown, not ok', async () => {
    const r = await runWatch({ cfg, org: 'o', ghApi: async () => { throw new Error('403'); }, fetchFeed: async () => [] });
    expect(r.policy.status).toBe('unknown');
    expect(r.alerts.length).toBe(1);
  });
  it('a 403 or 404 from the API raises unknown, not ok or missing', async () => {
    for (const msg of ['gh: Not Found (HTTP 404)', 'gh: Forbidden (HTTP 403)']) {
      const r = await runWatch({ cfg, org: 'o', ghApi: async () => { throw new Error(msg); }, fetchFeed: async () => [] });
      expect(r.policy.status).toBe('unknown');
      expect(r.alerts.length).toBe(1);
    }
  });
  it('a changelog item naming the allow-policy sunset raises one alert', async () => {
    const items = [
      { id: 'a', title: 'Sunset of the Actions allow-policy', summary: '' },
      { id: 'b', title: 'Unrelated', summary: 'nothing' },
    ];
    expect(evaluateChangelog(items, cfg, new Set()).map((i) => i.id)).toEqual(['a']);
    expect(evaluateChangelog(items, cfg, new Set(['a']))).toEqual([]);
    const r = await runWatch({
      cfg, org: 'o', ghApi: async () => JSON.stringify(policy(['.github/workflows/merge-gate.yml'])),
      fetchFeed: async () => items,
    });
    expect(r.alerts.length).toBe(1);
  });
  it('a policy with a wrong or absent id is unknown, not ok', () => {
    expect(evaluatePolicy({ id: 1, rules: [{ event: 'pull_request_target', workflows: ['.github/workflows/merge-gate.yml'] }] }, cfg).status).toBe('unknown');
    expect(evaluatePolicy({ rules: [{ event: 'pull_request_target', workflows: ['.github/workflows/merge-gate.yml'] }] }, cfg).status).toBe('unknown');
  });
  it('parses Atom entries with attributes and rejects non-feed responses', async () => {
    const atom = '<feed xmlns="x"><entry xml:lang="en"><id>z1</id><title xml:lang="en">Allow-policy sunset</title></entry></feed>';
    expect(parseFeed(atom)).toEqual([{ id: 'z1', title: 'Allow-policy sunset', summary: '' }]);
    expect(() => parseFeed('<html>503</html>')).toThrow();
    const res = (ok, status, body) => async () => ({ ok, status, text: async () => body });
    await expect(fetchFeedText('u', res(false, 503, '<html/>'))).rejects.toThrow(/503/);
    expect((await fetchFeedText('u', res(true, 200, atom))).length).toBe(1);
  });
  it('a failed feed raises a feed alert and never hides the policy alert', async () => {
    const r = await runWatch({
      cfg, org: 'o', ghApi: async () => JSON.stringify(policy(['.github/workflows/merge-gate.yml', 'x.yml'])),
      fetchFeed: async () => { throw new Error('feed HTTP 503'); },
    });
    expect(r.alerts.length).toBe(2);
    expect(r.feed.status).toBe('unknown');
  });
  it('the production gh invocation is a plain GET', () => {
    expect(ghReadArgs('orgs/o/actions/policies/17152')).toEqual(['api', 'orgs/o/actions/policies/17152']);
  });
  it('is read-only: only GET-style endpoint reads reach the client', async () => {
    const calls = [];
    await runWatch({
      cfg, org: 'o', ghApi: async (...args) => { calls.push(args); return JSON.stringify(policy(['.github/workflows/merge-gate.yml'])); },
      fetchFeed: async () => [],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(1);
    expect(calls[0][0]).toBe('orgs/o/actions/policies/17152');
  });
});
