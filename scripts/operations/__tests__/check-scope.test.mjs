import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScope } from '../check-scope.mjs';
import { assessFreeScope, registerScope } from '../free-scope.mjs';
import { collectFreeScope, readRegistry, OPEN_PR_LIMIT } from '../free-scope-io.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning, runStatus } from '../engine.mjs';
import { isReadOnlyDeclaration } from '../http-adapter.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { spawnSync } from 'node:child_process';
import { OPERATIONS } from '../run.mjs';

// Wrap (never replace) the real reader so most tests exercise it; the run.mjs test below stubs single calls.
const hoisted = vi.hoisted(() => ({ real: undefined }));
const actualCollect = (...args) => hoisted.real(...args);
vi.mock('../free-scope-io.mjs', async importOriginal => {
  const actual = await importOriginal();
  hoisted.real = actual.collectFreeScope;
  return { ...actual, collectFreeScope: vi.fn((...args) => actual.collectFreeScope(...args)) };
});

const WE = 'web-everything/web-everything';
const FUI = 'frontier-ui/frontierui';
const now = Date.parse('2026-11-18T12:00:00Z');
const agent = { agent: 'lane-3', owner: 'holder', lane: 3, item: '1055', purpose: 'test',
  files: ['we:scripts/a.mjs'], startedAt: new Date(now).toISOString(), ttlHours: 4 };
const snapshot = overrides => ({ prs: [], agents: [], unreadable: [], repos: [WE], ...overrides });
const run = (overrides, options = {}) => checkScope({ declaredFiles: ['scripts/a.mjs'], now,
  collect: () => snapshot(overrides), ...options });
