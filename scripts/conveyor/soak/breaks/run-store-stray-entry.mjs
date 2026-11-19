/** A run tombstone or stray JSON must never wedge review evidence enumeration. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Execute the target checkout's reader: fix presence is observed behavior, never a source-text marker.
export function probe(checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'run-store-stray-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [checkout, dir] = process.argv.slice(1);
      const { readReviewRunEvidence } = await import(pathToFileURL(join(checkout, 'scripts/conveyor/review-referral-hold.mjs')));
      for (const name of ['review-pr-abc.abandoned.json', 'x y.json', 'review-pr-bad name.json']) {
        writeFileSync(join(dir, name), '{}');
      }
      for (let pass = 0; pass < 2; pass++) {
        const rows = readReviewRunEvidence({ dir, memo: new Map(), persist: false });
        if (!Array.isArray(rows) || rows.length) throw new Error('sidecars became run evidence');
      }
    `, checkout, dir], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WE_UNDER_TEST: '1', WE_DAEMON_EVENTS: join(dir, 'events.jsonl') },
    });
    return { violations: child.status === 0 ? [] : ['review evidence enumeration failed on tombstone/stray entries'] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'run-store-stray-entry',
  title: 'review evidence enumeration tolerates tombstones and stray JSON',
  card: 'run-store invalid-entry enumeration regression',
  fixedBy: { sha: 'HEAD', where: 'main', paths: ['scripts/operations/run-store.mjs', 'scripts/conveyor/review-referral-hold.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
