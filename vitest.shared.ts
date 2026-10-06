import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';

// #449 (per #606): WE consumes the plug platform layer as the `@frontierui/plugs` package — dev-time
// resolved to the sibling Frontier UI source (mirrors vite.config.mts). Shared by vitest.config.ts and
// vitest.integration.config.ts so the two runners can never resolve it to different places.
const repoRoot = dirname(fileURLToPath(import.meta.url));
export const fuiPlugsRoot = resolve(repoRoot, '../frontierui/plugs');
// #1910: the webtheme runtime relocated to fui:webtheme (#1907, per #1282). WE's remaining runtime
// consumer — the reproduction-parity harness — imports it via `@frontierui/webtheme`, dev-time resolved
// to the sibling FUI source (mirrors the `@frontierui/plugs` alias). WE keeps only the contract + vectors.
export const fuiWebthemeRoot = resolve(repoRoot, '../frontierui/webtheme');

export const weAlias = {
  '@frontierui/plugs': fuiPlugsRoot,
  '@frontierui/webtheme': fuiWebthemeRoot,
};

// Each Vitest invocation defaults to max(1, min(4, floor(cpuCount / heavyCap))) workers.
// The ceiling of 4 keeps the admission wait's fail-open third run at 3×4=12 cores on
// the 12-core host; cpuCount / heavyCap only lowers that ceiling on small hosts.
// WE_VITEST_MAX_WORKERS overrides the default with any valid value >= 1 (rounded down).
// Heavy-cap parsing matches heavy-admission.mjs#resolveCap (default 2), without importing
// the admission module's whole import graph when loading a Vitest config.
// Shared by the threads and forks pools; existing singleFork correctness pins stay serial.
export const DEFAULT_VITEST_MAX_WORKERS = 4;
export const VITEST_MAX_WORKERS_ENV = 'WE_VITEST_MAX_WORKERS';
const HEAVY_ADMISSION_DEFAULT_CAP = 2; // == heavy-admission.mjs#DEFAULT_ADMISSION_CAP (parity-tested)

function hostCpuCount(): number {
  try { return availableParallelism(); } catch { return cpus().length; }
}

export function resolveMaxTestWorkers(env: Record<string, string | undefined> = process.env, cpuCount: number = hostCpuCount()): number {
  const explicit = Number(env[VITEST_MAX_WORKERS_ENV]);
  if (env[VITEST_MAX_WORKERS_ENV] !== '' && Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
  const capRaw = Number(env.WE_HEAVY_ADMISSION_CAP);
  const cap = Number.isFinite(capRaw) && capRaw >= 1 ? Math.floor(capRaw) : HEAVY_ADMISSION_DEFAULT_CAP;
  return Math.max(1, Math.min(DEFAULT_VITEST_MAX_WORKERS, Math.floor((Number(cpuCount) || 0) / cap)));
}

export const maxTestWorkers = resolveMaxTestWorkers();

// File-event churn fix: every `git init`/`git clone` a test (or a CLI it spawns, e.g. `lane-pool.mjs provision`)
// runs copies git's default template — 14 `hooks/*.sample` files, `description`, `info/exclude` and their dirs —
// into the new repo. The real-git lane-pool suite clones ~1,200 throwaway repos per run, so those inert copies
// alone were ~20% of its ~230k file events (measured with a recursive FSEvents watch), and fseventsd pays for
// every one. Point `GIT_TEMPLATE_DIR` at a minimal template instead: an EMPTY `hooks/` (git's sample hooks are
// inert, never executed) and the stock `info/exclude`, so code and tests that write `.git/hooks/<name>` or
// append to `.git/info/exclude` without a `mkdir` keep working exactly as on a stock clone. Created once per
// host under the OS temp dir (idempotent), never inside the checkout. Inherited by every spawned `git`.
export function minimalGitTemplateEnv(): { GIT_TEMPLATE_DIR: string } {
  const dir = join(tmpdir(), 'we-test-git-template');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'info'), { recursive: true });
  const exclude = join(dir, 'info', 'exclude');
  if (!existsSync(exclude)) {
    writeFileSync(exclude, "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n");
  }
  return { GIT_TEMPLATE_DIR: dir };
}

// Keep host performance settings and credential helpers out of test repos. Supply an identity
// for fixtures that commit without setting one, while leaving git's default branch unchanged.
export function hermeticGitEnv(): Record<string, string> {
  const config = join(tmpdir(), 'we-test-gitconfig');
  const contents = '[user]\n\tname = WE Test\n\temail = test@example.invalid\n';
  if (!existsSync(config) || readFileSync(config, 'utf8') !== contents) {
    writeFileSync(config, contents);
  }
  return {
    ...minimalGitTemplateEnv(),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