const withRegistry = (entries, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-scope-'));
  const registryPath = join(dir, 'registry.json');
  try { if (entries) writeFileSync(registryPath, JSON.stringify({ entries })); return fn(registryPath); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const realCollect = (registryPath, exec) => options => collectFreeScope({ ...options, registryPath, exec, gitDirFor: () => null });

describe('checkScope shared admission', () => {
  it('reports PR overlap with repo and number', () => {
    expect(run({ prs: [{ repo: WE, number: 7, files: ['scripts/a.mjs'] }] }))
      .toMatchObject({ ok: false, overlaps: [{ file: 'we:scripts/a.mjs', pr: { number: 7, repo: WE } }] });
  });
  it('reports registry agent overlap, lane and item', () => {
    expect(run({ agents: [agent] })).toMatchObject({ ok: false,
      overlaps: [{ file: 'we:scripts/a.mjs', agent: 'lane-3', lane: 3, item: '1055' }] });
  });
  it('allows disjoint scope and ignores expired agents', () => {
    expect(run({ agents: [{ ...agent, files: ['we:scripts/b.mjs'] }] }).ok).toBe(true);
    expect(run({ agents: [{ ...agent, startedAt: '2000-01-01' }] }).ok).toBe(true);
  });
  it('qualifies scopes and preserves subtree matching from the shared assessor', () => {
    expect(run({ agents: [{ ...agent, files: ['we:scripts/'] }] }).ok).toBe(false);
  });
  it('normalizes dotted paths and refuses repo-escaping ones', () => {
    expect(run({ agents: [agent] }, { declaredFiles: ['we:scripts/../scripts/a.mjs'] }).ok).toBe(false);
    expect(run({}, { declaredFiles: ['we:../outside.mjs'] })).toMatchObject({ ok: false, reason: expect.stringContaining('escapes') });
  });
  it('normalizes dotted paths in stored registry claims too', () => {
    expect(run({ agents: [{ ...agent, files: ['we:src/../scripts/a.mjs'] }] }).ok).toBe(false);
  });
  it('excludes only the named owner when supplied', () => {
    expect(run({ agents: [agent] }, { excludeAgent: agent.agent, excludeOwner: 'holder' }).ok).toBe(true);
    expect(run({ agents: [agent] }, { excludeAgent: agent.agent, excludeOwner: 'other' }).ok).toBe(false);
  });
  it('refuses excludeAgent without a non-empty excludeOwner (the inherited exclusion is name-only)', () => {
    for (const excludeOwner of [undefined, null, '', '  ', 7]) {
      const collect = vi.fn(() => snapshot({ agents: [agent] }));
      expect(checkScope({ declaredFiles: ['scripts/a.mjs'], excludeAgent: agent.agent, excludeOwner, collect, now }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('excludeOwner') });
      expect(collect).not.toHaveBeenCalled();
    }
    expect(run({ agents: [{ ...agent, owner: 'someone-else' }] }, { excludeAgent: agent.agent, excludeOwner: 'holder' }).ok).toBe(false);
  });
  it('keeps repository-root claims and scopes overlapping everything beneath them', () => {
    expect(run({ agents: [{ ...agent, files: ['we:'] }] }).ok).toBe(false);
    expect(run({ agents: [{ ...agent, files: ['we:./'] }] }).ok).toBe(false);
    expect(run({ agents: [{ ...agent, files: ['we:scripts/..'] }] }).ok).toBe(false);
    expect(run({ agents: [agent] }, { declaredFiles: ['we:'] }).ok).toBe(false);
  });
  it.each(['we:', 'we:.', 'we:./', 'we:scripts/..', 'we:scripts/../', 'web-everything:'])
  ('reports a registered repository-root claim %s as an overlap', root => {
    const agents = registerScope([], { agent: 'root-holder', files: [root] }, new Date(now).toISOString());
    expect(run({ agents })).toMatchObject({ ok: false,
      overlaps: [{ file: 'we:scripts/a.mjs', agent: 'root-holder' }] });
    expect(run({ agents }, { declaredFiles: ['plateau-app:scripts/a.mjs'], collect: () => snapshot({ agents, repos: ['plateauapp/plateau-app'] }) }))
      .toEqual({ ok: true, overlaps: [] });
  });
  it('agrees with the existing assessor for a root claim written by registerScope', () => {
    const agents = registerScope([], { agent: 'root-holder', files: ['we:'] }, new Date(now).toISOString());
    expect(agents[0].files).toEqual(['we:']);
    expect(assessFreeScope({ files: ['scripts/a.mjs'], agents, nowMs: now }).status).toBe('occupied');
    expect(run({ agents })).toEqual({ ok: false,
      overlaps: [{ file: 'we:scripts/a.mjs', agent: 'root-holder' }], reason: expect.stringContaining('held by agent root-holder') });
  });
  it.each(['we:', 'we:.', 'we:./', 'we:scripts/..', 'web-everything:'])
  ('reports a declared repository-root scope %s overlapping a registered descendant', root => {
    const agents = registerScope([], { agent: 'file-holder', files: ['scripts/a.mjs'] }, new Date(now).toISOString());
    expect(run({ agents }, { declaredFiles: [root] })).toEqual({ ok: false,
      overlaps: [{ file: 'we:', agent: 'file-holder' }], reason: expect.stringContaining('held by agent file-holder') });
  });
  it('fails closed on unreadable repositories even when an overlap is known', () => {
    for (const agents of [[], [agent]]) {
      expect(run({ agents, unreadable: [{ repo: 'we', error: 'unavailable' }] })).toMatchObject({ ok: false,
        unreadable: [{ repo: 'we' }], reason: expect.stringContaining('could not read') });
    }
    expect(run({ status: 'unknown' }).ok).toBe(false);
  });
  it('fails closed on thrown reads and incomplete snapshots without throwing', () => {
    expect(run({}, { collect: () => { throw new Error('permission denied'); } })).toMatchObject({ ok: false, reason: expect.stringContaining('permission denied') });
    expect(run({}, { collect: () => ({ prs: [] }) }).ok).toBe(false);
    expect(run({}, { collect: () => null }).ok).toBe(false);
    expect(checkScope().ok).toBe(false);
    expect(run({}, { now: () => NaN }).ok).toBe(false);
  });
  it('fails closed when the shared reader hits its open-PR bound', () => {
    const rows = Array.from({ length: OPEN_PR_LIMIT }, (_, i) => ({ number: i + 1, files: [] }));
    withRegistry([], registryPath => {
      expect(run({}, { collect: realCollect(registryPath, () => JSON.stringify(rows)) }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('could not read') });
    });
  });
  it('fails closed on corrupt registry JSON and invalid persisted entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-scope-'));
    const registryPath = join(dir, 'registry.json');
    try {
      writeFileSync(registryPath, '{broken');
      const collect = options => collectFreeScope({ ...options, registryPath, exec: () => '[]', gitDirFor: () => null });
      expect(run({}, { collect })).toMatchObject({ ok: false, reason: expect.stringContaining('cannot read registry') });
      for (const bad of [null, {}, { ...agent, startedAt: 'invalid' }, { ...agent, files: 'oops' }]) {
        writeFileSync(registryPath, JSON.stringify({ entries: [bad] }));
        expect(run({}, { collect: () => snapshot({ agents: readRegistry(registryPath) }) })).toMatchObject({ ok: false,
          reason: expect.stringContaining('corrupt scope registry') });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkScope refuses empty and unqualified-root scopes (fail closed, no evidence read)', () => {
  it.each([[[]], [''], ['  '], [['']], [[' ']], [['./']], ['./'], [','], ['scripts/a.mjs,'], [['we:scripts/a.mjs', '']], [[7]], [null], [undefined]])
  ('%j', declaredFiles => {
    const collect = vi.fn(() => snapshot());
    expect(checkScope({ declaredFiles, collect, now })).toMatchObject({ ok: false, overlaps: [], reason: expect.stringContaining('scope check failed') });
    expect(collect).not.toHaveBeenCalled();
  });
  it('still reads evidence for an explicit repository root', () => {
    const collect = vi.fn(() => snapshot());
    expect(checkScope({ declaredFiles: ['we:./'], collect, now }).ok).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
  });
});

describe('checkScope never exempts prose scopes', () => {
  it.each(['docs/a.md', 'we:docs/a/b.md', 'backlog/card.md'])('collects evidence for %s and reports a held file', file => {
    const collect = vi.fn(() => snapshot({ agents: [{ ...agent, files: [`we:${file.replace(/^we:/, '')}`] }] }));
    expect(checkScope({ declaredFiles: [file], collect, now })).toMatchObject({ ok: false, overlaps: [{ agent: 'lane-3' }] });
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it('reports an open PR editing an existing prose file', () => {
    expect(run({ prs: [{ repo: WE, number: 9, files: ['docs/a.md'] }] }, { declaredFiles: ['docs/a.md'] }))
      .toMatchObject({ ok: false, overlaps: [{ file: 'we:docs/a.md', pr: { number: 9 } }] });
  });
  it('fails closed on unavailable evidence for a prose scope', () => {
    expect(run({ unreadable: [{ repo: WE, error: 'down' }] }, { declaredFiles: ['docs/a.md'] })).toMatchObject({ ok: false, reason: expect.stringContaining('could not read') });
    expect(run({}, { declaredFiles: ['docs/a.md'], collect: () => { throw new Error('gh down'); } }).ok).toBe(false);
  });
  it.each(['docs/*.md', 'docs/**/*.md', 'backlog/*.md'])('a wildcard %s still reaches executable descendants a prose filter would hide', scope => {
    const claim = scope.startsWith('docs') ? 'we:docs/generated.md/build.mjs' : 'we:backlog/gen.md/build.mjs';
    expect(run({ agents: [{ ...agent, files: [claim] }] }, { declaredFiles: [scope] }).ok).toBe(false);
  });
});

describe('checkScope reads exactly the declared repositories', () => {
  it('asks the collector for each declared repo only, with the registry required', () => {
    const collect = vi.fn(() => snapshot({ repos: [FUI, 'plateauapp/plateau-app'] }));
    expect(checkScope({ declaredFiles: ['frontierui:src/index.ts', 'plateau:x.ts', 'frontierui:src/b.ts'], collect, now }).ok).toBe(true);
    expect(collect.mock.calls[0][0]).toMatchObject({ repos: [FUI, 'plateauapp/plateau-app'], requireRegistry: true });
  });
  it('refuses a collector that did not cover a declared repository', () => {
    expect(run({}, { declaredFiles: ['frontierui:src/index.ts'] })).toMatchObject({ ok: false, reason: expect.stringContaining('incomplete scope snapshot') });
    expect(run({ repos: undefined }).ok).toBe(false);
  });
  it('reads Frontier UI open PRs through the real reader and reports its overlap', () => {
    const listed = [];
    const exec = args => {
      listed.push(args[3]);
      return JSON.stringify([{ number: 9, title: 't', url: 'u', headRefOid: 'x', files: [{ path: 'src/index.ts', changeType: 'MODIFIED' }] }]);
    };
    withRegistry([], registryPath => {
      expect(checkScope({ declaredFiles: ['frontierui:src/index.ts'], now, collect: realCollect(registryPath, exec) }))
        .toMatchObject({ ok: false, overlaps: [{ file: 'frontierui:src/index.ts', pr: { number: 9, repo: FUI } }] });
    });
    expect(listed).toEqual([FUI]);
  });
});

describe('checkScope canonicalizes repository identifiers', () => {
  it('treats a full slug as the same repo as its key, in declarations and claims', () => {
    expect(run({ agents: [agent] }, { declaredFiles: [`${WE}:scripts/a.mjs`] })).toMatchObject({ ok: false,
      overlaps: [{ file: 'we:scripts/a.mjs', agent: 'lane-3' }] });
    expect(run({ agents: [{ ...agent, files: [`${WE}:scripts/a.mjs`] }] }).ok).toBe(false);
    expect(run({ agents: [agent] }, { declaredFiles: ['webeverything:scripts/a.mjs'] }).ok).toBe(false);
  });
  it.each(['other:scripts/a.mjs', 'org/project:scripts/a.mjs', 'constructor:a.mjs', '__proto__:a.mjs', ':a.mjs'])
  ('refuses unknown repository %s without reading evidence', file => {
    const collect = vi.fn(() => snapshot());
    expect(checkScope({ declaredFiles: [file], collect, now })).toMatchObject({ ok: false, reason: expect.stringContaining('unknown repository') });
    expect(collect).not.toHaveBeenCalled();
  });
  it('refuses a stored claim naming an unknown repository', () => {
    expect(run({ agents: [{ ...agent, files: ['other:scripts/a.mjs'] }] })).toMatchObject({ ok: false, reason: expect.stringContaining('unknown repository') });
  });
});

describe('checkScope validates persisted claims before trusting them', () => {
  it.each([['./'], ['./', 'we:b.mjs'], [' ']])('refuses a claim that normalizes to nothing: %j', (...files) => {
    expect(run({ agents: [{ ...agent, files }] })).toMatchObject({ ok: false, reason: expect.stringContaining('scope check failed') });
  });
  it.each([[{ ttlHours: 1e308 }], [{ ttlHours: Number.MAX_VALUE }], [{ ttlHours: 1e300, startedAt: '2026-11-18T12:00:00Z' }],
    [{ staleAfterMinutes: 1e308, lastSeenAt: '2026-11-18T12:00:00Z' }], [{ staleAfterMinutes: 1e308 }]])
  ('refuses an expiry the partitioner cannot compute: %j', patch => {
    expect(run({ agents: [{ ...agent, ...patch }] })).toMatchObject({ ok: false, reason: expect.stringContaining('corrupt scope registry entry') });
  });
  it('still honours a very long but representable TTL as a live claim', () => {
    expect(run({ agents: [{ ...agent, ttlHours: 24 * 365 * 10 }] }).ok).toBe(false);
  });
  it('refuses a non-string owner', () => {
    expect(run({ agents: [{ ...agent, owner: 5 }] }).ok).toBe(false);
  });
  it('names the holder of a claim it refuses, e.g. one registered under a repo outside the constellation', () => {
    expect(run({ agents: [{ ...agent, agent: 'old-worker', files: ['longshore:src/a.ts'] }] }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/unknown repository.*agent "old-worker"/) });
  });
});

describe('checkScope reads PR evidence without re-splitting file paths', () => {
  it('holds a PR file whose name contains a colon', () => {
    const prs = [{ repo: WE, number: 4, files: ['docs/a:b.md'] }];
    expect(run({ prs }, { declaredFiles: ['we:docs/a:b.md'] })).toMatchObject({ ok: false, overlaps: [{ file: 'we:docs/a:b.md', pr: { number: 4 } }] });
    expect(run({ prs }, { declaredFiles: ['we:docs/other.md'] }).ok).toBe(true);
  });
  it('keeps a brand-new backlog card exact-path-only after qualifying', () => {
    const prs = [{ repo: WE, number: 4, files: ['backlog/new.md'], added: ['backlog/new.md'] }];
    expect(run({ prs }, { declaredFiles: ['we:backlog/'] }).ok).toBe(true);
    expect(run({ prs }, { declaredFiles: ['we:backlog/new.md'] }).ok).toBe(false);
  });
  it.each([[{ repo: WE, number: 4 }], [{ repo: WE, number: 4, files: 'x' }], [{ repo: WE, number: 4, files: [''] }],
    [{ repo: WE, number: 4, files: ['a'], added: 'a' }], [{ repo: 'org/unknown', number: 4, files: ['a'] }], [null]])
  ('refuses a malformed open PR %j', pr => {
    expect(run({ prs: [pr] })).toMatchObject({ ok: false, reason: expect.stringContaining('incomplete scope snapshot') });
  });
});

describe('check-scope cannot be resumed (a saved verdict never stands in for a fresh read)', () => {
  const drive = () => {
    const { declaration, sinks } = OPERATIONS['check-scope']();
    const registry = createRegistry();
    registry.register(declaration);
    const records = new Map();
    const store = { read: id => records.get(id) ?? null, write: record => records.set(record.id, record) };
    return { declaration, records, go: argv => runOperationCli({ declaration, argv, registry, store, sinks, newRunId: () => 'cs-run' }) };
  };
  it('keeps no run record a later --resume could replay: the CLI refuses it instead of returning a saved verdict', () => {
    // Real CLI, two processes. `node` stands in for gh so the first read fails closed; what matters is that the
    // second invocation finds nothing to resume (a file-backed store would have replayed the saved run).
    withRegistry([], registryPath => {
      const cli = join(process.cwd(), 'scripts/operations/run.mjs');
      const env = { ...process.env, WE_AGENT_SCOPES_PATH: registryPath, WE_FREE_SCOPE_GH_BIN: process.execPath };
      const invoke = args => spawnSync(process.execPath, [cli, 'check-scope', ...args], { env, encoding: 'utf8', timeout: 90e3 });
      const first = invoke(['--files=scripts/a.mjs', '--run-id=cs-resume-probe']);
      expect(first.stdout).toContain('"ok":false');
      const resumed = invoke(['--resume=cs-resume-probe']);
      expect(resumed.status).toBe(2);
      expect(resumed.stdout).toContain('scope check did not run');
      expect(resumed.stdout).not.toContain('"ok"');
    });
  }, 200e3);
  it('re-reads evidence on a second ordinary invocation', async () => {
    collectFreeScope.mockClear();
    collectFreeScope.mockImplementationOnce(() => snapshot()).mockImplementationOnce(() => snapshot({ agents: [{ ...agent, startedAt: new Date().toISOString() }] }));
    const { go } = drive();
    expect((await go(['--files=scripts/a.mjs'])).run.verdict.ok).toBe(true);
    expect((await go(['--files=scripts/a.mjs'])).run.verdict.ok).toBe(false);
    expect(collectFreeScope).toHaveBeenCalledTimes(2);
  });
});

describe('checkScope evidence completeness through the real reader', () => {
  it('fails closed when the registry file is missing, while the lenient reader still reads it as empty', () => {
    withRegistry(null, registryPath => {
      expect(readRegistry(registryPath)).toEqual([]);
      expect(() => readRegistry(registryPath, { required: true })).toThrow(/does not exist/);
      expect(run({}, { collect: realCollect(registryPath, () => '[]') })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
    });
  });
  const prRows = files => JSON.stringify([{ number: 5, title: 't', url: 'u', headRefOid: 'nope', ...(files ? { files } : {}) }]);
  const apiRows = '{"s":"renamed","f":"new.mjs","p":"old.mjs"}\n';
  const renamed = [{ path: 'new.mjs', changeType: 'RENAMED' }];
  const pagedExec = (rows, api) => args => { if (args[0] === 'pr') return rows; if (args[0] === 'api') { if (api instanceof Error) throw api; return api; } throw new Error('unexpected gh call'); };
  it("reports a rename's previous path from the paginated API when git is unavailable", () => {
    withRegistry([], registryPath => {
      expect(checkScope({ declaredFiles: ['old.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows(renamed), apiRows)) }))
        .toMatchObject({ ok: false, overlaps: [{ file: 'we:old.mjs', pr: { number: 5 } }] });
    });
  });
  it("never clears a rename's previous path when the paginated API is unavailable", () => {
    withRegistry([], registryPath => {
      const result = checkScope({ declaredFiles: ['old.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows(renamed), new Error('api down'))) });
      expect(result.ok).toBe(false);
      expect(result.unreadable).toEqual([{ repo: WE, error: expect.stringContaining('renamed') }]);
    });
  });
  it('treats a PR row without files data as incomplete, never as an empty change set', () => {
    withRegistry([], registryPath => {
      const noFiles = checkScope({ declaredFiles: ['a.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows(), new Error('api down'))) });
      expect(noFiles.ok).toBe(false);
      expect(noFiles.unreadable).toEqual([{ repo: WE, error: expect.stringContaining('no usable files') }]);
      const malformed = checkScope({ declaredFiles: ['a.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows([{ changeType: 'MODIFIED' }]), new Error('api down'))) });
      expect(malformed.ok).toBe(false);
    });
  });
  it('treats an empty PR file list as unverified when git is unavailable', () => {
    withRegistry([], registryPath => {
      const down = checkScope({ declaredFiles: ['a.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows([]), new Error('api down'))) });
      expect(down.ok).toBe(false);
      expect(down.unreadable).toEqual([{ repo: WE, error: expect.stringContaining('no usable files') }]);
      // The paginated API can confirm that a PR really changes nothing, and then it clears.
      expect(checkScope({ declaredFiles: ['a.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows([]), '')) }))
        .toEqual({ ok: true, overlaps: [] });
    });
  });
  it('recovers a PR row without files data from the paginated API', () => {
    withRegistry([], registryPath => {
      expect(checkScope({ declaredFiles: ['new.mjs'], now, collect: realCollect(registryPath, pagedExec(prRows(), apiRows)) }))
        .toMatchObject({ ok: false, overlaps: [{ pr: { number: 5 } }] });
    });
  });
});

describe('check-scope operation re-reads evidence on every invocation', () => {
  const finishOf = verdict => OPERATIONS['check-scope']().finish({ run: { verdict }, lines: [] }).code;
  const invoke = (id = 'cs-1') => {
    const { declaration } = OPERATIONS['check-scope']();
    const registry = createRegistry();
    registry.register(declaration);
    const finished = advanceWhileRunning(startRun({ op: 'check-scope', id, input: { files: 'scripts/a.mjs' }, registry }), { registry });
    expect(runStatus(finished, { registry })).toBe('complete');
    return finished.verdict;
  };
  it('is declared read-only with no stored effect to replay', () => {
    const { declaration, sinks } = OPERATIONS['check-scope']();
    expect(sinks).toEqual({});
    expect(isReadOnlyDeclaration(declaration)).toBe(true);
  });
  it('collects fresh evidence each time, so a verdict can never outlive the evidence it was read from', () => {
    collectFreeScope.mockClear();
    collectFreeScope
      .mockImplementationOnce(() => snapshot())
      .mockImplementationOnce(() => snapshot({ agents: [{ ...agent, startedAt: new Date().toISOString() }] }));
    const first = invoke('same-id'), second = invoke('same-id');
    expect(collectFreeScope).toHaveBeenCalledTimes(2);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(finishOf(first)).toBe(0);
    expect(finishOf(second)).toBe(1);
    expect(finishOf({ ok: false, overlaps: [], reason: 'x' })).toBe(2);
  });
});
