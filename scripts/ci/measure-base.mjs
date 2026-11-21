import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function pickMeasureBase({ head, lastMeasured, isAncestor }) {
  return lastMeasured && lastMeasured !== head && isAncestor(lastMeasured, head)
    ? { base: lastMeasured, cumulative: true }
    : { base: 'HEAD^', cumulative: false };
}

export function lastMeasuredSha({ runs, head, hasSample = () => true }) {
  return runs.find(run => run.conclusion === 'success' && run.head_sha !== head && hasSample(run))?.head_sha ?? null;
}

export function coveredMerges({ base, head, runGit }) {
  return runGit(`${base}..${head}`).trim().split(/\r?\n/).filter(Boolean);
}

const runCommand = (command, args) => execFileSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });

export function main({ outputPath = process.argv[2] ?? 'measure-covered.txt', exec = runCommand,
  writeFile = writeFileSync, stderr = text => process.stderr.write(text),
  stdout = text => process.stdout.write(text), repository = process.env.GITHUB_REPOSITORY } = {}) {
  const writeCovered = (base, head) => {
    const shas = coveredMerges({ base, head,
      runGit: range => exec('git', ['log', '--first-parent', '--format=%H', range]),
    });
    writeFile(outputPath, shas.length ? `${shas.join('\n')}\n` : '');
  };
  let base = 'HEAD^';
  try {
    const head = exec('git', ['rev-parse', 'HEAD']).trim();
    let lastMeasured = null;
    for (let page = 1; page <= 5; page++) {
      const { workflow_runs: runs } = JSON.parse(exec('gh', ['api',
        `repos/${repository}/actions/workflows/test-selection-measure.yml/runs?branch=main&status=completed&per_page=100&page=${page}`,
      ]));
      lastMeasured = lastMeasuredSha({ runs, head, hasSample: run => {
        const pages = JSON.parse(exec('gh', ['api', '--paginate', '--slurp',
          `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
        ]));
        return pages.some(page => page.artifacts.some(artifact =>
          artifact.name === 'false-green-signal' && artifact.expired === false));
      } });
      if (lastMeasured || runs.length < 100) break;
      if (page === 5) stderr('measure-base: history limit reached without a sample; falling back to HEAD^ (inspect older runs manually)\n');
    }
    ({ base } = pickMeasureBase({ head, lastMeasured,
      isAncestor: (ancestor, descendant) => {
        exec('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      },
    }));
  } catch {
    base = 'HEAD^';
    stderr('measure-base: measurement lookup failed; falling back to HEAD^\n');
  }
  try {
    writeCovered(base, 'HEAD');
  } catch (error) {
    stderr(`measure-base: warning: could not write covered list: ${error.message}\n`);
    // Even incomplete history or an unwritable artifact must leave this advisory CLI successful.
    try { writeFile(outputPath, ''); } catch (error) {
      stderr(`measure-base: warning: could not write empty covered list: ${error.message}\n`);
    }
  }
  stdout(`${base}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
