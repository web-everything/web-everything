import { execFile } from 'node:child_process';

// Callback-shaped injection matches the other async gh readers in scripts/lib.
function readPr({ repo, pr }, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,state'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
  });
}

async function readLive(reader, repo, pr) {
  try {
    const value = await reader({ repo, pr });
    if (!value || typeof value.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(value.headRefOid)
      || typeof value.state !== 'string' || !value.state.trim()) return null;
    return { headRefOid: value.headRefOid.toLowerCase(), state: value.state };
  } catch { return null; }
}

/** Fresh evidence on both sides of one write; post-write races are detected, never undone.
 * io.readPr overrides the reader; io.execFileImpl injects its callback-shaped subprocess port.
 * Unreadable post-write evidence has actualHead undefined in the result and incident.
 */
export async function writeVerdict({ repo, pr, expectedHead, kind, write, io = {} } = {}) {
  if (typeof expectedHead !== 'string' || !/^[0-9a-f]{40}$/.test(expectedHead)) {
    return { ok: false, refused: 'refused-no-expected-head' };
  }
  if (typeof repo !== 'string' || !repo.trim() || !pr
    || !['string', 'number'].includes(typeof pr)
    || typeof kind !== 'string' || !kind.trim() || typeof write !== 'function') {
    return { ok: false, refused: 'refused-bad-input' };
  }
  const reader = io?.readPr ?? (args => readPr(args, io?.execFileImpl));
  const before = await readLive(reader, repo, pr);
  if (!before) return { ok: false, refused: 'unreadable' };
  if (before.state !== 'OPEN') return { ok: false, refused: 'not-open' };
  if (before.headRefOid !== expectedHead) {
    return { ok: false, refused: 'head-moved', actualHead: before.headRefOid };
  }

  const result = await write();
  const after = await readLive(reader, repo, pr);
  const verdictUnderMove = !after || after.headRefOid !== expectedHead || after.state !== 'OPEN';
  if (verdictUnderMove) {
    const actualHead = after?.headRefOid;
    try {
      await io?.recordIncident?.({
        kind: 'verdict-under-move', repo, pr, expectedHead, actualHead, writeKind: kind,
      });
    } catch { /* Detection must not hide a completed write. */ }
    return { ok: true, written: true, result, verdictUnderMove: true, actualHead };
  }
  return { ok: true, written: true, result, verdictUnderMove: false };
}
