/**
 * git-run.mjs — the ONE git runner for the drain's index-writing plumbing, plus the blob-identity primitives
 * that make "the drain staged something other than what it computed" impossible instead of merely unlikely.
 *
 * WHY THIS FILE EXISTS (#2923). Three modules used to export their own function literally named `gitRunner`,
 * each accepting a DIFFERENT subset of the options its peers pass:
 *
 *   rebase-drop-manifest.mjs  (cmd, args, { env, cwd })                  — no `input`, no `encoding`
 *   nnn-collision-heal.mjs    (cmd, args, { env, input })                — no `cwd`,   no `encoding`
 *   rebase-drop-content.mjs   (cmd, args, { env, input, cwd, encoding }) — the full contract
 *
 * `scripts/merge-ai-prs.mjs` imported the FIRST one and injected it as the `run` of libraries that need the
 * THIRD. Destructuring silently discards what it does not name, so `{ input: mergedText }` evaporated on the
 * way to `git hash-object -w --stdin`. Git then read EOF on an empty stdin, hashed the empty string, **exited
 * 0**, and printed `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` — the empty blob. Every `status !== 0` check
 * passed, `update-index --cacheinfo` staged the empty blob, and the drain committed and reported success. The
 * conflicted file landed at ZERO BYTES with a commit message claiming it had been auto-resolved.
 *
 * That fired at least three times: `836ae978` (backlog/2909, the reported case), `70bffbb8` (backlog/2895),
 * and — through the renumber path, `writePlanToIndex` — `adf2d758`, which reached `main` and had to be
 * hand-repaired by `14432ba9` ("restore #2309 story content emptied by the #2362->#2309 renumber"). Every one
 * was caught only because the emptied file happened to be a backlog card, the one content type with a schema
 * validator. A doc or source file emptied the same way has no such tripwire and lands silently.
 *
 * So this module fixes it at BOTH levels:
 *   1. ONE runner (`gitRun`) with ONE contract, re-exported as `gitRunner` by all three modules — there is no
 *      longer a weaker same-named function for a caller to inject by accident.
 *   2. Content-addressed VERIFICATION (`gitBlobOid` / `hashObjectVerified`) — the expected object id is
 *      computed IN PROCESS from the bytes we intended to write, with no git involved, and compared to what
 *      git actually returned. Any runner that drops, truncates, re-encodes or mangles stdin is caught at the
 *      write, before anything is staged. This holds even if some future caller injects a broken `run` again:
 *      the guarantee no longer depends on the runner being correct, only on it being CHECKED.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Git's empty blob — the fingerprint of the #2923 data loss. */
export const EMPTY_BLOB_OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const envTimeoutMs = Number(process.env.WE_GIT_RUN_TIMEOUT_MS);
/** Bound synchronous git calls so one hung process cannot freeze an entire sweep. */
export const GIT_RUN_TIMEOUT_MS = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 180000;

/**
 * The canonical git runner. `spawnSync` (NOT execFileSync) so a non-zero exit — `merge-tree` on conflict is
 * exit 1, expected — is RETURNED, not thrown.
 *   `opts.env`      merged over `process.env` (carries `GIT_INDEX_FILE` for the temp-index pattern).
 *   `opts.inheritEnv` false uses the exact supplied environment (credential-pinned recovery pushes).
 *   `opts.input`    stdin — required by `git hash-object --stdin`. Dropping this is exactly #2923.
 *   `opts.cwd`      run in a SIBLING clone instead of `process.cwd()` (#2263).
 *   `opts.encoding` `'buffer'` returns `stdout` as raw bytes (never utf8-decoded) — required to read blob
 *                   content byte-exact so non-UTF-8 blobs are detected, not lossily coerced to U+FFFD.
 *   `opts.timeoutMs` maximum runtime in milliseconds (defaults to `GIT_RUN_TIMEOUT_MS`).
 */
