import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function pickMeasureBase({ head, lastMeasured, isAncestor }) {
  return lastMeasured && lastMeasured !== head && isAncestor(lastMeasured, head)
    ? { base: lastMeasured, cumulative: true }
    : { base: 'HEAD^', cumulative: false };
}

export function lastMeasuredSha({ runs, head }) {
  return runs.find(run => run.conclusion === 'success' && run.head_sha !== head)?.head_sha ?? null;
}

export function coveredMerges({ base, head, runGit }) {
  return runGit(`${base}..${head}`).trim().split(/\r?\n/).filter(Boolean);
}

function main() {
  const outputPath = process.argv[2] ?? 'measure-covered.txt';
  const exec = (command, args) => execFileSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const writeCovered = (base, head) => {
    const shas = coveredMerges({ base, head,
      runGit: range => exec('git', ['log', '--first-parent', '--format=%H', range]),
    });
    writeFileSync(outputPath, shas.length ? `${shas.join('\n')}\n` : '');
  };
  let base = 'HEAD^';
  try {
    const head = exec('git', ['rev-parse', 'HEAD']).trim();
    const { workflow_runs: runs } = JSON.parse(exec('gh', ['api',
      `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/test-selection-measure.yml/runs?branch=main&status=completed&per_page=50`,
    ]));
    ({ base } = pickMeasureBase({ head, lastMeasured: lastMeasuredSha({ runs, head }),
      isAncestor: (ancestor, descendant) => {
        exec('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      },
    }));
    writeCovered(base, head);
  } catch {
    base = 'HEAD^';
    process.stderr.write('measure-base: measurement lookup failed; falling back to HEAD^\n');
    try {
      writeCovered(base, 'HEAD');
    } catch {
      // Even incomplete history or an unwritable artifact must leave this advisory CLI successful.
      try { writeFileSync(outputPath, ''); } catch { /* best effort */ }
    }
  }
  process.stdout.write(`${base}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
