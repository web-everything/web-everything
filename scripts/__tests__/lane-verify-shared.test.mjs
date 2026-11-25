// VERIFY-MARKER-PER-SHA: a green marker written in lane A is honoured in lane B at the same sha and tree.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSharedVerifyMarker, readSharedVerifyMarker, resolveMarkerWithShared, verifyGateDecision, readVerifyMarker,
} from '../lib/lane-verify.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'tree-1';
const repo = 'acme/widgets';
const green = { sha: SHA, status: 'green', treeHash: TREE, suites: 'gate', exitCode: 0, finishedAt: '2026-11-25T10:00:00Z' };
const dir = () => mkdtempSync(join(tmpdir(), 'verify-shared-'));
const gate = (record) => verifyGateDecision({ record, headSha: SHA, requireVerified: true });

describe('shared verify marker', () => {
  it('a green marker written in lane A is honoured in lane B at the same sha and tree', () => {
    const d = dir();
    expect(writeSharedVerifyMarker({ dir: d, repo, record: green, lane: 'lane-2' })).toBe(true);
    // lane B has no local marker at all
    const local = readVerifyMarker(mkdtempSync(join(tmpdir(), 'laneb-')));
    expect(local).toBeNull();
    const rec = resolveMarkerWithShared({ local, headSha: SHA, readShared: () => readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: TREE }) });
    expect(rec.sharedFrom.lane).toBe('lane-2');
    expect(gate(rec).ok).toBe(true);
    expect(statSync(join(d, 'acme__widgets', 'default', `${SHA}.json`)).mode & 0o777).toBe(0o600);
  });

  it('refuses a sha that was never verified', () => {
    const d = dir();
    const rec = resolveMarkerWithShared({ local: null, headSha: SHA, readShared: () => readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: TREE }) });
    expect(gate(rec).ok).toBe(false);
  });

  it('refuses when the tree hash differs at the same sha', () => {
    const d = dir();
    writeSharedVerifyMarker({ dir: d, repo, record: green });
    const rec = readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: 'dirty' });
    expect(gate(rec).ok).toBe(false);
    expect(gate(readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: null })).ok).toBe(false);
  });

  it('refuses a marker for another repo or gate', () => {
    const d = dir();
    writeSharedVerifyMarker({ dir: d, repo, record: green });
    expect(readSharedVerifyMarker({ dir: d, repo: 'acme/other', sha: SHA, treeHash: TREE })).toBeNull();
    expect(readSharedVerifyMarker({ dir: d, repo, gate: 'custom', sha: SHA, treeHash: TREE })).toBeNull();
  });

  it('refuses a running, unreadable or foreign-owned shared marker', () => {
    const d = dir();
    writeSharedVerifyMarker({ dir: d, repo, record: { ...green, status: 'running' } });
    expect(gate(readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: TREE })).ok).toBe(false);
    const d2 = dir();
    mkdirSync(join(d2, 'acme__widgets', 'default'), { recursive: true });
    writeFileSync(join(d2, 'acme__widgets', 'default', `${SHA}.json`), '{torn');
    expect(readSharedVerifyMarker({ dir: d2, repo, sha: SHA, treeHash: TREE })).toEqual({ corrupt: true });
    const d3 = dir();
    writeSharedVerifyMarker({ dir: d3, repo, record: green });
    expect(readSharedVerifyMarker({ dir: d3, repo, sha: SHA, treeHash: TREE, uid: 999999 })).toEqual({ corrupt: true });
  });

  it('refuses a malformed sha key', () => {
    expect(writeSharedVerifyMarker({ dir: dir(), repo, record: { ...green, sha: '../x' } })).toBe(false);
  });
});
