import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTerminalStatus } from '../lib/backlog-status.cjs';

// Exercise the warning producer in isolation, as the scoped-file-scan harness does.
const source = readFileSync(new URL('../check-standards.mjs', import.meta.url), 'utf8');
function run(raw) {
  const block = source.match(/\/\/ BEGIN scope whitespace warning([\s\S]*?)\/\/ END scope whitespace warning/);
  expect(block, 'scope whitespace warning block must exist').not.toBeNull();
  const warn = vi.fn();
  const err = vi.fn();
  new Function('raw', 'scope', 'id', 'warn', 'err', 'isTerminalStatus', block[1])(
    raw, raw.scope, '7594-fixture', warn, err, isTerminalStatus,
  );
  return { warn, err };
}

describe('scope whitespace warning', () => {
  it.each(['we:a we:b', 'we:a\twe:b', 'we:a\nwe:b'])('warns, never errors, for %j', (entry) => {
    const { warn, err } = run({ status: 'open', scope: [entry] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('one path per array entry'));
    expect(err).not.toHaveBeenCalled();
  });
  it('does not warn for one path per entry', () => {
    expect(run({ status: 'open', scope: ['we:a', 'we:b'] }).warn).not.toHaveBeenCalled();
  });
  it.each(['resolved', 'closed'])('skips terminal status %s', (status) => {
    expect(isTerminalStatus(status)).toBe(true);
    expect(run({ status, scope: ['we:a we:b'] }).warn).not.toHaveBeenCalled();
  });
  it('still warns when directory scope has a rationale', () => {
    expect(run({ status: 'open', scope: ['we:a we:b'], scopeRationale: 'Required' }).warn)
      .toHaveBeenCalledTimes(1);
  });
});
