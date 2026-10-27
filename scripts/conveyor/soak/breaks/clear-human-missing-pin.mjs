/** PR #5982: delegated daemon clearance must refuse a missing pin before forge access. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-missing-pin',
  title: 'delegated clear-human refuses missing pins before forge access, including retries',
  card: 'PR #5982 delegated clearance pin bypass',
  fixedBy: { sha: 'pending', where: 'lane/r130-clear-human-guard', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8').includes("normalizeChannel(channelArg).toLowerCase() === 'daemon'");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { runReviewLabelCli } = await import(pathToFileURL(join(sourceRoot, 'scripts/review-set-label.mjs')).href);
    const { createGhProvider } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-label-provider.mjs')).href);
    const delegation = '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'review:human', expires: '2099-01-01T00:00:00Z' });
    const violations = [];
    const realExit = process.exit;
    const exitSignal = Symbol('expected CLI exit');
    try {
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const args of [[delegation, '--channel=daemon'], [delegation], ['--channel=daemon'], ['--channel= DAEMON. ']]) {
        for (const fixed of [false, true]) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const calls = [], output = [];
            const provider = createGhProvider({ exec(argv) {
              calls.push(argv);
              // The unfixed tree attempts forge access; stop before any real IO or ledger write.
              throw new Error('forge access before pin validation');
            } });
            let code;
            try {
              runReviewLabelCli({
                argv: ['5982', '--repo=o/n', '--actor=operator', '--reason=operator ruling',
                  ...(fixed ? [] : ['--to=clear-human']), ...args],
                fixedTo: fixed ? 'clear-human' : null, allowClearHuman: true,
                provider, emit: line => output.push(line), buildComment: () => 'clearance',
                successResult: o => o, refusalResult: o => o,
              });
            } catch (error) {
              if (error?.signal !== exitSignal) throw error;
              code = error.code;
            }
            if (code !== 2 || calls.length !== 0
              || !output.join('').includes('pinned clear-human requires --expect-head=<full 40-hex SHA> and --delegation-json (and no --new-head)')) {
              violations.push(`missing pin admitted (args ${args.join(' ')}, fixed target ${fixed}, attempt ${attempt})`);
            }
          }
        }
      }
    } finally { process.exit = realExit; }
    log?.(`clear-human missing pin: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
