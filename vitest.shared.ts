import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// #x1jcikc: a single `vitest` invocation left NO pool/thread cap at all, so it defaults (via tinypool) to one
// worker PER AVAILABLE CPU CORE. `heavy-admission.mjs` (#3461) already caps concurrent HEAVY COMMANDS
// (`test:unit`, `check:standards`, the Playwright capture) at `DEFAULT_ADMISSION_CAP` (2) host-wide — but that
// cap bounds how many `vitest` PROCESSES may run at once, never how many WORKER THREADS each one spawns. Two
// admitted `vitest` runs on a real 12-core host therefore each grab up to 12 threads — 24 fighting over 12
// cores — before the admission cap does any good at all, which is exactly the near-total-CPU symptom this
// fixes. Sized for the admission cap's OWN documented worst case, not just its happy path: the cap's blocking
// wait (`acquireSlotBlocking`) FAILS OPEN on a 20-minute timeout by design (a queuing timeout must never
// strand a lane's whole delivery arc) — so a THIRD `vitest` can and does run concurrently with the two
// slotted ones under real burst load, not just hypothetically. 4 threads/forks per invocation keeps even that
// 3-way burst at 3×4=12 — fully subscribed but never oversubscribed — while the designed 2-at-a-time case
// (2×4=8) still leaves 4 cores of headroom for the OS, git, and everything else running alongside a lane's
// gate. Applied to `pool: 'threads'` (`vitest.config.ts`, `vitest.maas-conformance.config.ts`) AND to the
// `forks` pool's `maxForks` (`vitest.integration.config.ts`'s few explicitly-`forks`-scoped files, via
// `poolMatchGlobs`) so neither pool can locally re-open the same oversubscription this constant exists to
// close. Deliberately NOT applied to `singleFork: true` files (`vitest.integration.config.ts`) — those are
// already pinned to exactly one worker for a CORRECTNESS reason (flaky under contention), not a speed one;
// this constant governs the OTHER files' worker ceiling, never overrides an existing serialization need.
export const maxTestWorkers = 4;

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
