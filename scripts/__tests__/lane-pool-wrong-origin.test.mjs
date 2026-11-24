/**
 * @file scripts/__tests__/lane-pool-wrong-origin.test.mjs
 * @description LANE-POOL-WRONG-REPO: wrong-origin detection and the --pool origin resolution.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { originsDiffer } from '../lib/lane-pool-origin.mjs';

describe('originsDiffer', () => {
  it('flags a web-everything clone inside the plateau-app pool', () => {
    expect(originsDiffer('git@github.com:chalbert/web-everything.git', 'git@github.com:plateauapp/plateau-app.git')).toBe(true);
  });
  it('treats ssh/https spellings of the same repo as equal', () => {
    expect(originsDiffer('git@github.com:plateauapp/plateau-app.git', 'https://github.com/plateauapp/plateau-app')).toBe(false);
  });
  it('never marks a lane wrong when an origin is unknown', () => {
    expect(originsDiffer(null, 'git@github.com:a/b.git')).toBe(false);
    expect(originsDiffer('git@github.com:a/b.git', '')).toBe(false);
  });
});

describe('lane-pool wiring', () => {
  const src = readFileSync(resolve(process.cwd(), 'scripts/lane-pool.mjs'), 'utf8');
  it('growth/recovery commands resolve --pool to the pool primary origin', () => {
    expect(src).toMatch(/needsOrigin && poolPrimaryExists/);
  });
  it('a wrong-origin lane is never advertised as acquirable', () => {
    expect(src).toMatch(/laneIsWrongOrigin\(repo, dir\)[\s\S]{0,200}wrongOrigin: true/);
  });
});
