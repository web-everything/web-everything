/** Review-job stages in checkout A while the label CLI's allowlist belongs to checkout B. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/operations/review-pr-io.mjs';

export async function replay(sourceRoot = ROOT) {
  const fixture = mkdtempSync(join(tmpdir(), 'review-label-cwd-'));
  const violations = [];
  const check = (ok, message) => { if (!ok) violations.push(message); };
  try {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { createReviewPrSinks, reviewBodyPath } = await load(SOURCE);
    const { REVIEW_EFFECTS } = await load('scripts/operations/review-pr.mjs');
    const { bodyFileRoots, checkBodyFileLocation } = await load('scripts/review-set-label.mjs');
    const root = join(fixture, 'checkout-a'), cwd = join(fixture, 'checkout-b'), scratch = join(fixture, 'temp');
    for (const dir of [root, cwd, scratch]) mkdirSync(dir);
    const runId = 'review-pr-7100', bodyFile = 'verdict.md', body = '# Accepted review';
    const payload = { pr: 7100, repo: 'example/review', to: 'accepted', actor: 'reviewer', bodyFile,
      reviewedHead: 'a'.repeat(40) };
    const staged = reviewBodyPath({ root, runId, bodyFile });
    let calls = 0, copy;
    const sinks = createReviewPrSinks({ root, cwd, tmpDir: scratch,
      runStore: { read: () => ({ id: runId, effects: [
        { type: REVIEW_EFFECTS.WRITE_UP, status: 'applied', payload: { bodyFile, body } },
      ] }) },
      readPublishHead: () => payload.reviewedHead,
      publishGate: () => ({ allowed: true, headSha: payload.reviewedHead, checks: [] }),
      runNode: (argv, opts) => {
        calls++;
        copy = argv.find(a => a.startsWith('--body-file=')).slice(12);
        check(opts.cwd === cwd, 'label child did not run in checkout B');
        check(copy !== staged, 'label child received checkout A staging path');
        check(checkBodyFileLocation(copy, bodyFileRoots(opts.cwd)).ok, 'real CLI allowlist refused body');
        check(checkBodyFileLocation(copy, bodyFileRoots(opts.cwd, scratch)).ok, 'isolated CLI allowlist refused body');
        check(readFileSync(copy, 'utf8') === body, 'body bytes changed');
        check((statSync(copy).mode & 0o777) === 0o600, 'copy is not private');
        return '{"ok":true}';
      } });
    await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile, body }, { runId });
    check(!checkBodyFileLocation(staged, bodyFileRoots(cwd, scratch)).ok, 'fixture did not separate checkout/temp roots');
    await sinks[REVIEW_EFFECTS.LABEL](payload, { runId });
    check(calls === 1, 'label CLI was not called exactly once');
    check(copy && !existsSync(copy) && readdirSync(scratch).length === 0, 'private copy leaked');
    check(readFileSync(staged, 'utf8') === body, 'staged write-up was lost');
  } catch (error) { violations.push(`replay failed: ${error.message}`); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
  return { violations };
}

export default {
  id: 'review-label-body-child-cwd',
  title: 'review label accepts its body file when staging and child cwd are different checkouts',
  card: 'review-job --pr=7100 body-file refusal',
  fixedBy: { sha: 'HEAD', where: 'review-label-body-child-cwd', paths: [SOURCE, 'scripts/operations/run.mjs'] },
  fixPresent(root) {
    // The harness needs a synchronous answer. Probe the real sink in a bounded, hermetic child;
    // no marker text can turn an unfixed implementation into a required pass.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { replay } from ${JSON.stringify(import.meta.url)};
       const report = await replay(process.argv[1]);
       process.exitCode = report.violations.length ? 1 : 0;`, root],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  },
  run: ({ sourceRoot = ROOT } = {}) => replay(sourceRoot),
  judge: report => report.violations,
};
