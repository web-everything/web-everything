// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Catch bare API argv literals, including templates containing nested job-id expressions.
const bareLogApi = /\[\s*['"]api['"]\s*,\s*([`'"])(?:(?!\1)[\s\S])*?\/logs\1\s*\]/g;
const directories = [new URL('../', import.meta.url), new URL('../../conveyor/', import.meta.url)];
const files = directories.flatMap(directory => readdirSync(directory)
  .filter(name => /^drain-.*\.mjs$/.test(name)).map(name => new URL(name, directory)));

describe('drain job-log transport', () => {
  it('detects a bare log API call and accepts the shared helper', () => {
    expect("exec('gh', ['api', `repos/${repo}/actions/jobs/${id}/logs`])".match(bareLogApi)).toHaveLength(1);
    expect("exec('gh', ciJobLogApiArgs(`repos/${repo}/actions/jobs/${id}/logs`))".match(bareLogApi)).toBeNull();
  });

  it.each(files)('%s has no bare log API argv bypassing ciJobLogApiArgs', file => {
    expect(readFileSync(file, 'utf8').match(bareLogApi)).toBeNull();
  });
});
