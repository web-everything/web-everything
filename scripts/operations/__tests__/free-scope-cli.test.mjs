/**
 * @file scripts/operations/__tests__/free-scope-cli.test.mjs
 * @description A stacked PR's base chain (live 2026-10-09: #4643 and #4658, both holding the builder files a PR
 * stacked on them edits) must be excludable together. `--exclude-pr` is repeatable and takes a comma list, for
 * `check` and `register` alike. The snapshot reader is injected; the registry is a private temp file.
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../free-scope-cli.mjs';
import { readRegistry } from '../free-scope-io.mjs';

let root, env;
const now = () => Date.parse('2026-10-09T19:00:00Z');
// Every PR touches the same WE file; the plateau-app one names it repo-qualified (a cross-repo scope).
const pr = (number, repo = 'web-everything/web-everything') => ({ number, repo, title: `PR ${number}`, url: 'u', files: ['we:held.mjs'] });
const collect = ({ files }) => ({ files: String(files).split(','), nowMs: now(), unreadable: [], agents: [],
  prs: [pr(4643), pr(4658), pr(4658, 'plateauapp/plateau-app')] });
const run = (argv) => {
  let out = '', err = '';
  const code = main(argv, { env, now, collect, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-scope-cli-'));
  env = { WE_AGENT_SCOPES_PATH: path.join(root, 'agents.json') };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('one --exclude-pr leaves the rest of a base chain holding the file', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('PR #4658');
});

it('repeated --exclude-pr excludes every named PR on check', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643', '--exclude-pr=4658', '--exclude-pr=plateau-app#4658']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(r.out).toContain('all 1 files free');
});

it('a comma list works the same, and a repo-qualified number only excludes that repo', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643,4658', '--json']);
  expect(r.code).toBe(1);
  const v = JSON.parse(r.out);
  expect(v.files[0].holders.map((h) => `${h.repo}#${h.number}`)).toEqual(['plateauapp/plateau-app#4658']);
});

it('register accepts the same exclusions and records the scope', () => {
  const r = run(['register', '--agent=stacked', '--owner=o1', '--purpose=p', '--files=held.mjs',
    '--exclude-pr=4643', '--exclude-pr=4658,plateau-app#4658']);
  expect(r.code).toBe(0);
  const entries = JSON.parse(fs.readFileSync(env.WE_AGENT_SCOPES_PATH, 'utf8'));
  expect((entries.entries ?? entries).map((e) => e.agent)).toContain('stacked');
});

it('a malformed entry in the list is refused', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643,nope']);
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/--exclude-pr must be/);
});

// Live 2026-10-31 18:36 ET: dead subagents' scopes blocked the restarted worker until a manual release.
describe('heartbeat (live 2026-10-31 dead-owner reap)', () => {
  let clock;
  const t0 = Date.parse('2026-10-31T22:00:00Z');
  const regCollect = ({ files }) => ({ files: String(files).split(','), nowMs: clock, unreadable: [], prs: [],
    agents: readRegistry(env.WE_AGENT_SCOPES_PATH) });
  const go = (argv, extraEnv = {}) => {
    let out = '', err = '';
    const code = main(argv, { env: { ...env, ...extraEnv }, now: () => clock, collect: regCollect,
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    return { code, out, err };
  };
  const entry = (agent) => readRegistry(env.WE_AGENT_SCOPES_PATH).find((e) => e.agent === agent);
  beforeEach(() => { clock = t0; });
  it('register --heartbeat stamps the cascade window (env layer) on the entry', () => {
    expect(go(['register', '--agent=a', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat'], { WE_FREE_SCOPE_STALE_AFTER_MINUTES: '10' }).code).toBe(0);
    expect(entry('a')).toMatchObject({ staleAfterMinutes: 10, lastSeenAt: new Date(t0).toISOString() });
    expect(go(['register', '--agent=d', '--owner=D', '--purpose=p', '--files=y.mjs', '--heartbeat']).code).toBe(0);
    expect(entry('d').staleAfterMinutes).toBe(45);
    expect(go(['register', '--agent=b', '--owner=B', '--purpose=p', '--files=z.mjs', '--heartbeat'], { WE_FREE_SCOPE_STALE_AFTER_MINUTES: '0' }).code).toBe(2);
  });
  it('a dead heartbeat owner stops blocking another owner; a plain entry still blocks for its TTL', () => {
    go(['register', '--agent=dead', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat']);
    go(['register', '--agent=plain', '--owner=P', '--purpose=p', '--files=y.mjs']);
    clock = t0 + 46 * 60e3;
    const r = go(['register', '--agent=next', '--owner=B', '--purpose=p', '--files=x.mjs']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stale \(ignored\):[\s\S]*dead/);
    expect(go(['register', '--agent=next2', '--owner=C', '--purpose=p', '--files=y.mjs']).code).toBe(1);
  });
  it('a check naming its own agent and owner heartbeats it, so a live worker keeps its files', () => {
    go(['register', '--agent=live', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat']);
    clock = t0 + 40 * 60e3;
    expect(go(['check', '--files=x.mjs', '--exclude-agent=live', '--exclude-owner=A']).code).toBe(0);
    expect(entry('live').lastSeenAt).toBe(new Date(clock).toISOString());
    clock = t0 + 80 * 60e3;
    expect(go(['register', '--agent=intruder', '--owner=B', '--purpose=p', '--files=x.mjs']).code).toBe(1);
  });
  it('heartbeats before the slow collection, and registers with the clock read after it (Codex audit)', () => {
    go(['register', '--agent=live', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat']);
    clock = t0 + 44 * 60e3;
    let seenDuringCollect;
    const slow = (args) => { seenDuringCollect = entry('live').lastSeenAt; clock += 2 * 60e3; return regCollect(args); };
    main(['check', '--files=x.mjs', '--exclude-agent=live', '--exclude-owner=A'], { env, now: () => clock, collect: slow,
      stdout: { write: () => {} }, stderr: { write: () => {} } });
    expect(seenDuringCollect).toBe(new Date(t0 + 44 * 60e3).toISOString());
    main(['register', '--agent=r', '--owner=R', '--purpose=p', '--files=y.mjs', '--heartbeat'], { env, now: () => clock, collect: slow,
      stdout: { write: () => {} }, stderr: { write: () => {} } });
    expect(entry('r').lastSeenAt).toBe(new Date(clock).toISOString());
  });
  it('a same-owner re-register heartbeats before collection, so a takeover during it is refused (Codex audit)', () => {
    go(['register', '--agent=w', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat']);
    clock = t0 + 44 * 60e3;
    let takeover;
    const slow = (args) => { clock += 2 * 60e3; takeover = go(['register', '--agent=w', '--owner=B', '--purpose=p', '--files=x.mjs']); return regCollect(args); };
    const code = main(['register', '--agent=w', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat'], { env, now: () => clock, collect: slow,
      stdout: { write: () => {} }, stderr: { write: () => {} } });
    expect(takeover.code).toBe(2);
    expect(takeover.err).toMatch(/different owner/);
    expect(code).toBe(0);
    expect(entry('w')).toMatchObject({ owner: 'A', lastSeenAt: new Date(clock).toISOString() });
  });
  it('a heartbeat that finds no entry of its own says the reservation is gone', () => {
    const r = go(['check', '--files=x.mjs', '--exclude-agent=ghost', '--exclude-owner=G']);
    expect(r.err).toMatch(/reservation is gone/);
  });
  it('a check without the owner token never heartbeats anyone', () => {
    go(['register', '--agent=live', '--owner=A', '--purpose=p', '--files=x.mjs', '--heartbeat']);
    clock = t0 + 40 * 60e3;
    go(['check', '--files=x.mjs', '--exclude-agent=live']);
    expect(entry('live').lastSeenAt).toBe(new Date(t0).toISOString());
  });
});
