import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readDeclaredSettings } from './lib/settings-files.mjs';
import { parseDigest, resolveDigestPath, selectForInjection } from './lib/rulings-digest.mjs';
import { capSnapshotText, renderSnapshot, resolveSnapshotConfig } from './precompact-snapshot.mjs';

export function buildInjection({ text, path, source, maxLines, maxBytes, snapshotText }) {
  let additionalContext;
  if (text == null) {
    additionalContext = `rulings digest missing at ${path} (source ${source})`;
  } else {
    const { lines, overCap, activeCount } = selectForInjection(parseDigest(text), { maxLines, maxBytes });
    additionalContext = [
      `Standing operator rulings (digest ${path}, source ${source}; ${lines.length} of ${activeCount} active shown):`,
      ...lines,
      ...(overCap ? ['DIGEST OVER CAP: retire old rulings with node scripts/rulings.mjs retire <id> --by=<check>'] : []),
    ].join('\n');
  }
  // The digest retains its own cap; the snapshot uses only the remaining context budget.
  if (snapshotText) {
    const snapshotBudget = 8192 - Buffer.byteLength(additionalContext, 'utf8') - 2;
    const snapshot = snapshotBudget <= 0
      ? 'pre-compaction snapshot omitted: digest uses the budget'
      : capSnapshotText(snapshotText, snapshotBudget);
    if (snapshot) additionalContext += `\n\n${snapshot}`;
  }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
}

export function writeOutput(output, stream = process.stdout) {
  try {
    stream.write(`${JSON.stringify(output)}\n`);
  } catch { /* output is best-effort, including closed pipes */ }
}

function main() {
  process.exitCode = 0;
  process.stdout.on('error', () => {});
  let output;
  try {
    // Hook payloads are optional; every invocation produces the same SessionStart envelope.
    let hook;
    try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { /* empty/invalid stdin is harmless */ }
    const settings = readDeclaredSettings();
    const { path, source } = resolveDigestPath({ settings });
    let text;
    try { text = readFileSync(path, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      text = null;
    }
    const config = settings.settings.rulings ?? {};
    let snapshotText;
    if (hook?.source === 'compact') {
      snapshotText = 'no pre-compaction snapshot for this session';
      try {
        const file = JSON.parse(readFileSync(resolveSnapshotConfig({ settings }).snapshotPath, 'utf8'));
        const snapshot = typeof hook.session_id === 'string' && hook.session_id
          && Array.isArray(file?.snapshots)
          ? file.snapshots.findLast((entry) => entry?.sessionId === hook.session_id) : undefined;
        if (snapshot) snapshotText = renderSnapshot(snapshot, { maxBytes: 8192 });
      } catch { /* snapshots are best-effort, including malformed files */ }
    }
    const cap = (value, fallback) => Number.isInteger(value) && value >= 0 ? value : fallback;
    output = buildInjection({ text, path, source,
      maxLines: cap(config.injectMaxLines, 40), maxBytes: cap(config.injectMaxBytes, 6144), snapshotText });
  } catch (error) {
    output = { hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: `rulings digest warning: ${String(error.message ?? error).replace(/[\r\n]+/g, ' ')}` } };
  }
  writeOutput(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
