/** Local snapshots for the previous-head push gate; only the explicit one-shot writer reads remote evidence. */
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const CACHED_VERDICT_MAX_BYTES = 256 * 1024;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = v => typeof v === 'string' && /^[a-f\d]{40}$/i.test(v);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function cacheEntryPath({ repo, pr, jobId }, { root = resolveCoordinationRoot() } = {}) {
  const key = typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo) && repoKeyForSlug(repo.toLowerCase());
  if (!key || !Number.isSafeInteger(pr) || pr <= 0 || !Number.isSafeInteger(jobId) || jobId <= 0) throw Error('invalid cache identity');
  return join(root, 'merge-gate-verdict-cache', `${key}--${pr}--${jobId}.json`);
}
export function validCachedVerdict(e, { repo, pr, jobId, headSha, now } = {}) {
  const mismatch = { ok: false, reason: 'mismatch' };
  if (!object(e) || e.v !== 1 || !same(e.repo, repo) || e.pr !== pr || e.jobId !== jobId
    || !Number.isSafeInteger(e.pr) || !Number.isSafeInteger(e.jobId)
    || !sha(headSha) || !sha(e.headSha) || !same(e.headSha, headSha)
    || !sha(e.labelsHead) || !same(e.labelsHead, headSha) || !object(e.verdict)
    || !sha(e.verdict.head_sha) || !same(e.verdict.head_sha, headSha)
    || e.verdict.job_name !== 'merge-gate' || Object.hasOwn(e.verdict, 'error')
    || !Array.isArray(e.labels) || !object(e.freeze)) return mismatch;
  const times = [e.labelsReadAt, e.freezeReadAt].map(t => typeof t === 'string' ? Date.parse(t) : NaN);
  if (!times.every(Number.isFinite) || !Number.isFinite(now)) return mismatch;
  if (times.some(t => now - t > 600_000 || t - now > 60_000)) return { ok: false, reason: 'stale' };
  return { ok: true };
}
export function readMergeGateVerdictCache(subject, options = {}) {
  const disk = options.fs ?? fs;
  let fd;
  try {
    const file = cacheEntryPath(subject, options);
    const stat = disk.statSync(file);
    if (!stat.isFile() || stat.size > CACHED_VERDICT_MAX_BYTES) return { reason: 'unreadable' };
    fd = disk.openSync(file, 'r');
    const opened = disk.fstatSync(fd);
    if (!opened.isFile() || opened.size > CACHED_VERDICT_MAX_BYTES) return { reason: 'unreadable' };
    const buf = Buffer.alloc(CACHED_VERDICT_MAX_BYTES + 1);
    let size = 0, count;
    while (size < buf.length && (count = disk.readSync(fd, buf, size, buf.length - size, null)) > 0) size += count;
    if (size > CACHED_VERDICT_MAX_BYTES) return { reason: 'unreadable' };
    return { entry: JSON.parse(buf.subarray(0, size).toString('utf8')) };
  } catch (e) { return { reason: e.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  finally { if (fd !== undefined) disk.closeSync(fd); }
}
export async function writeOnce(subject, io = {}) {
  const file = cacheEntryPath(subject, { root: io.root ?? resolveCoordinationRoot({ env: io.env }) });
  const disk = io.fs ?? fs, now = io.now ?? Date.now, log = io.log ?? console.error;
  const env = io.env ?? process.env;
  delete env.WE_GH_READ_MEMO_DIR;
  const readVerdict = io.readVerdict ?? (await import('../lib/merge-gate-hold-class.mjs')).readMergeGateVerdict;
  const readHeadAndLabels = io.readHeadAndLabels ?? (await import('../lib/review-ci-gate-io.mjs')).readReviewHeadAndLabels;
  const readFreeze = io.readFreeze ?? (await import('../lib/red-main-freeze-shared.mjs')).readSharedFreeze;
  const read = async fn => { try { return await fn(); } catch (e) { log(`merge-gate-verdict-cache: ${String(e.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`); return { error: String(e.message) }; } };
  const verdictReadAt = new Date(now()).toISOString();
  const verdict = await read(() => readVerdict({ repo: subject.repo, jobId: subject.jobId, prNumber: subject.pr }));
  const labelsReadAt = new Date(now()).toISOString();
  const view = await read(() => readHeadAndLabels({ repo: subject.repo, pr: subject.pr }));
  const freezeReadAt = new Date(now()).toISOString();
  const freeze = await read(() => readFreeze());
  const entry = { v: 1, ...subject, headSha: verdict?.head_sha, verdict, verdictReadAt,
    labels: view?.labels ?? null, labelsHead: view?.headRefOid, labelsReadAt, freeze, freezeReadAt };
  const body = JSON.stringify(entry);
  if (Buffer.byteLength(body) > CACHED_VERDICT_MAX_BYTES) throw Error('entry-too-large: refresh with bounded evidence or inspect the job manually');
  disk.mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { disk.writeFileSync(temp, body, { flag: 'wx', mode: 0o600 }); disk.renameSync(temp, file); }
  finally { disk.rmSync(temp, { force: true }); }
  log(`merge-gate-verdict-cache: wrote ${file}`);
  return { ok: true, entry, path: file };
}
export async function main(argv = process.argv.slice(2), io = {}) {
  try {
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (!['--once', '--repo', '--pr', '--job'].includes(key) || flags.has(key)) throw Error('invalid arguments');
      flags.set(key, key === '--once' ? true : argv[++i]);
    }
    if (flags.size !== 4 || !flags.get('--once') || !/^\d+$/.test(flags.get('--pr')) || !/^\d+$/.test(flags.get('--job'))) throw Error('invalid arguments');
    return await writeOnce({ repo: flags.get('--repo'), pr: Number(flags.get('--pr')), jobId: Number(flags.get('--job')) }, io);
  } catch (e) { (io.log ?? console.error)(`merge-gate-verdict-cache: refused: ${String(e.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`); return { ok: false }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await main();
  if (!result.ok) process.exitCode = 1;
}
