/**
 * @file backlog-ops-integration.test.mjs — `claim`, `scaffold` and `resolve` against REAL git and REAL fs.
 *
 * THE THREE CARD OPERATIONS SHARE ONE SHAPE: read some facts off a checkout, compute new bytes in a pure
 * plan, write them through `we:scripts/backlog/guarded-write.mjs`. Their existing suites
 * (`./claim-io.test.mjs`, `./scaffold-io.test.mjs`, `./resolve.test.mjs`) inject `listFiles`, `readText` and
 * `exec`, which is right for the plans and leaves two things unwitnessed:
 *
 *   1. THE GIT READS. `claim`'s dirty-file probe and `resolve`'s scope reconciliation are argv strings until
 *      a real repo answers them. `resolve`'s own docblock records that one of these was already shipped
 *      SILENTLY INERT once — `repoKeyFromSlug` takes an `owner/name` slug and never strips `.git`, so a raw
 *      remote URL keyed as `name.git`, nothing matched, and the guard reported clean forever. That is a
 *      property of a real `git remote get-url origin`, and only a real one can hold it.
 *
 *   2. THE WRITE GATES. `writeBacklogMd` refuses rather than warns — the #3015 secret scrub and the #883
 *      locus-prefix scan — and `scaffold-io.mjs`'s header records those firing three times in one day, each
 *      time fail-closed with nothing written. "Nothing written" is a claim about a filesystem.
 *
 * So the io shells here run with their REAL defaults and the assertions are on disk and on git.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClaimReader, createClaimSinks } from '../claim-io.mjs';
import { CLAIM_EFFECT } from '../claim.mjs';
import { createScaffoldReader, createScaffoldSinks } from '../scaffold-io.mjs';
import { SCAFFOLD_EFFECT } from '../scaffold.mjs';
import { observedFilesForResolve } from '../resolve-io.mjs';
import { DEFAULT_BRANCH, withBareOrigin, withRealRepo } from './helpers/real-repo.mjs';

const CARD = (id, status = 'open') => `---\nkind: task\nsize: 1\nstatus: ${status}\ndateOpened: "2026-08-01"\n---\n\n# Card ${id}\n\nA card body with no repo paths in it.\n`;

/** A real checkout with a real `backlog/` in it. */
async function withBacklog(fn) {
  return withRealRepo(async (ctx) => {
    ctx.commit({ 'backlog/042-example.md': CARD('042'), 'backlog/099-other.md': CARD('099') }, 'backlog: two cards');
    return fn(ctx);
  });
}

