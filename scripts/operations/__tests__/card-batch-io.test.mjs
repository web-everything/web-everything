// @vitest-environment node
/** Real Git admission probes: remote trees, crash recovery and durable state, with no host repository writes. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
import { admitCard } from '../card-batch-io.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, args, options = {}) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options,
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

describe('durable card batch IO', () => {
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

  it('has no force-push option anywhere in its source', () => {
    expect(readFileSync(new URL('../card-batch-io.mjs', import.meta.url), 'utf8')).not.toContain('--force');
  });
});
