/**
 * Git hardening for a process that runs git inside an AGENT-WRITABLE lane clone (we:backlog/5137 review).
 *
 * A lane's `.git/config` is untrusted input to any daemon-side process: `core.fsmonitor`, `core.hooksPath`,
 * `core.attributesFile`, `core.sshCommand`, `diff.external`, `diff.*.textconv` and `filter.*` all name a command git
 * will execute with the host user's credentials, outside the agent's guard-bash sandbox. A process the daemon spawns
 * (e.g. `verify-lane.mjs request --repo=<lane>`) cannot be handed `-c` flags for the git calls it makes itself, so this
 * module pins the same keys through git's own environment overrides (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`, command-scope: they beat the repo's config), and gives the child's git helper the argument
 * rewrites config cannot express (`--no-ext-diff`, `--no-textconv`, `--no-filters`). A `filter.*` driver cannot be neutralized
 * either way, so {@link laneFilterDrivers} lets the caller refuse such a lane up front. Pure.
 */

/** The lane-config keys that execute code, each pinned to an inert value. `core.hooksPath=/dev/null`, not a lane path:
 *  a hook runs lane-relative scripts, so ANY hooks path inside the lane would still execute lane code. */
export const LANE_GIT_CONFIG_PINS = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.attributesFile', '/dev/null'],
  ['core.sshCommand', 'ssh'],
]);

/** The pins as `-c k=v` argv pairs, for a caller that builds its own git command line. */
export const laneGitConfigArgs = () => LANE_GIT_CONFIG_PINS.flatMap(([k, v]) => ['-c', `${k}=${v}`]);

/**
 * `env` with the pins appended to git's environment config list. An existing `GIT_CONFIG_COUNT` is preserved (the pins
 * come AFTER its entries, so they win). `GIT_EXTERNAL_DIFF` is dropped: an inherited one would run on every `git diff`.
 * @param {Record<string,string|undefined>} env
 * @returns {Record<string,string|undefined>}
 */
export function laneGitHardeningEnv(env = process.env) {
  const out = { ...env };
  delete out.GIT_EXTERNAL_DIFF;
  const n = Number.parseInt(String(out.GIT_CONFIG_COUNT ?? '0'), 10);
  const start = Number.isInteger(n) && n > 0 ? n : 0;
  LANE_GIT_CONFIG_PINS.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k;
    out[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  out.GIT_CONFIG_COUNT = String(start + LANE_GIT_CONFIG_PINS.length);
  return out;
}

/** The argv that lists a lane's effective config with each entry's scope, NUL-separated (`scope\0key\nvalue\0…`). Reading
 *  config executes nothing. */
export const LANE_CONFIG_LIST_ARGS = Object.freeze(['config', '--show-scope', '--list', '--includes', '-z']);

const FILTER_DRIVER_KEY_RE = /^filter\..+\.(clean|smudge|process)$/i;

/**
 * The `filter.<name>.clean|smudge|process` keys a lane's OWN config (local / worktree scope, includes followed) defines,
 * from {@link LANE_CONFIG_LIST_ARGS} output. A clean filter runs on worktree content during `git diff` / `git status`, and
 * which paths it applies to is chosen by an in-repo `.gitattributes` or `.git/info/attributes` — neither can be switched off
 * from the environment — so these cannot be pinned the way `core.fsmonitor` is: a process that must run git in the lane
 * refuses a lane that defines one. Global/system filters (e.g. git-lfs) are the host user's own and are ignored. Pure.
 * @param {string} listOutput
 * @returns {string[]}
 */
export function laneFilterDrivers(listOutput) {
  const parts = String(listOutput ?? '').split('\0');
  const found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    const key = parts[i + 1].split('\n')[0];
    if ((scope === 'local' || scope === 'worktree') && FILTER_DRIVER_KEY_RE.test(key)) found.push(key);
  }
  return found;
}

/**
 * The argument rewrites a lane-config driver cannot be neutralized without: a `git diff` never runs `diff.external` or a
 * textconv, and a `git hash-object` never runs a clean filter. Both leave the output of the name/hash forms the gate reads
 * unchanged. A `git diff`/`git status` still applies a clean FILTER to worktree content — see {@link laneFilterDrivers}.
 * Returns a new array. Pure.
 * @param {string[]} args
 */
export function hardenLaneGitArgs(args) {
  const a = [...args];
  if (a[0] === 'diff') return ['diff', ...['--no-ext-diff', '--no-textconv'].filter((f) => !a.includes(f)), ...a.slice(1)];
  if (a[0] === 'hash-object') return ['hash-object', ...(a.includes('--no-filters') ? [] : ['--no-filters']), ...a.slice(1)];
  return a;
}