describe('claim — the dirty-file probe against a real `git status`', () => {
  /** The baseline: a committed, unmodified card is not dirty. Stated so the interesting cases below have
   *  something to be different from. */
  it('a clean card reads as not dirty', async () => {
    await withBacklog(async (ctx) => {
      const read = createClaimReader({ root: ctx.root });
      expect(read({ ref: '042' })).toMatchObject({ found: true, id: '042', status: 'open', dirty: false });
    });
  });

  it('an edited card reads as dirty', async () => {
    await withBacklog(async (ctx) => {
      writeFileSync(join(ctx.root, 'backlog', '042-example.md'), CARD('042', 'active'));
      expect(createClaimReader({ root: ctx.root })({ ref: '042' }).dirty).toBe(true);
    });
  });

  /**
   * ★ THE PATHSPEC IS THE POINT. The probe is `git status --porcelain -- <rel>`, SCOPED to the one card. Drop
   * the `-- rel` and every claim in a checkout with any uncommitted change anywhere — which is nearly every
   * lane, all the time — reads as dirty and is refused.
   *
   * A stubbed `exec` cannot tell the two apart: it returns whatever the test author decided, so the scoping
   * is an argv assertion at best. Here git decides. Removing the pathspec reddens this test.
   */
  it('another file being dirty does NOT make the card dirty', async () => {
    await withBacklog(async (ctx) => {
      writeFileSync(join(ctx.root, 'README.md'), '# edited elsewhere\n');
      mkdirSync(join(ctx.root, 'src'), { recursive: true });
      writeFileSync(join(ctx.root, 'src', 'untracked.ts'), 'x\n');
      expect(ctx.git(['status', '--porcelain']).trim()).not.toBe(''); // the tree really IS dirty

      expect(createClaimReader({ root: ctx.root })({ ref: '042' }).dirty).toBe(false);
    });
  });

  /**
   * BEST-EFFORT MEANS BEST-EFFORT. `we:scripts/backlog.mjs` swallows a git failure here rather than blocking
   * a claim, and this reaches that branch with a real failure — a directory that is genuinely not a git
   * checkout — rather than by throwing from a stub, which only proves the `catch` exists.
   */
  it('a directory that is not a git checkout reads as clean, and never throws', async () => {
    await withRealRepo(async (ctx) => {
      const bare = join(ctx.tmp, 'not-a-repo');
      mkdirSync(join(bare, 'backlog'), { recursive: true });
      writeFileSync(join(bare, 'backlog', '042-example.md'), CARD('042'));

      expect(createClaimReader({ root: bare })({ ref: '042' })).toMatchObject({ found: true, dirty: false });
    });
});

describe('claim + scaffold — the guarded write, on a real filesystem', () => {
  it('claim\'s sink puts the exact planned bytes on disk', async () => {
    await withBacklog(async (ctx) => {
      const abs = join(ctx.root, 'backlog', '042-example.md');
      const content = CARD('042', 'active');

      const out = await createClaimSinks({ root: ctx.root })[CLAIM_EFFECT]({ abs, rel: 'backlog/042-example.md', content });

      expect(out).toEqual({ abs, rel: 'backlog/042-example.md' });
      expect(readFileSync(abs, 'utf8')).toBe(content);
      expect(ctx.git(['status', '--porcelain']).trim()).toBe('M  backlog/042-example.md'.replace('M  ', 'M '));
    });
  });

  /**
   * ★ FAIL-CLOSED MEANS NOTHING ON DISK. The #883 locus scan refuses a card whose body names a repo path
   * without its `we:` prefix. `scaffold-io.mjs`'s header records this firing three times in one day — and the
   * value of the refusal is entirely in the second half of the sentence: *with nothing written*. A writer
   * that threw AFTER writing would leave a card the gate rejects minutes later, which is the failure it
   * replaces.
   *
   * Only a real filesystem can answer "was anything written". Moving `assertPublishableContent` to after the
   * `writeFileSync` in `we:scripts/backlog/guarded-write.mjs` leaves the throw intact and reddens this.
   */
  it('refuses an unprefixed repo path and leaves NO file behind (#883)', async () => {
    await withBacklog(async (ctx) => {
      const abs = join(ctx.root, 'backlog', '777-new.md');
      const rel = 'backlog/777-new.md';
      const bad = `${CARD('777')}\nSee scripts/operations/claim-io.mjs for the shell.\n`;

      await expect(createScaffoldSinks({ root: ctx.root })[SCAFFOLD_EFFECT]({ abs, rel, content: bad }))
        .rejects.toThrow();

      expect(existsSync(abs)).toBe(false);
    });
  });

  /** The same content WITH the prefix is accepted — so the test above is pinning the rule, not merely that
   *  something threw. */
  it('the same body with a `we:` locus prefix is written', async () => {
    await withBacklog(async (ctx) => {
      const abs = join(ctx.root, 'backlog', '778-new.md');
      const rel = 'backlog/778-new.md';
      const good = `${CARD('778')}\nSee we:scripts/operations/claim-io.mjs for the shell.\n`;

      const out = await createScaffoldSinks({ root: ctx.root })[SCAFFOLD_EFFECT]({ abs, rel, content: good });

      expect(out).toEqual({ rel, written: true });
      expect(readFileSync(abs, 'utf8')).toBe(good);
    });
  });

  /** `scaffold`'s reader is the allocator's ENTIRE input, read off a real directory. Resolved cards count
   *  too — filtering to open items would let the allocator hand back an id a resolved card already owns. */
  it('scaffold\'s reader reads every existing id off a real backlog directory', async () => {
    await withBacklog(async (ctx) => {
      writeFileSync(join(ctx.root, 'backlog', '150-done.md'), CARD('150', 'resolved'));
      writeFileSync(join(ctx.root, 'backlog', 'README.txt'), 'not a card\n');

      const ctxRead = createScaffoldReader({ root: ctx.root })();

      expect(ctxRead.existingIds.sort()).toEqual(['042', '099', '150']);
      expect(ctxRead.dir).toBe(join(ctx.root, 'backlog'));
    });
  });
});

describe('resolve — the scope reconciliation\'s git reads, for real (#2803)', () => {
  /**
   * Build a lane: `origin/main` moves on AFTER the branch point, so the merge-base and the current
   * `origin/main` are genuinely different commits. Without that divergence every candidate implementation of
   * "what did this lane change" agrees, and the test proves nothing.
   */
  function buildLane(ctx) {
    ctx.git(['checkout', '--quiet', '-b', 'lane/3299-thing']);
    ctx.commit({ 'scripts/operations/thing.mjs': 'export const thing = 1;\n' }, 'feat: the lane\'s committed change');
    // Upstream moves on, on a branch this lane will never contain.
    ctx.seedOriginBranch(DEFAULT_BRANCH, { 'docs/upstream.md': 'landed after the lane branched\n' });
    ctx.git(['fetch', '--quiet', 'origin', DEFAULT_BRANCH, '--update-head-ok']);
    ctx.git(['fetch', '--quiet', 'origin', `+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`]);
  }

  /**
   * ★ THE SILENT-INERTNESS BUG, as a live check. `observedFilesForResolve` reads the origin URL, strips
   * `.git`, and turns `web-everything/web-everything` into the repo key `we` — which is what makes the observed
   * paths comparable to a card's `we:`-qualified `scope:` list.
   *
   * Remove `(?:\.git)?$` from the slug regex and the key becomes `web-everything.git`, every observed path is
   * qualified `web-everything.git:…`, nothing ever matches a declared entry, and the guard reports CLEAN
   * FOREVER. Nothing throws and nothing looks wrong. The fixture's origin is a directory path ending in
   * `.git`, exactly as a real clone's is, so the strip is genuinely exercised. Verified: the removal reddens
   * this test and nothing else.
   */
  it('qualifies observed paths with the `we:` key derived from a real origin URL', async () => {
    await withBareOrigin(async (ctx) => {
      buildLane(ctx);

      const observed = observedFilesForResolve({ root: ctx.clone, exec: execFileSync });

      expect(observed).toContain('we:scripts/operations/thing.mjs');
      expect(observed.every((p) => p.startsWith('we:'))).toBe(true);
    });
  });

  /**
   * THE BASIS IS THE MERGE-BASE, NOT `origin/main`. Diffing against the current `origin/main` folds every
   * commit that landed upstream after the branch point into the lane's "observed" set — and the scope-drift
   * guard would then accuse the lane of touching files it has never seen. This is only visible when the two
   * differ, which `buildLane` arranges.
   */
  it('excludes what landed upstream after the branch point', async () => {
    await withBareOrigin(async (ctx) => {
      buildLane(ctx);
      // The divergence is real: origin/main carries a file this lane's history does not.
      expect(ctx.git(['ls-tree', '--name-only', `origin/${DEFAULT_BRANCH}`, '--', 'docs/upstream.md']).trim()).toBe('docs/upstream.md');

      const observed = observedFilesForResolve({ root: ctx.clone, exec: execFileSync });

      expect(observed).not.toContain('we:docs/upstream.md');
    });
  });

  /** UNCOMMITTED work counts too — a lane is judged on what it has DONE, not only on what it has committed,
   *  and `resolve` runs while the tree is still open. Read off a real `git status --porcelain`. */
  it('includes uncommitted and untracked work alongside the committed diff', async () => {
    await withBareOrigin(async (ctx) => {
      buildLane(ctx);
      writeFileSync(join(ctx.clone, 'scripts', 'operations', 'untracked.mjs'), 'export const u = 1;\n');
      writeFileSync(join(ctx.clone, 'README.md'), '# edited in the working tree\n');

      const observed = observedFilesForResolve({ root: ctx.clone, exec: execFileSync });

      expect(observed).toContain('we:scripts/operations/untracked.mjs');
      expect(observed).toContain('we:README.md');
      expect(observed).toContain('we:scripts/operations/thing.mjs');
    });
  });

  /**
   * A REAL-GIT WRINKLE WORTH PINNING, found by running this against git rather than reasoning about it:
   * `git status --porcelain` COLLAPSES a wholly-untracked directory to a single `?? blocks/` entry, so the
   * observed set carries a DIRECTORY, never the files inside it. Anything downstream that compares observed
   * paths to a declared `scope:` by exact match will not see `blocks/new-block.ts` at all.
   *
   * Recorded as behaviour rather than filed as a defect: `we:scripts/readiness/scope-reconcile.mjs` decides
   * whether a trailing-slash prefix counts as a match, and that judgement is not this file's to make. What
   * this test guarantees is that the shape stops being a surprise — if git or the collector ever changes it,
   * this is where it surfaces.
   */
  it('an entirely-new directory arrives collapsed, as git reports it', async () => {
    await withBareOrigin(async (ctx) => {
      buildLane(ctx);
      mkdirSync(join(ctx.clone, 'blocks'), { recursive: true });
      writeFileSync(join(ctx.clone, 'blocks', 'new-block.ts'), 'export const b = 1;\n');

      const observed = observedFilesForResolve({ root: ctx.clone, exec: execFileSync });

      expect(observed).toContain('we:blocks/');
      expect(observed).not.toContain('we:blocks/new-block.ts');
    });
  });

  /**
   * THE REFUSAL, driven through the `exec` SEAM — because real git cannot reach it, and this file should say
   * so rather than pretend otherwise.
   *
   * `observedFilesForResolve` throws instead of returning an empty set when the origin yields no repo key,
   * and `createResolveReader` turns that throw into `scopeDeclared: false` — "could not check", which is a
   * DIFFERENT answer from "checked clean". Collapsing the two is the bug that made #2803's guard inert once
   * already, so the branch is worth pinning.
   *
   * WHY NOT WITH A REAL REMOTE. `repoKeyFromSlug` returns null only for a falsy slug, and the slug is only
   * falsy when `git remote get-url origin` prints nothing — which git never does for a defined remote:
   *   · `set-url origin ''` is REFUSED by git >= 2.55 (it is tolerated by 2.43, which is the ONLY reason the
   *     first version of this test passed locally while failing on the runner);
   *   · `git config --unset remote.origin.url` leaves `get-url` printing the remote's NAME, `origin`, which
   *     is a perfectly good non-empty slug.
   * So `!repoKey` is a DEFENSIVE branch, unreachable through a real remote today. Pinning it through the seam
   * is honest; pinning it through a git quirk that one version happens to allow is how the first version of
   * this test managed to be green locally and red in CI while testing neither thing.
   */
  it('throws rather than answering when the origin yields no repo key', () => {
    const exec = (_cmd, args) => (args[0] === 'remote' ? '' : 'unused');
    expect(() => observedFilesForResolve({ root: '/anywhere', exec })).toThrow(/yields no repo key/);
  });
  });
});
