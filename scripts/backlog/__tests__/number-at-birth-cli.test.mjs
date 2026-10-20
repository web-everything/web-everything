import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

it('the real scaffold CLI births numeric cards, and off/outage retain hash naming', () => {
  const root = mkdtempSync(join(tmpdir(), 'birth-cli-'));
  try {
    cpSync('scripts', join(root, 'scripts'), { recursive: true, filter: (p) => basename(p) !== '__tests__' });
    mkdirSync(join(root, 'backlog'));
    const home = join(root, 'home'); mkdirSync(home);
    const run = (env = {}) => JSON.parse(execFileSync(process.execPath,
      [join(root, 'scripts/backlog.mjs'), 'scaffold', '--kind=task', '--title=Born numbered', '--json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, WE_NUMBER_AT_BIRTH: 'on', ...env } }));
    writeFileSync(join(root, 'scripts/settings/number-at-birth.json'), JSON.stringify({
      backlog: { cardNumbering: { atBirth: 'on', atBirthRemote: 'best-effort' } },
    }));
    const numeric = run();
    expect(numeric.num).toMatch(/^\d+$/);
    const content = readFileSync(join(root, numeric.file), 'utf8');
    expect(content).toMatch(/^bornAs: x[0-9a-z]{6}$/m);
    const birthHash = content.match(/^bornAs: (x[0-9a-z]{6})$/m)[1];
    const state = JSON.parse(readFileSync(join(home, '.claude/card-number-reservations.json'), 'utf8'));
    expect(state.ids[birthHash]).toBe(numeric.num);
    expect(readdirSync(join(root, 'backlog'))).toEqual([`${numeric.num}-born-numbered.md`]);
    const off = run({ WE_NUMBER_AT_BIRTH: 'off' });
    expect(off.num).toMatch(/^x[0-9a-z]{6}$/);
    expect(readFileSync(join(root, off.file), 'utf8')).not.toContain('bornAs:');
    writeFileSync(join(root, 'scripts/settings/number-at-birth.json'), JSON.stringify({
      backlog: { cardNumbering: { atBirth: 'on', atBirthRemote: 'required' } },
    }));
    const outage = run();
    expect(outage.num).toMatch(/^x[0-9a-z]{6}$/);
    expect(readFileSync(join(root, outage.file), 'utf8')).not.toContain('bornAs:');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
