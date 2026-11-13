/** Recognize the committed shell wrappers without evaluating shell text.
 * Keep the launcher and failure checks literal; only the script and simple flags vary.
 * Dispatch must carry the whole wrapper unchanged, since its script is relative to the pinned clone.
 * The PreToolUse wrapper maps every failure to exit 2 (deny). The Stop/SubagentStop wrapper keeps
 * the guard's own exit code and turns launcher failures into exit 1 (non-blocking), because exit 2
 * there would block stopping on every retry. Only the deny form may be carried as a PreToolUse guard.
 */
const LAUNCHER = 'launcher="$HOME/workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs"; [ -f "$launcher" ] || { echo "Pinned guard: dedicated clone launcher missing; run scripts/hooks/sync-guard-clone.mjs';
const PREFIX = `sh -c '${LAUNCHER}" >&2; exit 2; }; node "$launcher" `;
const SUFFIX = "; code=$?; [ \"$code\" -eq 0 ] || exit 2'";
const STOP_PREFIX = `sh -c '${LAUNCHER}; stop guard skipped" >&2; exit 1; }; exec node "$launcher" --stop-hook `;
const STOP_SUFFIX = "'";

function scriptBetween(command, prefix, suffix) {
  if (typeof command !== 'string' || !command.startsWith(prefix) || !command.endsWith(suffix)) return null;
  const invocation = command.slice(prefix.length, -suffix.length);
  return /^(scripts\/(?:[\w-]+\/)*[\w-]+\.mjs)(?: --[\w-]+)*(?![\s\S])/.exec(invocation)?.[1] ?? null;
}

/** The guard script of a fail-closed (deny) pinned wrapper, or null. */
export function pinnedHookScript(command) {
  return scriptBetween(command, PREFIX, SUFFIX);
}

/** The guard script of a Stop/SubagentStop pinned wrapper, or null. Never a PreToolUse guard. */
export function pinnedStopHookScript(command) {
  return scriptBetween(command, STOP_PREFIX, STOP_SUFFIX);
}
