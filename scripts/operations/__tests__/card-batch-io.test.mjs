// @vitest-environment node
/** Real Git admission probes: remote trees, crash recovery and durable state, with no host repository writes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
import { admitCard, gitIn } from '../card-batch-io.mjs';
import * as batchIO from '../card-batch-io.mjs';
import { reconcileCardBatches } from '../card-batch-reconcile.mjs';
import { drainPendingPrevention } from '../land-prevention-card.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, args, options = {}) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'card-batch-test-'));
  roots.push(root);
  const laneDir = join(root, 'producer');
  const remote = join(root, 'remote.git');
  const stateDir = join(root, 'state');
  mkdirSync(laneDir);
  mkdirSync(stateDir);
  git(root, ['init', '--bare', '-q', remote]);
  git(laneDir, ['init', '-q']);
  writeFileSync(join(laneDir, '.gitattributes'), '*.md text eol=lf\n');
  git(laneDir, ['add', '.gitattributes']);
  git(laneDir, ['commit', '-qm', 'base']);
  const baseSha = git(laneDir, ['rev-parse', 'HEAD']).trim();
  git(laneDir, ['remote', 'add', 'origin', remote]);
  git(laneDir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  mkdirSync(join(laneDir, 'backlog'));
  let time = Date.parse('2026-10-06T12:00:00Z');
  const options = { stateDir, remote: 'origin', owner: 'producer-a', clock: () => time, leaseMs: 60_000 };
  const card = (id = '5192', bytes = Buffer.from(`# Card ${id}\r\nCafé\r\n`)) => {
    const cardPath = `backlog/${id}-card.md`;
    writeFileSync(join(laneDir, cardPath), bytes);
    return { cardPath, cardId: id, idemKey: `key-${id}`, baseSha, kind: 'prevention',
      source: { repo: 'org/repo', pr: 123, head: baseSha }, laneDir };
  };
  const ref = 'refs/heads/lane/card-batch-prevention-1';
  const statePath = join(stateDir, 'org-repo-prevention.json');
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const head = () => git(remote, ['rev-parse', '--verify', ref]).trim();
  const count = () => Number(git(remote, ['rev-list', '--count', `${baseSha}..${ref}`]).trim());
  const bytes = path => git(remote, ['show', `${ref}:${path}`], { encoding: 'buffer' });
  return { root, laneDir, remote, stateDir, options, card, ref, baseSha, statePath, state, head, count, bytes,
    tick: delta => { time += delta; }, now: () => time };
}

async function retry(input, options) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await admitCard(input, options);
    if (!['lease-held', 'ff-reject'].includes(result.reason)) return result;
    await setTimeout(5);
  }
  throw new Error('bounded admission retries exhausted');
}

function assertRecorded(f, inputs) {
  expect(f.count()).toBe(inputs.length);
  expect(f.state().headSha).toBe(f.head());
  expect(f.state().members).toHaveLength(inputs.length);
  for (const input of inputs) {
    expect(f.bytes(input.cardPath)).toEqual(readFileSync(join(input.laneDir, input.cardPath)));
    const member = f.state().members.find(member => member.idemKey === input.idemKey);
    expect(member).toMatchObject({ cardId: input.cardId, source: input.source, admittedAt: expect.any(String) });
    expect(git(f.remote, ['diff-tree', '--no-commit-id', '--name-status', '-r', member.commitSha]).trim()).toBe(`A\t${input.cardPath}`);
    const message = git(f.remote, ['show', '-s', '--format=%B', member.commitSha]);
    expect(message).toContain(input.cardId);
    expect(message).toContain(input.idemKey);
  }
  expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
}

// Manufacture readable coordinator evidence independently of the admission guards.
function recoveryEvidence(f, sealed, scenario) {
  const member = sealed.members[0];
  const originalPath = 'backlog/5192-card.md';
  const originalMessage = git(f.remote, ['show', '-s', '--format=%B', member.commitSha]);
  const metadata = JSON.parse(originalMessage.split('\n').find(line => line.startsWith('Card-Batch: ')).slice(12));
  if (scenario === 'repo mismatch') metadata.source.repo = 'other/repo';
  if (scenario === 'cardPath mismatch') metadata.cardPath = 'backlog/5192-other.md';
  if (scenario === 'cardId mismatch') metadata.cardId = 'other';
  if (scenario === 'idemKey mismatch') metadata.idemKey = 'other';
  if (scenario === 'kind mismatch') metadata.kind = 'other';
  if (scenario === 'batchRef mismatch') metadata.batchRef = 'lane/card-batch-prevention-99';
  if (scenario === 'non-card path') metadata.cardPath = 'config.json';
  if (scenario === 'nested backlog path') metadata.cardPath = 'backlog/nested/5192-card.md';
  if (scenario === 'card prefix mismatch') metadata.cardPath = 'backlog/5193-card.md';
  git(f.remote, ['read-tree', f.baseSha]);
  const path = ['non-card path', 'nested backlog path', 'card prefix mismatch'].includes(scenario) ? metadata.cardPath : originalPath;
  const content = scenario === 'non-UTF8 bytes' ? Buffer.from([0xff])
    : scenario === 'oversized output' ? Buffer.alloc(16 * 1024 * 1024 + 1, 'x') : Buffer.from('committed evidence\n');
  const blob = git(f.remote, ['hash-object', '-w', '--stdin'], { input: content }).trim();
  const mode = scenario === 'symlink' ? '120000' : scenario === 'executable' ? '100755' : '100644';
  git(f.remote, ['update-index', '--add', '--cacheinfo', mode, blob, path]);
  if (scenario === 'extra changed file') git(f.remote, ['update-index', '--add', '--cacheinfo', '100644', blob, 'config.json']);
  const tree = git(f.remote, ['write-tree']).trim();
  const marker = `Card-Batch: ${JSON.stringify(metadata)}`;
  const message = scenario === 'invalid marker' ? 'Card-Batch: {\n'
    : scenario === 'missing marker' ? 'unmarked\n'
    : `${marker}\n${scenario === 'duplicate marker' ? marker : ''}\n`;
  const sha = git(f.remote, ['commit-tree', tree, '-p', f.baseSha], { input: message }).trim();
  git(f.remote, ['update-ref', f.ref, sha]);
  sealed.headSha = sha;
  member.commitSha = sha;
}

// Mutations exist only in disposable modules: repository source and its guards stay intact.
function mutantProbe(f, replacements, probe) {
  const moduleURL = new URL('../card-batch-io.mjs', import.meta.url);
  let source = readFileSync(moduleURL, 'utf8');
  for (const [before, after] of replacements) {
    expect(source.split(before)).toHaveLength(2);
    source = source.replace(before, after);
  }
  for (const specifier of ['./card-batch.mjs', '../lib/automation-home.mjs', '../lib/tick-deadline.mjs']) {
    source = source.replace(`'${specifier}'`, JSON.stringify(new URL(specifier, moduleURL).href));
  }
  const path = join(f.root, 'mutant.mjs');
  writeFileSync(path, source);
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {
    input: `import * as io from ${JSON.stringify(pathToFileURL(path).href)};\n${probe}`,
    cwd: f.laneDir, env, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function mutantAdmission(f) {
  const input = f.card('5193');
  return `const logs = [];
    const result = await io.admitCard(${JSON.stringify(input)}, {
      stateDir: ${JSON.stringify(f.stateDir)}, remote: 'origin', clock: () => ${f.now()},
      gh: async () => '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"CLOSED"}', log: line => logs.push(line),
    });
    console.log(JSON.stringify({ result, logs }));`;
}

describe('durable card batch IO', () => {
  it('cannot retire an incomplete seal even when GitHub would report merged', async () => {
    const f = fixture(); await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'ready' } }));
    const before = readFileSync(f.statePath), gh = vi.fn(async () => JSON.stringify({ state: 'MERGED' }));
    expect(await admitCard(f.card('5193'), { ...f.options, gh })).toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(gh).not.toHaveBeenCalled(); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it.each([{ number: 999, headRefName: 'lane/card-batch-prevention-1', state: 'MERGED' },
    { number: 5272, headRefName: 'lane/other', state: 'CLOSED' }])('requires the exact recorded sealed PR identity: %j', async view => {
    const f = fixture(); await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    expect(await admitCard(f.card('5193'), { ...f.options, gh: async () => JSON.stringify(view), log: () => {} }))
      .toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.statePath)).toEqual(before); expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
  });
  it.each(['MERGED', 'OPEN', 'CLOSED', 'unreadable'])('dedupes a sealed %s batch member before looking up GitHub', async status => {
    const f = fixture();
    const input = f.card();
    const original = await admitCard(input, f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    let calls = 0;
    const result = await admitCard(input, { ...f.options, log: () => {}, gh: async () => {
      calls++;
      if (status === 'unreadable') throw new Error('unreadable');
      return JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status });
    } });
    expect(result).toMatchObject({ action: 'dedupe', member: original.member });
    expect(calls).toBe(0);
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.count()).toBe(1);
    expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
  });

  it('still validates the remote head before deduping a sealed member', async () => {
    const f = fixture();
    const input = f.card();
    await admitCard(input, f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    const foreign = git(f.remote, ['commit-tree', `${f.ref}^{tree}`, '-p', f.head(), '-m', 'unrelated commit']).trim();
    git(f.remote, ['update-ref', f.ref, foreign]);
    let calls = 0;
    expect(await admitCard(input, { ...f.options, gh: async () => { calls++; return '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"MERGED"}'; }, log: () => {} }))
      .toEqual({ action: 'refuse', reason: 'head-mismatch' });
    expect(calls).toBe(0);
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(foreign);
  });

  it.each(['MERGED', 'CLOSED'])('retires a sealed %s PR on admission and retries idempotently', async status => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    const sealed = { ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } };
    writeFileSync(f.statePath, JSON.stringify(sealed));
    const calls = [];
    const options = { ...f.options, gh: async args => { calls.push(args); return JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status }); }, log: () => {} };
    const next = f.card('5193');
    expect(await admitCard(next, options)).toMatchObject({ action: 'admit', batchRef: 'lane/card-batch-prevention-2' });
    expect(calls).toEqual([['pr', 'view', '5272', '--repo', 'org/repo', '--json', 'number,state,headRefName']]);
    expect(JSON.parse(readFileSync(join(f.stateDir, 'sealed/org-repo-1-prevention.json')))).toMatchObject(sealed);
    if (status === 'CLOSED') {
      expect(JSON.parse(readFileSync(join(f.stateDir, 'pending-prevention/5192.json')))).toMatchObject({
        cardId: first.cardId, rel: first.cardPath, content: readFileSync(join(f.laneDir, first.cardPath), 'utf8'),
        idemKey: first.idemKey, source: first.source,
      });
    } else expect(existsSync(join(f.stateDir, 'pending-prevention'))).toBe(false);
    const before = readFileSync(f.statePath);
    expect((await admitCard(next, options)).action).toBe('dedupe');
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(calls).toHaveLength(1);
  });

  it('closed recovery preserves committed content after worktree edits', async () => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    const committed = f.bytes(first.cardPath).toString('utf8');
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    writeFileSync(join(f.laneDir, first.cardPath), 'modified worktree content\n');
    expect((await admitCard(f.card('5193'), { ...f.options, gh: async () => '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"CLOSED"}', log: () => {} })).action).toBe('admit');
    expect(JSON.parse(readFileSync(join(f.stateDir, 'pending-prevention/5192.json'), 'utf8')).content).toBe(committed);
  });

  it.each([
    'extra changed file', 'symlink', 'executable', 'repo mismatch', 'cardPath mismatch',
    'non-UTF8 bytes', 'duplicate marker', 'invalid marker', 'missing marker',
    'non-card path', 'nested backlog path', 'card prefix mismatch', 'cardId mismatch',
    'idemKey mismatch', 'kind mismatch', 'batchRef mismatch', 'oversized output',
  ])('closed recovery refuses invalid evidence: %s', async scenario => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const sealed = { ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } };
    recoveryEvidence(f, sealed, scenario);
    writeFileSync(f.statePath, JSON.stringify(sealed));
    const before = readFileSync(f.statePath);
    const head = f.head();
    expect(await admitCard(f.card('5193'), { ...f.options, gh: async () => '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"CLOSED"}', log: () => {} }))
      .toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(head);
    expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'pending-prevention'))).toBe(false);
  }, 30_000);

  it.each(['MERGED', 'CLOSED', 'OPEN', 'unreadable'])('logs retirement and held recovery outcomes: %s', async status => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const lines = [];
    const result = await admitCard(f.card('5193'), { ...f.options, log: line => lines.push(line), gh: async () => {
      if (status === 'unreadable') throw new Error('lookup failed');
      return JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status });
    } });
    const outcome = status === 'CLOSED' ? 'retired and re-spooled' : status === 'MERGED' ? 'retired'
      : status === 'OPEN' ? 'kept sealed and held' : 'recovery unreadable; kept sealed and held';
    expect(result.action).toBe(['MERGED', 'CLOSED'].includes(status) ? 'admit' : 'refuse');
    expect(lines).toEqual([`card-batch lane/card-batch-prevention-1 PR 5272 GitHub ${status === 'unreadable' ? 'UNREADABLE' : status}: ${outcome}`]);
  });

  it.each(['MERGED', 'CLOSED'])('keeps %s recovery held when the lookup loses its lease', async status => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    const successor = JSON.stringify({ token: 'successor', expiresAt: f.now() + 60000 });
    expect(await admitCard(f.card('5193'), { ...f.options, gh: async () => {
      writeFileSync(`${f.statePath}.lock`, successor);
      return JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status });
    } })).toEqual({ action: 'refuse', reason: 'lease-held' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(readFileSync(`${f.statePath}.lock`, 'utf8')).toBe(successor);
    expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'pending-prevention'))).toBe(false);
  });

  it.each(['MERGED', 'CLOSED'])('slow %s recovery cannot write after lease expiry', async status => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    expect(await admitCard(f.card('5193'), { ...f.options, gh: async () => {
      f.tick(60_000);
      return JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status });
    } })).toEqual({ action: 'refuse', reason: 'lease-held' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
  });

  it.each(['ETIMEDOUT', 'ENOBUFS'])('a bounded GitHub lookup failure keeps recovery held: %s', async code => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    const calls = [];
    const gh = args => batchIO.defaultGh(args, (_command, _args, options) => {
      calls.push(options);
      throw Object.assign(new Error(code), { code });
    });
    expect(await admitCard(f.card('5193'), { ...f.options, gh, log: () => {} }))
      .toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(calls).toEqual([expect.objectContaining({ timeout: 30_000, maxBuffer: 1024 * 1024 })]);
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
  });

  it('retirement preserves a state already inside the sealed archive', () => {
    const f = fixture();
    const state = { seq: 1, sealedAt: 'sealed' };
    expect(batchIO.retireBatch(join(f.stateDir, 'sealed/batch.json'), state, { held: () => true })).toBe(state);
  });

  it('admission fails closed when directed at the sealed archive', async () => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const archive = join(f.stateDir, 'sealed');
    mkdirSync(archive);
    const path = join(archive, 'org-repo-prevention.json');
    writeFileSync(path, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(path);
    expect(await admitCard(f.card('5193'), { ...f.options, stateDir: archive, gh: async () => '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"MERGED"}', log: () => {} }))
      .toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(archive)).toEqual(['org-repo-prevention.json']);
  });

  it('recovery subprocesses enforce production timeout and output limits', () => {
    const calls = [];
    const exec = (...args) => { calls.push(args); return 'bounded result'; };
    expect(batchIO.defaultGh(['pr', 'view', '5272'], exec)).toBe('bounded result');
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '5272'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }]);
    const run = batchIO.recoveryGitIn('/fixture', exec);
    for (const args of [['fetch', 'origin', 'main'], ['show', 'HEAD:backlog/5192-card.md'], ['diff-tree', 'HEAD'], ['ls-tree', 'HEAD']]) {
      expect(run(args, { timeout: 0, maxBuffer: Infinity, encoding: 'buffer' })).toBe('bounded result');
      expect(calls.at(-1)).toEqual(['git', args, expect.objectContaining({
        cwd: '/fixture', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer',
      })]);
    }
  });

  it('mutation gate distinguishes committed recovery bytes from worktree reads', async () => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    const committed = f.bytes(first.cardPath).toString('utf8');
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    writeFileSync(join(f.laneDir, first.cardPath), 'worktree mutant\n');
    const probe = mutantProbe(f, [[
      "const bytes = git(['show', `${member.commitSha}:${data.cardPath}`], { encoding: 'buffer' });",
      'const bytes = readFileSync(resolve(input.laneDir, data.cardPath));',
    ]], mutantAdmission(f));
    expect(probe.result.action).toBe('admit');
    const recovered = JSON.parse(readFileSync(join(f.stateDir, 'pending-prevention/5192.json'), 'utf8')).content;
    expect(recovered).toBe('worktree mutant\n');
    expect(recovered).not.toBe(committed);
  });

  it('mutation gate distinguishes removal of recovery path restrictions', async () => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const sealed = { ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } };
    recoveryEvidence(f, sealed, 'non-card path');
    writeFileSync(f.statePath, JSON.stringify(sealed));
    const probe = mutantProbe(f, [
      ['!/^backlog\\/[a-z0-9]+-[a-z0-9-]+\\.md$/.test(data.cardPath)', 'false'],
      ['!data.cardPath.startsWith(`backlog/${member.cardId}-`)', 'false'],
    ], mutantAdmission(f));
    expect(probe.result.action).toBe('admit');
    expect(JSON.parse(readFileSync(join(f.stateDir, 'pending-prevention/5192.json'), 'utf8')).rel).toBe('config.json');
  });

  it.each([
    ['GitHub timeout', 'timeout: 30_000, maxBuffer: 1024 * 1024, stdio', 'maxBuffer: 1024 * 1024, stdio', 'gh', 'timeout'],
    ['GitHub output limit', 'maxBuffer: 1024 * 1024, stdio:', 'stdio:', 'gh', 'maxBuffer'],
    ['Git timeout', '...options, timeout: 30_000', '...options', 'git', 'timeout'],
    ['Git output limit', '...options, maxBuffer: 16 * 1024 * 1024', '...options', 'git', 'maxBuffer'],
    ['cat-file timeout', "timeout: 30_000, maxBuffer: 1024 * 1024 * 1024, stdio", "maxBuffer: 1024 * 1024 * 1024, stdio", 'catfile', 'timeout'],
  ])('mutation gate detects removal of %s', (_name, before, after, runner, key) => {
    const f = fixture();
    const options = mutantProbe(f, [[before, after]], `
      const exec = (_command, _args, options) => JSON.stringify(options);
      const result = ${runner === 'gh' ? 'io.defaultGh([], exec)' : runner === 'catfile'
        ? "(io.catFileBatch('/fixture', ['a:b'], (_c, _a, options) => ({ status: 0, stdout: Buffer.from(JSON.stringify(options)) })).toString())"
        : "io.recoveryGitIn('/fixture', exec)([])"};
      console.log(result);`);
    expect(options[key]).toBeUndefined();
  });

  it.each(['MERGED', 'CLOSED', 'OPEN', 'unreadable'])('mutation gate detects removal of %s outcome logging', async status => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const target = ['MERGED', 'CLOSED'].includes(status) ? '\n      log(`card-batch ${retired.batchRef}'
      : status === 'OPEN' ? '\n      log(`card-batch ${recorded.batchRef}' : '\n    log(`card-batch ${recorded.batchRef}';
    const probe = mutantProbe(f, [[target, target.replace('log(', 'void(')]],
      mutantAdmission(f).replace(/gh: async \(\) => '[^']*'/,
        status === 'unreadable' ? "gh: async () => { throw new Error('unreadable'); }"
          : `gh: async () => ${JSON.stringify(JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status }))}`));
    expect(probe.result.action).toBe(['MERGED', 'CLOSED'].includes(status) ? 'admit' : 'refuse');
    expect(probe.logs).toEqual([]);
  });

  it.each(['OPEN', 'error', 'truncated', 'unknown'])('keeps a sealed %s PR held without changing state', async status => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const before = readFileSync(f.statePath);
    const gh = async () => {
      if (status === 'error') throw new Error('unreadable');
      return status === 'truncated' ? '{' : JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status });
    };
    expect(await admitCard(f.card('5193'), { ...f.options, gh, log: () => {} })).toEqual({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
  });

  it.each(['landed', 'missing-member', 'conflict', 'lease-lost'])('closed recovery handles %s without losing cards', async scenario => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    const sealed = { ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } };
    if (scenario === 'landed') git(f.remote, ['update-ref', 'refs/heads/main', sealed.headSha]);
    if (scenario === 'missing-member') sealed.members[0].commitSha = 'a'.repeat(40);
    const pending = join(f.stateDir, 'pending-prevention');
    if (scenario === 'conflict') {
      mkdirSync(pending);
      writeFileSync(join(pending, '5192.json'), '{"content":"other producer"}');
    }
    writeFileSync(f.statePath, JSON.stringify(sealed));
    const before = readFileSync(f.statePath);
    const result = await admitCard(f.card('5193'), { ...f.options, log: () => {}, gh: async () => {
      if (scenario === 'lease-lost') writeFileSync(`${f.statePath}.lock`, JSON.stringify({ token: 'successor', expiresAt: f.now() + 60000 }));
      return '{"number":5272,"headRefName":"lane/card-batch-prevention-1","state":"CLOSED"}';
    } });
    if (scenario === 'landed') {
      expect(result.action).toBe('admit');
      expect(readdirSync(pending)).toEqual([]);
    } else {
      expect(result.action).toBe('refuse');
      expect(readFileSync(f.statePath)).toEqual(before);
      if (scenario === 'conflict') expect(readFileSync(join(pending, '5192.json'), 'utf8')).toBe('{"content":"other producer"}');
    }
  });

  it('drains 327 spooled cards through admission into batches of ten and an idempotent tail', async () => {
    const f = fixture();
    await admitCard(f.card('old'), f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    const pendingDir = join(f.stateDir, 'pending-prevention');
    mkdirSync(pendingDir);
    for (let i = 0; i < 327; i++) {
      const input = f.card(`x${String(i).padStart(6, '0')}`);
      writeFileSync(join(pendingDir, `${input.cardId}.json`), JSON.stringify({ cardId: input.cardId, rel: input.cardPath,
        content: readFileSync(join(f.laneDir, input.cardPath), 'utf8'), idemKey: input.idemKey, source: input.source }));
    }
    const sizes = [];
    const batch = async input => {
      const cardId = input.cardPath.split('/')[1].split('-')[0];
      const result = await admitCard({ ...input, cardId, baseSha: f.baseSha }, { ...f.options,
        gh: async () => JSON.stringify({ number: f.state().pr, headRefName: f.state().batchRef, state: 'MERGED' }), log: () => {} });
      if (result.action !== 'admit') return { batched: false };
      if (result.state.members.length === 10) {
        sizes.push(10);
        // Inject the seal worker's terminal state; no PR publication in this fixture.
        writeFileSync(f.statePath, JSON.stringify({ ...result.state, sealedAt: new Date(f.now()).toISOString(), pr: 5272 + result.state.seq, seal: { step: 'label-on-green' } }));
      }
      return { batched: true, batchRef: result.batchRef };
    };
    const options = { pendingDir, batch, write: () => {}, exec: (command, args) => execFileSync(command, args, { encoding: 'utf8' }) };
    await drainPendingPrevention({ lane: f.laneDir }, options);
    expect(readdirSync(pendingDir)).toEqual([]);
    expect(sizes).toEqual(Array(32).fill(10));
    expect(f.state()).toMatchObject({ seq: 34, members: expect.any(Array) });
    expect(f.state().members).toHaveLength(7);
    const before = readFileSync(f.statePath);
    await drainPendingPrevention({ lane: f.laneDir }, options);
    expect(readFileSync(f.statePath)).toEqual(before);
  }, 240000);

  it('admits two concurrent producers with exactly one byte-identical commit each', async () => {
    const f = fixture();
    const first = f.card();
    const second = f.card('5193', Buffer.from('different\0bytes\r\n'));
    const otherLane = join(f.root, 'other-producer');
    git(f.root, ['clone', '-q', f.laneDir, otherLane]);
    mkdirSync(join(otherLane, 'backlog'));
    writeFileSync(join(otherLane, second.cardPath), readFileSync(join(f.laneDir, second.cardPath)));
    second.laneDir = otherLane;
    const results = await Promise.all([
      retry(first, f.options), retry(second, { ...f.options, remote: f.remote, owner: 'producer-b' }),
    ]);
    expect(results.map(result => result.action)).toEqual(['admit', 'admit']);
    assertRecorded(f, [first, second]);
    expect(git(f.laneDir, ['rev-parse', 'HEAD']).trim()).toBe(f.baseSha);
    expect(git(otherLane, ['rev-parse', 'HEAD']).trim()).toBe(f.baseSha);
  });

  it('returns original membership on idempotent retry without rewriting the state', async () => {
    const f = fixture();
    const input = f.card();
    const original = await admitCard(input, f.options);
    const before = readFileSync(f.statePath);
    f.tick(1000);
    const again = await admitCard(input, { ...f.options, owner: 'other' });
    expect(again).toMatchObject({ action: 'dedupe', member: original.member });
    expect(readFileSync(f.statePath)).toEqual(before);
    assertRecorded(f, [input]);
  });

  it.each(['after-commit', 'after-push', 'after-record'])('recovers first admission crash %s', async crashAt => {
    const f = fixture();
    const input = f.card();
    await expect(admitCard(input, { ...f.options, crashAt })).rejects.toMatchObject({ code: 'CARD_BATCH_CRASH', point: crashAt });
    expect(existsSync(`${f.statePath}.lock`)).toBe(false);
    expect(existsSync(f.statePath)).toBe(crashAt === 'after-record');
    if (crashAt !== 'after-commit') expect(f.count()).toBe(1);
    await admitCard(input, f.options);
    assertRecorded(f, [input]);
    expect((await admitCard(input, f.options)).action).toBe('dedupe');
    expect(f.count()).toBe(1);
  });

  it.each(['after-commit', 'after-push', 'after-record'])('recovers an existing batch crash %s', async crashAt => {
    const f = fixture();
    const first = f.card();
    const second = f.card('5193');
    await admitCard(first, f.options);
    await expect(admitCard(second, { ...f.options, crashAt })).rejects.toMatchObject({ code: 'CARD_BATCH_CRASH' });
    await admitCard(second, f.options);
    assertRecorded(f, [first, second]);
  });

  it('reconciles another producer’s unrecorded push before adding the next card', async () => {
    const f = fixture();
    const first = f.card();
    const second = f.card('5193');
    await expect(admitCard(first, { ...f.options, crashAt: 'after-push' })).rejects.toMatchObject({ code: 'CARD_BATCH_CRASH' });
    expect((await admitCard(second, f.options)).action).toBe('admit');
    assertRecorded(f, [first, second]);
  });

  it('takes over an expired lease and records the new owner', async () => {
    const f = fixture();
    const input = f.card();
    writeFileSync(`${f.statePath}.lock`, JSON.stringify({ owner: 'old', expiresAt: f.now() - 1 }));
    expect((await admitCard(input, f.options)).action).toBe('admit');
    expect(f.state().lease.owner).toBe(f.options.owner);
    assertRecorded(f, [input]);
  });

  it('refuses a live lease without touching state, remote, or the owner’s lock', async () => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const input = f.card('5193');
    const before = readFileSync(f.statePath);
    const head = f.head();
    const held = JSON.stringify({ owner: 'other', expiresAt: f.now() + 10000, token: 'other-token' });
    writeFileSync(`${f.statePath}.lock`, held);
    expect(await admitCard(input, f.options)).toEqual({ action: 'refuse', reason: 'lease-held' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(head);
    expect(readFileSync(`${f.statePath}.lock`, 'utf8')).toBe(held);
  });

  it('refuses an unrelated remote head even for a previously admitted key', async () => {
    const f = fixture();
    const input = f.card();
    await admitCard(input, f.options);
    const before = readFileSync(f.statePath);
    const tree = git(f.remote, ['rev-parse', `${f.ref}^{tree}`]).trim();
    const foreign = git(f.remote, ['commit-tree', tree, '-p', f.head(), '-m', 'unrelated commit']).trim();
    git(f.remote, ['update-ref', f.ref, foreign]);
    expect(await admitCard(input, f.options)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(foreign);
  });

  it.each([
    ['invalid-policy', {}, { policy: {} }],
    ['kind-disabled', {}, { policy: loadCardBatchPolicy({ prevention: { enabled: false } }) }],
    ['unknown-kind', { kind: 'unknown' }, {}],
    ['ineligible-change', { cardPath: 'package.json' }, {}],
  ])('refuses %s with state and ref untouched', async (reason, changes, options) => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const input = { ...f.card('5193'), ...changes };
    const before = readFileSync(f.statePath);
    const head = f.head();
    expect(await admitCard(input, { ...f.options, ...options })).toEqual({ action: 'refuse', reason });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(head);
    expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json']);
  });

  it.each(['existing', 'executable', 'symlink'])('refuses a %s file without mutation', async type => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    const input = type === 'existing' ? { ...first, idemKey: 'new-key' } : f.card('5193');
    if (type === 'executable') chmodSync(join(f.laneDir, input.cardPath), 0o755);
    if (type === 'symlink') {
      rmSync(join(f.laneDir, input.cardPath));
      symlinkSync(join(f.laneDir, first.cardPath), join(f.laneDir, input.cardPath));
    }
    const before = readFileSync(f.statePath);
    const head = f.head();
    expect(await admitCard(input, f.options)).toEqual({ action: 'refuse', reason: 'ineligible-change' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(f.head()).toBe(head);
  });

  it('refuses sealed batches and uses the saved sequence for a successor', async () => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const sealed = { ...f.state(), sealedAt: new Date(f.now()).toISOString() };
    writeFileSync(f.statePath, JSON.stringify(sealed));
    const input = f.card('5193');
    expect(await admitCard(input, f.options)).toEqual({ action: 'refuse', reason: 'batch-sealed' });
    const oldHead = f.head();
    writeFileSync(f.statePath, JSON.stringify({ seq: sealed.seq }));
    const result = await admitCard(input, f.options);
    expect(result.batchRef).toBe('lane/card-batch-prevention-2');
    expect(f.head()).toBe(oldHead);
  });

  describe('lease edge cases', () => {
    const lockOf = f => `${f.statePath}.lock`;
    const successor = f => JSON.stringify({ owner: 'successor', expiresAt: f.now() + 600_000, token: 'successor-token' });
    const age = (path, f, byMs) => { const seconds = (f.now() - byMs) / 1000; utimesSync(path, seconds, seconds); };

    it('does not take a lock a successor created after the expiry was observed', async () => {
      const f = fixture();
      const lock = lockOf(f);
      writeFileSync(lock, JSON.stringify({ owner: 'old', expiresAt: f.now() - 1, token: 'old-token' }));
      const live = successor(f);
      const hook = point => { if (point === 'before-stale-removal') { rmSync(lock); writeFileSync(lock, live); } };
      expect(await admitCard(f.card(), { ...f.options, hook })).toEqual({ action: 'refuse', reason: 'lease-held' });
      expect(readFileSync(lock, 'utf8')).toBe(live);
      expect(readdirSync(f.stateDir)).toEqual(['org-repo-prevention.json.lock']);
      expect(existsSync(f.statePath)).toBe(false);
    });

    it.each(['', '{"owner":"killed mid-wri'])('takes over an old lock left unparseable by a killed producer (%j)', async content => {
      const f = fixture();
      const input = f.card();
      writeFileSync(lockOf(f), content);
      age(lockOf(f), f, 120_000);
      expect((await admitCard(input, f.options)).action).toBe('admit');
      assertRecorded(f, [input]);
    });

    it('refuses while a fresh unparseable lock may still be mid-write', async () => {
      const f = fixture();
      writeFileSync(lockOf(f), '');
      age(lockOf(f), f, 1000);
      expect(await admitCard(f.card(), f.options)).toEqual({ action: 'refuse', reason: 'lease-held' });
      expect(readFileSync(lockOf(f), 'utf8')).toBe('');
      expect(existsSync(f.statePath)).toBe(false);
    });

    it.each(['after-commit', 'after-push'])('refuses without releasing a successor lease taken before %s is checked', async point => {
      const f = fixture();
      const live = successor(f);
      const hook = p => { if (p === point) writeFileSync(lockOf(f), live); };
      expect(await admitCard(f.card(), { ...f.options, hook })).toEqual({ action: 'refuse', reason: 'lease-held' });
      expect(readFileSync(lockOf(f), 'utf8')).toBe(live);
      expect(existsSync(f.statePath)).toBe(false);
    });

    it('still returns the admission when a successor is mid-write on the lock at release', async () => {
      const f = fixture();
      const hook = p => { if (p === 'after-record') writeFileSync(lockOf(f), ''); };
      const result = await admitCard(f.card(), { ...f.options, hook });
      expect(result.action).toBe('admit');
      expect(readFileSync(lockOf(f), 'utf8')).toBe('');
    });
  });

  it('refuses a non-fast-forward push, leaving state alone and releasing the lease', async () => {
    const f = fixture();
    await admitCard(f.card(), f.options);
    const before = readFileSync(f.statePath);
    const hook = point => {
      if (point !== 'after-commit') return;
      const tree = git(f.remote, ['rev-parse', `${f.ref}^{tree}`]).trim();
      git(f.remote, ['update-ref', f.ref, git(f.remote, ['commit-tree', tree, '-p', f.head(), '-m', 'racing writer']).trim()]);
    };
    expect(await admitCard(f.card('5193'), { ...f.options, hook })).toEqual({ action: 'refuse', reason: 'ff-reject' });
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(existsSync(`${f.statePath}.lock`)).toBe(false);
  });

  it('bounds captured git output at 16 MiB and lets no caller raise it', () => {
    const f = fixture();
    const run = gitIn(f.laneDir);
    const blob = (size) => git(f.laneDir, ['hash-object', '-w', '--stdin'], { input: 'x'.repeat(size) }).trim();
    expect(run(['cat-file', 'blob', blob(2 * 1024 * 1024)])).toHaveLength(2 * 1024 * 1024);
    const over = blob(16 * 1024 * 1024 + 1);
    expect(() => run(['cat-file', 'blob', over])).toThrow(/ENOBUFS/);
    expect(() => run(['cat-file', 'blob', over], { maxBuffer: 64 * 1024 * 1024 })).toThrow(/ENOBUFS/);
  }, 30_000);

  describe('git argv from untrusted values', () => {
    it.each(['--upload-pack=touch ${marker}', '-x', 'HEAD', 'abc123', ''])('rejects baseSha %j before any git runs', async template => {
      const f = fixture();
      const marker = join(f.root, 'pwned');
      const input = { ...f.card(), baseSha: template.replace('${marker}', marker) };
      await expect(admitCard(input, f.options)).rejects.toThrow(TypeError);
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(f.stateDir)).toEqual([]);
    });

    it('refuses a state file whose headSha is not a commit id', async () => {
      const f = fixture();
      await admitCard(f.card(), f.options);
      const marker = join(f.root, 'pwned');
      writeFileSync(f.statePath, JSON.stringify({ ...f.state(), headSha: `--upload-pack=touch ${marker}` }));
      const before = readFileSync(f.statePath);
      expect(await admitCard(f.card('5193'), f.options)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(f.statePath)).toEqual(before);
    });
  });

  it('has no force-push option anywhere in its source', () => {
    expect(readFileSync(new URL('../card-batch-io.mjs', import.meta.url), 'utf8')).not.toContain('--force');
  });
});


describe('periodic terminal batch recovery with real Git', () => {
  it.each(['MERGED', 'CLOSED'])('retires %s without admission, then drains pending into seq+1', async status => {
    const f = fixture();
    const first = f.card();
    await admitCard(first, f.options);
    writeFileSync(f.statePath, JSON.stringify({ ...f.state(), sealedAt: new Date(f.now()).toISOString(), pr: 5272, seal: { step: 'label-on-green' } }));
    if (status === 'MERGED') {
      const pending = join(f.stateDir, 'pending-prevention'); mkdirSync(pending);
      writeFileSync(join(pending, '5193.json'), JSON.stringify({ cardId: '5193', rel: 'backlog/5193-card.md',
        content: '# Pending card', idemKey: 'key-5193', source: first.source }));
    }
    let drained = 0;
    let flushed = false;
    // Pin filing ON: this asserts the drain after retirement, not the operator's live prevention.filingEnabled pause.
    const results = await reconcileCardBatches({ ...f.options, laneDir: f.laneDir, now: f.now(),
      loadFilingSettings: () => ({ filingEnabled: true }),
      gh: async () => JSON.stringify({ number: 5272, headRefName: 'lane/card-batch-prevention-1', state: status }), log: () => {},
      drain: async (input, options) => {
        expect(input.drainPending).toBe(true);
        expect(f.state()).toMatchObject({ seq: 1, lastSealedState: expect.any(String) });
        expect(f.state().batchRef).toBeUndefined();
        await drainPendingPrevention({ lane: f.laneDir }, { ...options,
          exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }),
          batch: async card => {
            const result = await admitCard({ ...card, cardId: card.cardPath.split('/')[1].split('-')[0], baseSha: f.baseSha }, f.options);
            expect(result.action).toBe('admit'); drained++;
            expect(result.state.seq).toBe(2);
            return { batched: true, batchRef: result.batchRef };
          },
        });
        return { ok: true };
      },
      seal: async () => { expect(drained).toBe(1); flushed = true; },
    });
    expect(results[0].action).toBe('retired');
    expect(JSON.parse(readFileSync(join(f.stateDir, 'sealed/org-repo-1-prevention.json'))).terminalPrState).toBe(status);
    expect(f.state().seq).toBe(2);
    expect(readdirSync(join(f.stateDir, 'pending-prevention'))).toEqual([]);
    expect(flushed).toBe(true);
    expect(existsSync(`${f.statePath}.lock`)).toBe(false);
  });
});

describe('provenMergedLanding reads blobs through one cat-file process', () => {
  const card = (id, extra = '') => `---\ntitle: ${id}\n${extra}---\nbody of ${id}\n`;
  /** Recorded head H holds backlog/<id>-*.md; merge commit M renames to numbered files with `bornAs:`. */
  function landing({ landed = {}, deleted = [], extraBornAs = 3 } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'card-batch-proof-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'backlog'), { recursive: true });
    git(repo, ['init', '-q']);
    const ids = ['aaa', 'bbb', 'ccc'];
    for (const id of ids) writeFileSync(join(repo, 'backlog', `${id}-t.md`), card(id));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'recorded']);
    const headSha = git(repo, ['rev-parse', 'HEAD']).trim();
    ids.forEach((id, i) => {
      git(repo, ['mv', `backlog/${id}-t.md`, `backlog/${100 + i}-t.md`]);
      writeFileSync(join(repo, 'backlog', `${100 + i}-t.md`), card(id, `bornAs: ${id}\n`));
    });
    // Unrelated bornAs cards widen the grep set; one binary-ish blob exercises non-text bytes.
    for (let i = 0; i < extraBornAs; i++) writeFileSync(join(repo, 'backlog', `${200 + i}-o.md`), card(`o${i}`, `bornAs: o${i}\n`));
    for (const [id, text] of Object.entries(landed)) writeFileSync(join(repo, 'backlog', `${100 + ids.indexOf(id)}-t.md`), text);
    for (const id of deleted) rmSync(join(repo, 'backlog', `${100 + ids.indexOf(id)}-t.md`));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'merge']);
    const merge = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', 'refs/heads/main', merge]);
    git(repo, ['remote', 'add', 'origin', repo]);
    const recorded = { pr: 7, batchRef: 'lane/b', headSha, members: ids.map(cardId => ({ cardId })) };
    const gh = async () => JSON.stringify({ number: 7, state: 'MERGED', headRefName: 'lane/b', mergeCommit: { oid: merge } });
    return { repo, recorded, gh };
  }
  function harness(f, catFile) {
    const calls = { show: 0, spawn: 0 };
    const gitRun = async args => {
      if (args[0] === 'show') calls.show++;
      try { return execFileSync('git', args, { cwd: f.repo, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { throw error; }
    };
    const counting = (dir, specs) => { calls.spawn++; return catFile(dir, specs); };
    return { calls, run: () => batchIO.provenMergedLanding(f.recorded, { repo: 'o/r', gh: f.gh, git: gitRun, catFile: counting }) };
  }
  // The old reader: every blob is "missing" to cat-file, so each one is read by `git show`, as before.
  const oldReader = (dir, specs) => Buffer.from(specs.map(spec => `${spec} missing\n`).join(''));
  const scenarios = {
    proven: {},
    changedContent: { landed: { bbb: card('bbb', 'bornAs: bbb\n') + 'tampered\n' } },
    deletedPath: { deleted: ['ccc'] },
    binaryBytes: { landed: { aaa: Buffer.concat([Buffer.from(card('aaa', 'bornAs: aaa\n')), Buffer.from([0xff, 0xfe, 0x00, 0x80])]) } },
  };
  for (const [name, spec] of Object.entries(scenarios)) {
    it(`gives the old verdict for ${name}, with one spawn instead of N shows`, async () => {
      const f = landing(spec);
      const before = harness(f, oldReader);
      const after = harness(f, batchIO.catFileBatch);
      const [oldVerdict, newVerdict] = [await before.run(), await after.run()];
      expect(newVerdict).toEqual(oldVerdict);
      expect(before.calls.show).toBeGreaterThan(3);
      expect(after.calls.show).toBe(0);
      expect(after.calls.spawn).toBe(1);
      if (name === 'proven') expect(newVerdict).toEqual([]);
      else expect(newVerdict.length).toBeGreaterThan(0);
    });
  }
  it('treats a recorded path missing from the recorded head the same as before (not proven)', async () => {
    const f = landing();
    f.recorded.members.push({ cardId: 'zzz' });
    const after = harness(f, batchIO.catFileBatch);
    expect(await after.run()).toEqual(['zzz']);
  });
  it('refuses blobs over the old 16 MiB limit (falls back to git show)', () => {
    const big = Buffer.alloc(16 * 1024 * 1024 + 1, 97);
    const raw = Buffer.concat([Buffer.from(`${'c'.repeat(40)} blob ${big.length}\n`), big, Buffer.from('\n')]);
    expect(batchIO.parseCatFileBatch(raw, ['x']).get('x')).toBeNull();
  });
  it('gives cat-file a 30 s deadline, and keeps control-character specs off the batch protocol', async () => {
    let options;
    batchIO.catFileBatch('/nope', ['a:b'], (cmd, args, opts) => { options = opts; return { status: 0, stdout: Buffer.alloc(0) }; });
    expect(options.timeout).toBe(30_000);
    const f = landing();
    const seen = [];
    const run = (members, catFile) => batchIO.provenMergedLanding({ ...f.recorded, members }, { repo: 'o/r', gh: f.gh,
      git: async args => execFileSync('git', args, { cwd: f.repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
      catFile: (dir, specs) => { seen.push(...specs); return catFile(dir, specs); } });
    await run(f.recorded.members, batchIO.catFileBatch);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(spec => /[\x00-\x1f\x7f]/.test(spec))).toBe(false);
  });
  it('fails closed when cat-file fails or its output is malformed', async () => {
    const f = landing();
    await expect(harness(f, () => { throw new Error('boom'); }).run()).rejects.toThrow('boom');
    await expect(harness(f, () => Buffer.from('garbage\n')).run()).rejects.toThrow(/cat-file/);
    expect(() => batchIO.parseCatFileBatch(Buffer.from('a'.repeat(40) + ' blob 9\nshort\n'), ['x'])).toThrow(/framing|truncated/);
  });
  it('recomputes the proof on every call: nothing is cached or stored', async () => {
    const f = landing();
    let spawns = 0;
    const run = () => batchIO.provenMergedLanding(f.recorded, { repo: 'o/r', gh: f.gh,
      git: async args => execFileSync('git', args, { cwd: f.repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
      catFile: (dir, specs) => { spawns++; return batchIO.catFileBatch(dir, specs); } });
    expect(await run()).toEqual([]);
    expect(await run()).toEqual([]);
    expect(spawns).toBe(2);
    expect(await run()).toEqual([]);
    expect(spawns).toBe(3);
});
});
