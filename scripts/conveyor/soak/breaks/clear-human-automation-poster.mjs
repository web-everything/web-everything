/** PR #5803: a clear-human ceremony posted with automation credentials silently
 * accepted the PR while the red-team gate ignored its ruling. Replay both entry
 * paths and retries through the production CLI harness and gh provider. Refusal
 * must precede every PR read/write, so this scenario needs no git or network.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-automation-poster',
  title: 'clear-human refuses automation credentials before changing the PR, including on retry',
  card: 'PR #5803 review finding: ceremony posting identity',
  fixedBy: { sha: 'pending', where: 'lane/operator-ruled-human-only', paths: [
    'scripts/review-set-label.mjs', 'scripts/lib/review-label-provider.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8').includes('identity = provider.readPostingIdentity(repo)');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli } = await load('scripts/review-set-label.mjs');
    const { createGhProvider } = await load('scripts/lib/review-label-provider.mjs');
    const violations = [];
    const identities = [
      { login: 'web-everything', type: 'User' },
      { login: 'chalbert', type: 'Bot' },
      { login: 'chalbert', is_bot: true },
      { login: 'chalbert[bot]' },
      {},
      new Error('identity unavailable'),
    ];
    const realExit = process.exit;
    const exitSignal = Symbol('expected CLI exit');
    try {
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const identity of identities) {
        for (const fixed of [false, true]) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const calls = [], output = [];
            const provider = createGhProvider({ exec(args) {
              calls.push(args);
              if (args[0] !== 'api' || args[1] !== 'user') throw new Error('unexpected PR access before identity refusal');
              if (identity instanceof Error) throw identity;
              return JSON.stringify(identity);
            } });
            let code;
            try {
              runReviewLabelCli({
                argv: ['5803', '--repo=web-everything/web-everything', '--actor=chalbert', '--reason=operator ruling',
                  ...(fixed ? [] : ['--to=clear-human'])],
                fixedTo: fixed ? 'clear-human' : null, allowClearHuman: true,
                defaultActor: 'operator', usage: 'soak', provider,
                emit: line => output.push(line), buildComment: () => 'clearance',
                successResult: o => o, refusalResult: o => o,
              });
            } catch (error) {
              if (error?.signal !== exitSignal) throw error;
              code = error.code;
            }
            const error = JSON.parse(output.join('') || '{}').error || '';
            if (code !== 2 || !/clear-human.*posting identity/i.test(error)
              || calls.length !== 1 || calls[0][0] !== 'api' || calls[0][1] !== 'user') {
              violations.push(`identity refusal failed (fixed target ${fixed}, attempt ${attempt})`);
            }
          }
        }
      }
    } finally { process.exit = realExit; }
    log?.(`clear-human posting identity: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
