import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Mirror section B of deploy.yml; tests execute its actual jq against the same cases.
export function requiredChecksGreen(checkRuns) {
  if (!Array.isArray(checkRuns)) return false;
  return ['test', 'smoke'].every(name => {
    const runs = checkRuns.filter(run => run?.name === name)
      .sort((a, b) => a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0);
    return runs.length > 0 && runs.at(-1).conclusion === 'success';
  });
}

// gh api --paginate emits adjacent JSON objects, not a JSON array or necessarily JSONL.
function readPages(input) {
  const pages = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        const page = JSON.parse(input.slice(start, i + 1));
        if (!Array.isArray(page.check_runs)) throw new Error('Missing check_runs');
        pages.push(page);
        start = i + 1;
      }
    }
  }
  if (input.slice(start).trim() || !pages.length) throw new Error('Incomplete check-run evidence');
  return pages.flatMap(page => page.check_runs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(requiredChecksGreen(readPages(readFileSync(0, 'utf8'))));
  } catch {
    console.log(false);
    process.exitCode = 1;
  }
}
