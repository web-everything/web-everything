// Bun-runner POC compatibility shim (bun-poc card). NOT used by the default toolchain:
// `npm run test:*` still runs vitest on node. Only `bun test --preload ./bun-test.preload.ts` loads it.
// It reuses vitest.setup.ts (env sandbox, fake gh, per-test coordination root) and fills the
// vitest APIs Bun 1.4's `vi` lacks that scripts/__tests__ actually use: vi.stubEnv / vi.unstubAllEnvs.
import { vi } from 'bun:test';

// Production isolation guards key on the runner-neutral marker before other modules load.
// vitest.setup.ts restores it after stripping ambient WE_* keys.
process.env.WE_UNDER_TEST = '1';
await import('./vitest.setup.ts');

const v = vi as any;
if (typeof v.stubEnv !== 'function') {
  const saved = new Map<string, string | undefined>();
  v.stubEnv = (key: string, value: string | undefined) => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
    return v;
  };
  v.unstubAllEnvs = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    return v;
  };
}

// Async fake-timer variants: Bun ships only the sync ones. Approximation — flush microtasks
// between single-timer steps so awaited callbacks scheduled by a firing timer get to run.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
if (typeof v.runAllTimersAsync !== 'function') {
  v.runAllTimersAsync = async () => {
    await flush();
    for (let i = 0; i < 10_000 && v.getTimerCount() > 0; i++) {
      v.advanceTimersToNextTimer();
      await flush();
    }
    return v;
  };
}
if (typeof v.advanceTimersByTimeAsync !== 'function') {
  v.advanceTimersByTimeAsync = async (ms: number) => {
    await flush();
    for (let i = 0; i < ms; i++) {
      v.advanceTimersByTime(1);
      await flush();
    }
    return v;
  };
}
