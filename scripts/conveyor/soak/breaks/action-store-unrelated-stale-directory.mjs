/** A stale action for another resource must not stop claims, or bypass this resource's history. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Execute the supplied checkout, including during historical red/green replay. Never inspect source markers.
export function probe(checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'action-store-stale-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { strictEqual, throws } from 'node:assert';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [checkout, dir, repo] = process.argv.slice(1);
      const { createActionStore, CoordinationUnavailableError } = await import(
        pathToFileURL(join(checkout, 'scripts/operations/action-store.mjs')));
      const resource = repo + '#pr:2345';
      const other = repo + '#pr:7';
      const alias = 'chalbert/web-everything#pr:2345';
      const stale = (store, name) => {
        const path = join(store.dir, name);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'attempt-000001.json'), '');
      };
      // Both canonical corruption and a legacy alias belong only to their own resource.
      [resource, alias].forEach((name, index) => {
        const store = createActionStore({ root: join(dir, 'unrelated-' + index) });
        stale(store, encodeURIComponent(name));
        const claim = () => store.claim({ resource: other, kind: 'fix', owner: 'replay' });
        const first = claim();
        strictEqual(first.ok, true, 'unrelated stale history must allow the claim');
        strictEqual(first.record.attempt, 1);
        strictEqual(store.read(other, 1).ownerToken, first.record.ownerToken);
        strictEqual(claim().ok, false, 'an active claim must still exclude a second owner');
        strictEqual(store.release(other, 1, { token: first.record.ownerToken }).ok, true);
        strictEqual(claim().record.attempt, 2, 'retry must preserve contiguous own-resource history');
        throws(() => store.claim({ resource, kind: 'fix', owner: 'replay' }), CoordinationUnavailableError);
        throws(() => store.list(), CoordinationUnavailableError, 'global enumeration must still fail closed');
      });
      // Unknown names cannot safely be classified as unrelated, even when their directory is empty.
      ['bad%ZZ', 'not-a-resource'].forEach((name, index) => {
        const store = createActionStore({ root: join(dir, 'unknown-' + index) });
        mkdirSync(join(store.dir, name), { recursive: true });
        throws(() => store.claim({ resource, kind: 'fix', owner: 'replay' }), CoordinationUnavailableError);
        strictEqual(store.attempts(resource).length, 0, 'refusal must allocate no attempt');
      });
    `, checkout, dir, ghRepoSlug('we')], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { violations: child.status === 0 ? [] : [
      `resource-scoped stale-directory replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
    ] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'action-store-unrelated-stale-directory',
  title: 'stale unrelated action directories do not block resource claims',
  card: 'PR #7285 coordination resource isolation',
  fixedBy: { sha: 'HEAD', where: 'lane/coordination-noncanonical-tolerance', paths: ['scripts/operations/action-store.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
