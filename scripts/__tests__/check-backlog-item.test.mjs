/**
 * @file check-backlog-item.test.mjs — the per-item checker's WIRING (#3201).
 *
 * The rules it composes are unit-tested where they live (`lintBacklogItemRendering`,
 * `scanRepoLocusPrefixes` in `we:scripts/__tests__/check-standards-rules.test.mjs`). What had no test — and
 * what actually cost four review cycles on 2026-08-19 — is which of them this CLI RUNS. The locus-prefix scan
 * was in the write path and in CI and in neither of the places an author reaches while writing, so
 * `check-backlog-item` reported clean and `check:standards` rejected minutes later, every time with the same
 * signature. A missing wire is invisible to every rule-level test in the repo.
 *
 * Drives the real CLI against a fresh temporary backlog for each test. Even a killed worker leaves
 * only temporary fixtures; the real backlog is read solely to guard against accidental writes (#4968).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-backlog-item.mjs');
/** A hash id shaped like a real provisional one (#2288) but reserved for this file. */
const ID = 'x0zzzz9';
let tmp;

const card = (body) => `---
kind: task
status: open
dateOpened: "2026-08-19"
tags: []
---

# per-item checker wiring fixture

A digest with no code paths in it at all, so the only thing under test is the body below.

${body}
`;

const run = (args = [ID, `--backlog-dir=${tmp}`], env = process.env) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const write = (body) => writeFileSync(join(tmp, `${ID}-per-item-checker-wiring-fixture.md`), card(body));
const backlogStatus = () => {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'backlog'], {
    cwd: ROOT, encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return r.stdout;
};
const expectNoRealFixture = () => {
  expect(readdirSync(join(ROOT, 'backlog')).filter((name) => name.startsWith(`${ID}-`))).toEqual([]);
};
let initialStatus;
beforeAll(() => { initialStatus = backlogStatus(); });
afterAll(() => { expect(backlogStatus()).toBe(initialStatus); });
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'check-backlog-item-')); });
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  expectNoRealFixture();
});

describe('check-backlog-item runs the #883 locus-prefix scan (#3201)', () => {
  // THE REGRESSION. The scaffold validates the DIGEST at creation, so the digest is always right; the body is
  // appended afterwards and carries all the file references. This is that body.
  it('rejects a bare code-path reference in the BODY, which it used to pass', () => {
    write('The fix belongs in `scripts/merge-ai-prs.mjs`, near the rebase loop.');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toMatch(/bare code-path ref/);
    // Names the fix, not just the rule — the message an author acts on without looking anything up.
    expect(out).toContain('we:scripts/merge-ai-prs.mjs');
  });

  it('passes a body whose references carry their prefix, so the check is not a wall', () => {
    write('The fix belongs in `we:scripts/merge-ai-prs.mjs`, near the rebase loop.');
    const { code } = run();
    expect(code).toBe(0);
  });

  // A clean run must not read as a clean bill of health for checks this pass cannot see. Silence about the
  // difference is what let a green per-item run be mistaken for a green gate.
  it('states which gates it did NOT run, even when everything it did run passed', () => {
    write('Nothing to see here.');
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toMatch(/single-file pass/);
    expect(out).toMatch(/check:standards/);
  });
});

describe('check-backlog-item reads a temp backlog, never the real one (4968)', () => {
  it('lints a card that exists ONLY in --backlog-dir', () => {
    write('Nothing to see here.');
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain(ID);
  });

  it('honours WE_BACKLOG_DIR when no flag is given', () => {
    write('Nothing to see here.');
    expect(run([ID], { ...process.env, WE_BACKLOG_DIR: tmp }).code).toBe(0);
  });

  it('accepts the flag before the id', () => {
    write('Nothing to see here.');
    expect(run([`--backlog-dir=${tmp}`, ID]).code).toBe(0);
  });

  it('keeps --item working and gives the flag precedence over the environment', () => {
    write('Nothing to see here.');
    expect(run(['--item', `--backlog-dir=${tmp}`, ID], {
      ...process.env, WE_BACKLOG_DIR: join(tmp, 'does-not-exist'),
    }).code).toBe(0);
  });

  it('without an override it still reads the repo backlog', () => {
    const env = { ...process.env };
    delete env.WE_BACKLOG_DIR;
    const { code, out } = run([ID], env);
    expect(code).toBe(2);
    expect(out).toContain('no backlog item found');
  });

  it('leaves the real backlog directory untouched', () => {
    write('Nothing to see here.');
    run();
    expectNoRealFixture();
    expect(backlogStatus()).toBe(initialStatus);
  });
});

describe('check-backlog-item warns on a new health smell with no sibling note (#4419)', () => {
  const smell = 'we:scripts/conveyor/health-smells/proof-only-4419.mjs';
  const smellCard = (extra) => `---
kind: task
status: open
dateOpened: "2026-10-07"
scope: ["${smell}"]
tags: []
---

# per-item checker health-smell fixture

A digest with no code paths in it at all.

${extra}
`;
  const writeSmell = (extra) => writeFileSync(join(tmp, `${ID}-per-item-checker-wiring-fixture.md`), smellCard(extra));

  it('sibling smell warning through check:item, quiet once the note is added', () => {
    writeSmell('Nothing to see here.');
    const flagged = run();
    expect(flagged.out).toMatch(/new health smell/);
    expect(flagged.out).toContain('proof-only-4419.mjs');
    writeSmell('Sibling smells grepped: none overlap.');
    expect(run().out).not.toMatch(/new health smell/);
  });
});
