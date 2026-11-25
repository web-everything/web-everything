import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghRepoSlug } from '../../constellation-repos.mjs';
import { askPinMoved, raiseOrchestratorAsk } from '../orchestrator-ask.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-ask-')); roots.push(root);
  const file = join(root, 'sub', 'asks.jsonl');
  return { file, env: { WE_ORCHESTRATOR_ASKS_PATH: file } };
}
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sha = (c) => c.repeat(40);

describe('orchestrator asks', () => {
  it('20 ticks past the same pin append exactly one ask', () => {
    const { file, env } = fixture();
    for (let i = 0; i < 20; i++) askPinMoved({ ref: 'lane/x', pr: 7, adopted: sha('a'), newTip: sha(String(i % 10)), env });
    const rows = lines(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'pin-moved', key: `pin-moved:lane/x@${sha('a')}`, repo: ghRepoSlug('we') });
  });

  it('a new pin sha asks again', () => {
    const { file, env } = fixture();
    askPinMoved({ ref: 'lane/x', pr: 7, adopted: sha('a'), newTip: sha('b'), env });
    askPinMoved({ ref: 'lane/x', pr: 7, adopted: sha('c'), newTip: sha('d'), env });
    expect(lines(file)).toHaveLength(2);
  });

  it('an unwritable asks file never throws and reports not ok', () => {
    const { env } = fixture();
    const fs = { read: () => '', mkdir: () => {}, append: () => { throw new Error('EROFS'); } };
    expect(() => raiseOrchestratorAsk({ key: 'k', ask: 'a', env, fs })).not.toThrow();
    expect(raiseOrchestratorAsk({ key: 'k', ask: 'a', env, fs })).toMatchObject({ ok: false });
  });

  it('a failed append is retried on the next tick', () => {
    const { file, env } = fixture();
    let fail = true;
    const fs = { append: (f, d) => { if (fail) { fail = false; throw new Error('once'); } writeFileSync(f, d, { flag: 'a' }); } };
    expect(raiseOrchestratorAsk({ key: 'k', ask: 'a', env, fs })).toMatchObject({ ok: false });
    expect(raiseOrchestratorAsk({ key: 'k', ask: 'a', env, fs })).toMatchObject({ ok: true, asked: true });
    expect(lines(file)).toHaveLength(1);
  });

  it('a truncated last line is skipped and the ask is written on its own line', () => {
    const { file, env } = fixture();
    raiseOrchestratorAsk({ key: 'other', ask: 'a', env });
    writeFileSync(file, '{"key":"k","ask', { flag: 'a' });
    expect(raiseOrchestratorAsk({ key: 'k', ask: 'a', env })).toMatchObject({ asked: true });
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n').filter((l) => l.startsWith('{"at"') && l.includes('"key":"k"'))).toHaveLength(1);
  });

  it('equal timestamps still dedupe by key', () => {
    const { file, env } = fixture();
    const now = () => '2026-11-24T00:00:00.000Z';
    raiseOrchestratorAsk({ key: 'k', ask: 'a', env, now });
    raiseOrchestratorAsk({ key: 'k', ask: 'a', env, now });
    expect(lines(file)).toHaveLength(1);
  });
});
