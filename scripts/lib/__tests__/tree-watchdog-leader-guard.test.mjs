// The watchdog sweeps orphans of its own process group only when its process LEADS that group. The native
// non-leader test in verify-lane.test.mjs proves this only where init reaps orphans (macOS): under a Linux
// subreaper (Forge) an orphan never has ppid 1, so the sweep never targets it there. This synthetic process map
// is platform-independent: removing the leader guard in fireTreeKill fails it everywhere (Codex audit of #6141).
import { describe, it, expect } from 'vitest';
import { fireTreeKill } from '../tree-watchdog.mjs';
import { killProcessTree } from '../bounded-child.mjs';

// Group 77: 10 is the hung phase (child of the caller), 11 its child, 40 an unrelated member reparented to init.
const PS = ['77 1 77', '50 77 77', '10 50 77', '11 10 77', '40 1 77'].join('\n');

function fire({ selfPid, orphansOfOwnGroup = true }) {
  const sent = [];
  const flag = new Int32Array(new SharedArrayBuffer(4));
  fireTreeKill({
    pid: 10, flag, kill: { orphansOfOwnGroup }, ownGroup: () => 77, selfPid,
    killTree: (pid, signal, options) => killProcessTree(pid, signal, {
      ...options, selfPid, listProcesses: () => PS, listMarked: () => [], listPeerHolders: () => [],
      kill: (target) => sent.push(target),
    }),
  });
  return { sent, flag: flag[0] };
}

describe('tree watchdog leader guard', () => {
  it('a non-leader never sweeps a ppid-1 member of the group it merely belongs to', () => {
    expect(fire({ selfPid: 50 })).toEqual({ sent: [11, 10], flag: 2 });
  });
  it('the group leader sweeps the ppid-1 orphan of its own group', () => {
    expect(fire({ selfPid: 77 })).toEqual({ sent: [40, 11, 10], flag: 2 });
  });
  it('without orphansOfOwnGroup even the leader kills only the tree', () => {
    expect(fire({ selfPid: 77, orphansOfOwnGroup: false })).toEqual({ sent: [11, 10], flag: 2 });
  });
});
