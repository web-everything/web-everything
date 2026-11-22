import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import b from './mq-same-head-unexecuted-refresh-retry.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('runs recovery and detects the installed fix with TMPDIR unset', async () => {
  // Preserve the task scratch root while exercising the platform fallback.
  const root = tmpdir();
  vi.stubEnv('TMP', root);
  vi.stubEnv('TEMP', root);
  vi.stubEnv('TMPDIR', undefined);
  try {
    expect(process.env.TMPDIR).toBeUndefined();
    expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
    expect(b.judge(await b.run())).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});
