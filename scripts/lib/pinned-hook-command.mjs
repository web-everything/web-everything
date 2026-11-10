/** Recognize the committed fail-closed shell wrapper without evaluating shell text.
 * Keep the launcher and failure checks literal; only the script and simple flags vary.
 * Dispatch must carry the whole wrapper unchanged, since its script is relative to the pinned clone.
 */
const PREFIX = "sh -c 'launcher=\"$HOME/workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs\"; [ -f \"$launcher\" ] || { echo \"Pinned guard: dedicated clone launcher missing; run scripts/hooks/sync-guard-clone.mjs\" >&2; exit 2; }; node \"$launcher\" ";
const SUFFIX = "; code=$?; [ \"$code\" -eq 0 ] || exit 2'";

export function pinnedHookScript(command) {
  if (typeof command !== 'string' || !command.startsWith(PREFIX) || !command.endsWith(SUFFIX)) return null;
  const invocation = command.slice(PREFIX.length, -SUFFIX.length);
  return /^(scripts\/(?:[\w-]+\/)*[\w-]+\.mjs)(?: --[\w-]+)*(?![\s\S])/.exec(invocation)?.[1] ?? null;
}
