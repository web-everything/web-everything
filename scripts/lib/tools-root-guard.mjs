/** R259 prototype. Next guard candidates: scripts/operations/run.mjs,
 * scripts/operations/open-pr.mjs, scripts/codex-direct-task.mjs, scripts/lane-pool.mjs,
 * skills-src/conveyor/review-daemon.mjs, skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs.
 * #6109 may be superseded by tools.root. Keep this the entry script's FIRST import:
 * a separate side-effect module completes before the entry's other dependencies evaluate.
 * Only TOOLS_ROOT_ENTRIES opt in; importing a guarded CLI as a library stays local.
 * Signal limitation: spawnSync cannot forward signals sent only to the lane wrapper's PID.
 * Its tools-root child may survive that wrapper. Supervisors must terminate the whole
 * process group, including during the bounded event write, rather than only that PID.
 * Async spawning would require deferring the entries' sibling imports as well; awaiting
 * this side-effect module alone lets those local dependencies evaluate before transfer.
 */
import * as nativeFs from 'node:fs';
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveToolsRoot, boundedToolsText } from './tools-root.mjs';
import { daemonEventsPath } from './daemon-events.mjs';

const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLS_ROOT_ENTRIES = Object.freeze([
  'scripts/readiness/heavy-admission.mjs',
  'scripts/readiness/remote-exec.mjs',
  'scripts/verify-lane.mjs',
]);
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
let provenanceLogged = false;

// appendDaemonEvent is async. Awaiting it here would let sibling entry imports evaluate
// before re-exec. A bounded synchronous child completes the shared writer before transfer.
function appendEventSync(event, { env, home }) {
  const writerUrl = new URL('./daemon-events.mjs', import.meta.url).href;
  const code = `import { readFileSync } from 'node:fs';
    import { appendDaemonEvent } from ${JSON.stringify(writerUrl)};
    const { event, home } = JSON.parse(readFileSync(0, 'utf8'));
    process.exitCode = await appendDaemonEvent(event, { home }) ? 0 : 1;`;
  const child = nativeSpawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env, input: JSON.stringify({ event, home }), encoding: 'utf8',
    timeout: 5000, maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return !child.error && child.status === 0;
}

/** Best effort: failed provenance storage must never prevent local or selected tooling.
 * appendEvent is synchronous and returns false on failure, like the bounded default adapter.
 */
export function maybeReexecFromToolsRoot({ entryUrl, argv = process.argv, env = process.env,
  cwd = process.cwd(), spawnSync = nativeSpawnSync, exit = code => process.exit(code),
  log = line => process.stderr.write(`${line}\n`), appendEvent = appendEventSync,
  home = homedir(), ownRoot = OWN_ROOT, fs = nativeFs, git,
} = {}) {
  try {
    if (env.WE_TOOLS_ROOT_REEXEC !== undefined) return;
    // Library imports must not redirect their runner, even if tools.root contains it.
    const rel = relative(fs.realpathSync(ownRoot), fs.realpathSync(fileURLToPath(entryUrl)));
    if (!TOOLS_ROOT_ENTRIES.includes(rel.split(sep).join('/'))) return;
    const result = resolveToolsRoot({ scriptRelPath: rel, env, home, ownRoot, fs, git });
    if (!result.active) {
      if (result.reason) log(`[tools-root] ignored: ${clean(result.reason)}`);
      return;
    }
    const { root, sha } = result;
    if (!provenanceLogged) {
      provenanceLogged = true;
      log(`[tools-root] running ${clean(rel)} from ${clean(root)} @ ${sha.slice(0, 7)}`);
    }
    try {
      const statePath = join(dirname(daemonEventsPath({ env, home })), 'tools-root-last.json');
      let last;
      try { last = JSON.parse(boundedToolsText(statePath, fs, 4096)); } catch { /* no usable previous record */ }
      if (last?.root !== root || last?.sha !== sha) {
        const appended = appendEvent({ kind: 'tools-root-override', detail: { root, sha, script: rel } }, { env, home });
        if (appended !== false) {
          fs.mkdirSync(dirname(statePath), { recursive: true });
          fs.writeFileSync(statePath, JSON.stringify({ root, sha }), { mode: 0o600 });
        }
      }
    } catch { /* unavailable event storage is not a launch failure */ }
    const child = spawnSync(process.execPath, [join(root, rel), ...argv.slice(2)], {
      stdio: 'inherit', cwd, env: { ...env, WE_TOOLS_ROOT_REEXEC: root },
    });
    if (child.error) return;
    exit(child.signal ? 1 : (child.status ?? 1));
  } catch { /* any guard error runs locally */ }
}

try {
  if (process.argv[1]) {
    maybeReexecFromToolsRoot({ entryUrl: pathToFileURL(resolve(process.argv[1])) });
  }
} catch { /* guard initialization also falls back locally */ }