export function gitRun(cmd, args, { env, input, cwd, encoding = 'utf8', inheritEnv = true, timeoutMs = GIT_RUN_TIMEOUT_MS } = {}) {
  const r = spawnSync(cmd, args, { encoding, input, timeout: timeoutMs, killSignal: 'SIGKILL', env: inheritEnv ? (env ? { ...process.env, ...env } : process.env) : env, ...(cwd ? { cwd } : {}) });
  const empty = encoding === 'buffer' ? Buffer.alloc(0) : '';
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal && r.status == null);
  const stderr = r.stderr == null ? '' : String(r.stderr);
  return {
    status: timedOut || r.status == null ? 1 : r.status,
    stdout: r.stdout ?? empty,
    stderr: timedOut ? `git timed out after ${timeoutMs}ms (${args[0]})${stderr ? `\n${stderr}` : ''}` : stderr,
  };
}

/**
 * The git object id of `content` as a blob, computed IN PROCESS — `sha1("blob <byteLength>\0" + bytes)`, which
 * is git's object-hash definition. Pure, no subprocess: that is the point. It is the independent witness the
 * write-back path checks `git hash-object`'s answer against, so a runner that never delivered the bytes cannot
 * also vouch for them.
 * @param {string|Buffer} content
 * @param {'sha1'|'sha256'} [algorithm] the repository's object format (see `blobOidLike`).
 */
export function gitBlobOid(content, algorithm = 'sha1') {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  return createHash(algorithm).update(`blob ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
}

/**
 * `gitBlobOid` in whichever object format `likeOid` is written in — so verification works in a `sha256` repo
 * (64 hex chars) as well as the default `sha1` (40). Without this, a sha256 repo would fail every comparison
 * and turn the guard into a permanent false alarm.
 */
export function blobOidLike(content, likeOid) {
  return gitBlobOid(content, String(likeOid || '').length === 64 ? 'sha256' : 'sha1');
}

/**
 * Write `text` to the object store and PROVE the object store received it. The whole #2923 fix in one call:
 * hash the bytes ourselves first, then require `git hash-object -w --stdin` to return that exact id. An
 * injected runner that swallows stdin yields `EMPTY_BLOB_OID` with exit 0 — indistinguishable from success by
 * status alone, and caught here by identity.
 *
 * @param {(cmd:string,args:string[],opts?:object)=>{status:number,stdout:string,stderr:string}} run
 * @param {string} text                the exact content that must end up in the object store
 * @param {object} [o]
 * @param {object} [o.env]             merged env (e.g. `GIT_INDEX_FILE`)
 * @param {string} [o.cwd]
 * @param {string} [o.label='blob']    what this content is, for the error message
 * @returns {{ok:true, oid:string}|{ok:false, reason:string}}
 */
export function hashObjectVerified(run, text, { env, cwd, label = 'blob' } = {}) {
  const ho = run('git', ['hash-object', '-w', '--stdin'], { env, cwd, input: text });
  const oid = String(ho.stdout || '').trim();
  if (ho.status !== 0 || !oid) {
    return { ok: false, reason: `hash-object ${label} failed (${String(ho.stderr || '').split('\n')[0]})` };
  }
  const expected = blobOidLike(text, oid);
  if (oid !== expected) {
    const wasEmptied = oid === EMPTY_BLOB_OID && String(text ?? '') !== '';
    return {
      ok: false,
      reason: `hash-object ${label} wrote ${oid} but the ${Buffer.byteLength(String(text ?? ''), 'utf8')}-byte content hashes to ${expected}`
        + (wasEmptied ? ' — git received EMPTY stdin (the injected runner dropped `input`); refusing to stage a zero-byte blob (#2923)' : ' — the content was altered in transit; refusing to stage it (#2923)'),
    };
  }
  return { ok: true, oid };
}

/**
 * Confirm a tree really carries `expectedOid` at `path` — the SECOND half of the verification, after
 * `write-tree`. `hashObjectVerified` proves the right bytes reached the object store; this proves the right
 * object reached the TREE we are about to commit. It closes the remaining gap: a staged path that differs
 * from the written path, or an `update-index` that silently did not take.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function verifyTreeBlob(run, tree, path, expectedOid, { cwd } = {}) {
  const ls = run('git', ['ls-tree', '-z', tree, '--', path], { cwd });
  if (ls.status !== 0) return { ok: false, reason: `ls-tree ${path} failed (${String(ls.stderr || '').split('\n')[0]})` };
  const entry = String(ls.stdout || '').split('\0')[0] || '';
  const m = entry.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t/);
  if (!m) return { ok: false, reason: `resolved tree has no entry for ${path} — the write-back staged a different path (#2923)` };
  if (m[3] !== expectedOid) {
    return { ok: false, reason: `resolved tree carries ${m[3]} at ${path}, expected ${expectedOid}${m[3] === EMPTY_BLOB_OID ? ' (git\'s EMPTY blob — content was destroyed on the way to the index)' : ''} (#2923)` };
  }
  return { ok: true };
}

/**
 * Pure decision over `git rev-parse --is-shallow-repository`'s raw result. Returns `true`/`false`, or `null`
 * when the probe itself is inconclusive (non-zero exit, unparseable stdout) — mirrors
 * `we:scripts/lane-pool.mjs`'s own `isShallowClone` fail-open direction: an unreadable answer is read as "not
 * proven shallow", never as license to loop an unshallow attempt forever on a broken git binary.
 */
export function parseIsShallow(stdout, status) {
  if (Number(status) !== 0) return null;
  const s = String(stdout || '').trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/**
 * Ensure `cwd`'s checkout has full history before a `git merge-tree` (or `merge-base`) call that must walk back
 * to a real common ancestor. THE LIVE INCIDENT THIS CLOSES: `we:scripts/lib/rebase-drop-manifest.mjs#
 * rebaseDropManifest` fetches only the ONE lane ref it needs (`git fetch <remote> <laneRef>`) before probing
 * `git merge-tree --write-tree <base> <laneRef>`. In a checkout that is ALREADY a shallow clone, fetching a
 * BRAND-NEW ref inherits that shallow boundary by default — the newly-fetched ref lands as its own grafted ROOT
 * commit with NO recorded parents, even though the real remote history connects it to `<base>` just fine.
 * `git merge-tree` then finds no common ancestor at all and fails `fatal: refusing to merge unrelated
 * histories` — indistinguishable, by that message alone, from two branches that truly share no history. This
 * was LIVE-REPRODUCED (read-only) against PR #2752 (`lane/4034-critical-work-gate`, head `8e1f0c23d`) in the
 * `wev-review-daemon` checkout: `.git/shallow` named that exact head sha as a shallow boundary (zero parents),
 * while `origin/main` in the SAME checkout was fully deepened — so only a merge against that one ref broke, and
 * only there. See backlog write-up for the full before/after.
 *
 * `git fetch <remote> --unshallow` is idempotent (a harmless non-zero exit on an already-full checkout, which
 * this function ignores) and removes EVERY shallow boundary in the checkout — the fix that actually stops this
 * from recurring, since deepening one ref at a time would just move the identical failure to the next
 * newly-fetched branch.
 * @param {(cmd:string,args:string[],opts?:object)=>{status:number,stdout:string,stderr:string}} run
 * @param {{cwd?:string, remote?:string}} [o]
 * @returns {{ok:true, wasShallow:boolean, unshallowed:boolean}|{ok:false, wasShallow:true, reason:string}}
 */
export function ensureFullHistory(run, { cwd, remote = 'origin' } = {}) {
  const probe = run('git', ['rev-parse', '--is-shallow-repository'], { cwd });
  const isShallow = parseIsShallow(probe.stdout, probe.status);
  if (isShallow !== true) return { ok: true, wasShallow: false, unshallowed: false };
  const uns = run('git', ['fetch', remote, '--unshallow', '--quiet'], { cwd });
  if (uns.status !== 0) {
    return { ok: false, wasShallow: true, reason: `fetch --unshallow failed (${String(uns.stderr || '').split('\n')[0]})` };
  }
  return { ok: true, wasShallow: true, unshallowed: true };
}
