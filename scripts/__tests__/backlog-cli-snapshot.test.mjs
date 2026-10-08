/**
 * @file backlog-cli-snapshot.test.mjs — #2273 Tier-A CLI-level integration-smoke layer, on the #2274
 * ephemeral-throwaway-clone substrate: `mkdtempSync` + a copy of the real `scripts/` tree (so the CLI's
 * own `ROOT`, derived from its copied `import.meta.url`, resolves INSIDE the throwaway clone — never the
 * real repo), run the REAL `node scripts/backlog.mjs <verb>` subprocess, assert its actual exit code +
 * the resulting file content on disk, `rmSync` in teardown.
 * The shared clone skips `__tests__` dirs; the lane-guard test moves (not copies) the tree.
 *
 * This complements `golden-corpus-snapshot.test.mjs` (which replays the full 92-fixture historical
 * corpus, but only at the pure-function layer — `applyTransition`/`applySettle` take an injected `today`,
 * so a byte-for-byte replay of a historically-DATED fixture is only possible there). The real CLI stamps
 * `dateStarted`/`dateResolved` from the wall clock (`scripts/backlog.mjs`'s `today()`), so it cannot
 * reproduce a fixture's historical date — this file instead proves the CLI WIRING around that pure core
 * (arg parsing → file resolution by NNN → the CLI-only guards `applyTransition` doesn't own, like the
 * #658 no-open-slice epic guard → the write → the real process exit code), using freshly-authored cases
 * where "today" is naturally correct. A handful of representative cases, not the full corpus — the corpus
 * itself is exhaustively covered at the pure layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const WE_SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // .../scripts (this file is scripts/__tests__/*)

// #2747 — the expected stamp is derived INDEPENDENTLY of the CLI's own helper: shift the epoch by the
// offset `Date` itself reports, then slice the UTC ISO. Pure arithmetic — no `Intl`, no zone name, and
// no import of `scripts/lib/local-date.mjs` — so this oracle cannot inherit a bug from the code it
// judges (docs/agent/platform-decisions.md #deterministic-oracle-clears-slice). It goes red on a
// UTC-behind host during the evening window; the zone-pinned block at the bottom of this file is the
// companion that stays red even on a UTC CI host, where offset arithmetic and UTC agree.
const hostLocalDay = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TODAY = hostLocalDay();

// The CLI never imports test files or fixtures, so omit their directories from the clone.
const skipTestDirs = (source) => basename(source) !== '__tests__';

let clone;
beforeAll(() => {
  clone = mkdtempSync(join(tmpdir(), 'we-backlog-cli-snapshot-'));
  // Copy the real scripts/ tree without test directories so backlog.mjs's own ROOT (derived from ITS OWN copied
  // import.meta.url) resolves inside the throwaway clone, not the real repo — the mutation genuinely
  // lands only in `clone/backlog/*`, never touches this lane's real `backlog/`.
  cpSync(WE_SCRIPTS_DIR, join(clone, 'scripts'), { recursive: true, filter: skipTestDirs });
  // `claim`/`resolve`/etc unconditionally re-save reservations/claims state alongside the frontmatter
  // write (best-effort convenience bookkeeping, not gated on it existing) — seed empty state so that
  // save doesn't ENOENT on a directory this throwaway clone never had a reason to create otherwise.
  mkdirSync(join(clone, '.claude', 'skills', 'batch-backlog-items'), { recursive: true });
});
afterAll(() => {
  try { rmSync(clone, { recursive: true, force: true }); } catch { /* best-effort teardown */ }
});

const BACKLOG_MJS = () => join(clone, 'scripts', 'backlog.mjs');
const backlogPath = (rel) => join(clone, 'backlog', rel);
const write = (rel, content) => { mkdirSync(join(clone, 'backlog'), { recursive: true }); writeFileSync(backlogPath(rel), content); };
const read = (rel) => readFileSync(backlogPath(rel), 'utf8');

/**
 * The child env. `BACKLOG_TZ` is dropped by default so the CLI stamps in the HOST's local zone — the one
 * `hostLocalDay()` above computes. `overrides` pins it for the zone-pinned cases at the bottom of the file.
 */
function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!overrides.BACKLOG_TZ) delete env.BACKLOG_TZ;
  return env;
}

/** Run the real CLI subprocess against the throwaway clone; never throws — captures exit code + output. */
function run(args, envOverrides = {}) {
  try {
    const stdout = execFileSync('node', [BACKLOG_MJS(), ...args, '--json'], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(envOverrides) });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (e) {
    let json;
    try { json = JSON.parse(e.stdout); } catch { /* not JSON (a die() before JSON_MODE parsed, or a crash) */ }
    return { code: typeof e.status === 'number' ? e.status : 1, json, stdout: e.stdout, stderr: e.stderr };
  }
}

/** Run the real CLI WITHOUT `--json` to capture the human-readable stdout (the message text this file asserts on). */
function runHuman(args) {
  try {
    const stdout = execFileSync('node', [BACKLOG_MJS(), ...args], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const item = (fields, body = '# Title\n\nBody.\n') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;

describe('backlog.mjs CLI — ephemeral-clone integration smoke (#2273/#2274)', () => {
  it('claim: open → active, exit 0, stamps dateStarted=today', () => {
    write('9001-a.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['claim', '9001']);
    expect(res.code).toBe(0);
    expect(res.json.ok).toBe(true);
    const after = read('9001-a.md');
    expect(after).toContain('status: active');
    expect(after).toContain(`dateStarted: "${TODAY}"`);
    expect(after).toContain('# Title'); // body untouched
  });

  // #2621: the two-turn "rename the chat / ⏸ stop here" message stalls a background delivery agent (no human
  // to end the turn), so `claim` suppresses it for a conveyor/background session — detected by a `conveyor-*`
  // session slug or an explicit `--background` flag. An item is claimable ONCE (open→active), so each case
  // below uses a FRESH item and a single claim, asserting the human-readable stdout (the message text carries
  // the signal) plus the machine-readable `background` field.
  //
  // READ THIS BLOCK AS OF #xd0hvsg, NOT #2621: it described the carve-out as the exception to an otherwise
  // always-on stop, and that framing is dead. The stop is now opt-in for everyone; `--background` survives as
  // PRECEDENCE (it wins over `--stop-for-rename`), not as the only escape.

  // #xd0hvsg INVERTED THE DEFAULT. The stop belongs to the /next SELECTION hand-off, which now asks for it
  // with `--stop-for-rename`; every other caller proceeds in the same turn. Before this, `--background` was
  // the only way out and only the conveyor knew to pass it, so a batch (which labels its session ONCE) and
  // every directed claim were each told to stop and wait for a rename that was never coming.

  it('claim: the stop is NOT emitted by default — the plain claim proceeds in the same turn (#xd0hvsg)', () => {
    write('9020-int.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9020']);
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('claim turn — it ends here');
    expect(human.stdout).not.toContain('Rename this chat');
    expect(human.stdout).toContain('proceed with the work in the same turn');
    expect(human.stdout).toContain('9020'); // the slug is still reported, as data
    expect(read('9020-int.md')).toContain('status: active'); // it still really claims
  });

  it('claim: --stop-for-rename opts INTO the two-turn stop + rename prompt (#xd0hvsg, the /next path)', () => {
    write('9030-sel.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9030', '--stop-for-rename']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('claim turn — it ends here');
    expect(human.stdout).toContain('Rename this chat');
    expect(human.stdout).not.toContain('background session — no stop');
    expect(read('9030-sel.md')).toContain('status: active');
  });

  it('claim: --background still wins over --stop-for-rename — an agent must never stall (#2621)', () => {
    // The carve-out is the stronger claim: `--background` asserts there is NO human to end the turn, so a
    // caller that passes both is asking for a hand-off that cannot happen. Background wins.
    write('9031-both.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['claim', '9031', '--background', '--stop-for-rename']);
    expect(res.code).toBe(0);
    expect(res.json.background).toBe(true);
    expect(res.json.stop).toBe(false);
  });

  // #x0h3pe4 — the real `scaffold` subprocess never silently drops (or invents) a `--size`. The cards it writes
  // land in the throwaway clone's `backlog/`, so count/inspect that directory.
  describe('scaffold --size (#x0h3pe4)', () => {
    const cards = () => readdirSync(join(clone, 'backlog')).filter((f) => f.endsWith('.md'));
    const scaffoldOne = (args) => {
      mkdirSync(join(clone, 'backlog'), { recursive: true });
      const before = new Set(cards());
      const res = run(['scaffold', ...args]);
      const added = cards().filter((f) => !before.has(f));
      return { res, added, text: added[0] ? readFileSync(join(clone, 'backlog', added[0]), 'utf8') : '' };
    };

    it('a sized task is REFUSED: non-zero exit, no card written', () => {
      const { res, added } = scaffoldOne(['--kind=task', '--size=2', '--title=sized task']);
      expect(res.code).not.toBe(0);
      expect(res.json?.error).toMatch(/never sized/); // the refusal itself, not an unrelated crash
      expect(added).toEqual([]);
    });

    it('a non-numeric size is REFUSED: non-zero exit, no card written', () => {
      const { res, added } = scaffoldOne(['--kind=decision', '--size=big', '--title=bad size decision']);
      expect(res.code).not.toBe(0);
      expect(res.json?.error).toMatch(/must be a number/);
      expect(added).toEqual([]);
    });

    it('a whitespace-only size is absent for a decision (never `size: 0`)', () => {
      const { res, text } = scaffoldOne(['--kind=decision', '--size= ', '--title=blank size decision']);
      expect(res.code).toBe(0);
      expect(text).not.toMatch(/^size:/m);
    });

    it('a sized decision keeps its size', () => {
      const { res, text } = scaffoldOne(['--kind=decision', '--size=3', '--title=sized decision']);
      expect(res.code).toBe(0);
      expect(text).toMatch(/^size: 3$/m);
    });

    it('an EMPTY --size= is absent for a decision: card written with no size line (never `size: 0`)', () => {
      const { res, text } = scaffoldOne(['--kind=decision', '--size=', '--title=empty size decision']);
      expect(res.code).toBe(0);
      expect(text).toMatch(/^kind: decision$/m);
      expect(text).not.toMatch(/^size:/m);
    });
  });

  it('claim: the JSON payload reports stop=true only when it was asked for (#xd0hvsg)', () => {
    write('9028-a.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    write('9029-b.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    expect(run(['claim', '9028']).json.stop).toBe(false);
    expect(run(['claim', '9029', '--stop-for-rename']).json.stop).toBe(true);
  });

  it('claim: the JSON payload carries background=false for an interactive claim (#2621)', () => {
    write('9024-int.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['claim', '9024']);
    expect(res.code).toBe(0);
    expect(res.json.ok).toBe(true);
    expect(res.json.background).toBe(false);
  });

  it('claim: a conveyor session (--session=conveyor-*) suppresses the stop message (#2621)', () => {
    write('9021-conv.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9021', '--session=conveyor-9021']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('background session — no stop');
    expect(human.stdout).not.toContain('claim turn — it ends here');
    expect(human.stdout).not.toContain('Rename this chat');
    expect(read('9021-conv.md')).toContain('status: active'); // still really claims
  });

  it('claim: the JSON payload carries background=true for a conveyor claim (#2621)', () => {
    write('9025-conv.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['claim', '9025', '--session=conveyor-9025']);
    expect(res.code).toBe(0);
    expect(res.json.background).toBe(true);
  });

  it('claim: an explicit --background flag suppresses the stop message (#2621)', () => {
    write('9022-bg.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9022', '--background']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('background session — no stop');
    expect(human.stdout).not.toContain('claim turn — it ends here');
  });

  it('claim: a NON-conveyor --session is not treated as background (carve-out is conveyor-only, #2621/#xd0hvsg)', () => {
    // THIS TEST ASSERTED TWO THINGS AND ONLY ONE SURVIVED #xd0hvsg. (a) the BACKGROUND carve-out is
    // conveyor-only, so a batch slug must not slip into it — still true, still pinned below, and it is what
    // the title has always been about. (b) "…therefore a batch session gets the stop" — no longer true, and
    // it was never the carve-out's claim: it was the old default showing through. A batch labels its session
    // ONCE (`we:skills-src/batch-backlog-items/SKILL.md`), so a per-item stop was always wrong for it.
    write('9023-batch.md', item({ kind: 'story', size: 2, status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9023', '--session=batch-abc']);
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('background session — no stop'); // (a) — the carve-out did NOT fire
    expect(human.stdout).not.toContain('claim turn — it ends here');    // (b) — and no stop either, now
    expect(human.stdout).toContain('proceed with the work in the same turn');
  });

  it('claim --as=preparing under a conveyor session keeps the prep (non-stop) message, NOT the background line (#2621)', () => {
    // The carve-out is gated on `claimedStatus === 'active'`, so a `preparing` claim is never treated as
    // background — it already flows in one turn and must keep its own prep guidance, even under a conveyor slug.
    write('9026-prep.md', item({ kind: 'decision', status: 'open', dateOpened: '"2026-07-01"' }));
    const human = runHuman(['claim', '9026', '--as=preparing', '--session=conveyor-9026']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('claiming and preparing are one turn');
    expect(human.stdout).not.toContain('background session — no stop');
    expect(human.stdout).not.toContain('claim turn — it ends here');
    write('9027-prep.md', item({ kind: 'decision', status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['claim', '9027', '--as=preparing', '--session=conveyor-9027']);
    expect(res.code).toBe(0);
    expect(res.json.background).toBe(false); // preparing is never background
  });

  it('claim: refused on a non-open item, exit 1, file left untouched', () => {
    write('9002-b.md', item({ kind: 'task', status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-01"' }));
    const before = read('9002-b.md');
    const res = run(['claim', '9002']);
    expect(res.code).toBe(1);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toMatch(/expected "open"/);
    expect(read('9002-b.md')).toBe(before); // refused write never lands
  });

  it('resolve: active → resolved, exit 0, stamps dateResolved=today + graduatedTo', () => {
    write('9003-c.md', item({ kind: 'story', size: 3, status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-01"' }));
    const res = run(['resolve', '9003', '--graduated-to=we:scripts/example.mjs']);
    expect(res.code).toBe(0);
    const after = read('9003-c.md');
    expect(after).toContain('status: resolved');
    expect(after).toContain(`dateResolved: "${TODAY}"`);
    expect(after).toContain('graduatedTo: "we:scripts/example.mjs"');
  });

  it('resolve: a kind:decision refuses without codifiedIn (#911), exit 1', () => {
    write('9004-d.md', item({ kind: 'decision', status: 'open', dateOpened: '"2026-07-01"' }));
    const before = read('9004-d.md');
    const res = run(['resolve', '9004']);
    expect(res.code).toBe(1);
    expect(res.json.error).toMatch(/codifiedIn|codified/i);
    expect(read('9004-d.md')).toBe(before);
  });

  it('resolve: an epic with an open child is refused (#658 no-open-slice guard), exit 1', () => {
    write('9005-e.md', item({ kind: 'epic', status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-01"' }));
    write('9006-e-child.md', item({ kind: 'task', parent: '"9005"', status: 'open', dateOpened: '"2026-07-01"' }));
    const before = read('9005-e.md');
    const res = run(['resolve', '9005']);
    expect(res.code).toBe(1);
    expect(res.json.error).toMatch(/open child/i);
    expect(read('9005-e.md')).toBe(before); // the CLI-only guard refuses BEFORE any write
  });

  it('release: active → open, stamps left untouched, exit 0', () => {
    write('9007-f.md', item({ kind: 'story', size: 1, status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-05"' }));
    const res = run(['release', '9007']);
    expect(res.code).toBe(0);
    const after = read('9007-f.md');
    expect(after).toContain('status: open');
    expect(after).toContain('dateStarted: "2026-07-05"'); // release does NOT clear the stamp
  });

  it('settle: a born-active scaffold → open, drops scaffoldedBy/dateScaffolded, exit 0', () => {
    write('9008-g.md', item({ kind: 'task', status: 'active', scaffoldedBy: '"batch-x"', dateScaffolded: '"2026-07-01"', dateOpened: '"2026-07-01"' }));
    const res = run(['settle', '9008']);
    expect(res.code).toBe(0);
    const after = read('9008-g.md');
    expect(after).toContain('status: open');
    expect(after).not.toMatch(/^scaffoldedBy:/m);
    expect(after).not.toMatch(/^dateScaffolded:/m);
  });

  it('settle: refuses a normally-claimed (non-scaffold) item, exit 1, file untouched', () => {
    write('9009-h.md', item({ kind: 'task', status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-01"' }));
    const before = read('9009-h.md');
    const res = run(['settle', '9009']);
    expect(res.code).toBe(1);
    expect(res.json.error).toMatch(/scaffoldedBy|scaffold/i);
    // Pin the actual redirect: a normally-claimed item is closed by `resolve`, not `release` — the two
    // verbs mean very different things (finish vs. abandon-back-to-open), so this wording is load-bearing.
    expect(res.json.error).toMatch(/closed by resolve/);
    expect(read('9009-h.md')).toBe(before);
  });

  it('prioritize --to=low: sets the priority field, exit 0, status/body untouched', () => {
    write('9010-i.md', item({ kind: 'story', size: 3, status: 'open', dateOpened: '"2026-07-01"' }));
    const res = run(['prioritize', '9010', '--to=low']);
    expect(res.code).toBe(0);
    expect(res.json.ok).toBe(true);
    const after = read('9010-i.md');
    expect(after).toContain('priority: low');
    expect(after).toContain('status: open'); // status untouched
    expect(after).toContain('# Title'); // body untouched
  });

  it('prioritize --clear: removes the priority field, returning to the default', () => {
    write('9011-j.md', item({ kind: 'story', size: 3, status: 'open', priority: 'low', dateOpened: '"2026-07-01"' }));
    const res = run(['prioritize', '9011', '--clear']);
    expect(res.code).toBe(0);
    const after = read('9011-j.md');
    expect(after).not.toMatch(/^priority:/m);
    expect(after).toContain('status: open');
  });

  it('prioritize: refuses a bad token / a resolved item, exit 1, file untouched', () => {
    write('9012-k.md', item({ kind: 'story', status: 'open', dateOpened: '"2026-07-01"' }));
    const before = read('9012-k.md');
    expect(run(['prioritize', '9012', '--to=HIGH!']).code).toBe(1); // not a simple lowercase token
    expect(read('9012-k.md')).toBe(before);
    write('9013-l.md', item({ kind: 'story', status: 'resolved', dateResolved: '"2026-07-01"', dateOpened: '"2026-07-01"' }));
    expect(run(['prioritize', '9013', '--to=low']).code).toBe(1); // resolved refused without --force
  });

  it('an unknown item reference exits 1 without touching the tree', () => {
    const res = run(['claim', '9999']);
    expect(res.code).toBe(1);
  });
});

// #4308 — the sanctioned CLI verb for the drain's TRACKED (never git-ignored) land-time overlap-yield
// settings file. `WE_SCRIPTS_DIR/drain-overlap-yield-config.json` was copied wholesale into the clone by
// `cpSync` above, so `--show` here reads the REAL shipped default (`enabled:true, windowMinutes:45`).
describe('backlog.mjs CLI — overlap-yield-config (#4308)', () => {
  const configPath = () => join(clone, 'scripts', 'drain-overlap-yield-config.json');

  it('--show reads the shipped default (enabled:true, windowMinutes:45)', () => {
    const res = run(['overlap-yield-config', '--show']);
    expect(res.code).toBe(0);
    expect(res.json.config).toEqual({ enabled: true, windowMinutes: 45 });
  });

  it('--set-window=<n> persists just that field, never merged/overwritten silently', () => {
    expect(run(['overlap-yield-config', '--set-window=20']).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ enabled: true, windowMinutes: 20 });
    expect(run(['overlap-yield-config', '--set-enabled=false']).code).toBe(0);
    // enabled flips; the window just set is UNTOUCHED (a read-modify-write, not a fresh default overwrite).
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ enabled: false, windowMinutes: 20 });
    // restore for any later test in this file that assumes the shipped default.
    expect(run(['overlap-yield-config', '--set-enabled=true', '--set-window=45']).code).toBe(0);
  });

  it('a non-positive/non-numeric --set-window is refused — exit 1, file untouched', () => {
    const before = readFileSync(configPath(), 'utf8');
    expect(run(['overlap-yield-config', '--set-window=0']).code).toBe(1);
    expect(run(['overlap-yield-config', '--set-window=abc']).code).toBe(1);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  // #4417 item 6 — only the literal strings true/false are accepted; everything else is a usage error.
  it('--set-enabled accepts only literal true/false — yes/1/TRUE are refused, file untouched', () => {
    const before = readFileSync(configPath(), 'utf8');
    for (const bad of ['yes', '1', 'TRUE']) {
      expect(run(['overlap-yield-config', `--set-enabled=${bad}`]).code, `--set-enabled=${bad}`).toBe(1);
    }
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  it('a negative or non-finite --set-window is refused, file untouched', () => {
    const before = readFileSync(configPath(), 'utf8');
    expect(run(['overlap-yield-config', '--set-window=-5']).code).toBe(1);
    expect(run(['overlap-yield-config', '--set-window=Infinity']).code).toBe(1);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  // #4417 item 2 — the primary-checkout lane-guard refusal. Moving scripts/ under a `webeverything` dir
  // (a PRIMARY_REPOS name) resolves as the shared primary checkout.
  it('refuses to mutate the config from a primary checkout (lane-guard), file untouched', () => {
    const primary = join(clone, 'ws', 'webeverything');
    mkdirSync(primary, { recursive: true });
    renameSync(join(clone, 'scripts'), join(primary, 'scripts'));
    try {
      const cfg = join(primary, 'scripts', 'drain-overlap-yield-config.json');
      const before = readFileSync(cfg, 'utf8');
      let code = 0; let out = '';
      try {
        out = execFileSync('node', [join(primary, 'scripts', 'backlog.mjs'), 'overlap-yield-config', '--set-window=7', '--json'], { cwd: primary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
      } catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
      expect(code).toBe(1);
      expect(out).toContain('BLOCKED');
      expect(readFileSync(cfg, 'utf8')).toBe(before);
    } finally {
      renameSync(join(primary, 'scripts'), join(clone, 'scripts'));
    }
  });

});

// #2747 — the deliverable is that the REAL CLI stamps the OPERATOR's calendar day, not the runtime's UTC
// day. The assertions above cannot prove that on a UTC host (CI), where the two agree. This block pins
// the CLI's stamp under two zones held 25 hours apart, so their calendar days ALWAYS differ, at every
// instant. A CLI that stamps `new Date().toISOString().slice(0, 10)` (the exact defect this item fixes)
// returns the same UTC day for both and fails the first assertion — deterministically, on every host.
// The per-zone expectation is again pure epoch arithmetic, never `localToday()`.
describe('backlog.mjs CLI — the stamped date follows the operator zone, not UTC (#2747)', () => {
  const ZONES = [
    { tz: 'Pacific/Kiritimati', offsetHours: +14 }, // UTC+14, no DST
    { tz: 'Pacific/Niue', offsetHours: -11 },       // UTC-11, no DST
  ];
  /** The calendar day in a FIXED-offset zone, by shifting the epoch — no Intl, no local-date import. */
  const dayAtOffset = (offsetHours, at = Date.now()) =>
    new Date(at + offsetHours * 3600_000).toISOString().slice(0, 10);

  it('claim under a UTC+14 pin and a UTC-11 pin stamp DIFFERENT calendar days', () => {
    const stamped = ZONES.map(({ tz, offsetHours }, i) => {
      const rel = `95${i}0-tz.md`;
      write(rel, item({ kind: 'task', status: 'open', dateOpened: '"2026-07-01"' }));
      const before = dayAtOffset(offsetHours);
      const res = run(['claim', String(9500 + i * 10)], { BACKLOG_TZ: tz });
      const after = dayAtOffset(offsetHours);
      expect(res.code).toBe(0);
      const m = read(rel).match(/^dateStarted: "(\d{4}-\d{2}-\d{2})"$/m);
      expect(m, `no dateStarted stamped for ${tz}`).toBeTruthy();
      // Two samples straddle the (rare) midnight-crossing race; either is correct.
      expect([before, after]).toContain(m[1]);
      return m[1];
    });
    // 25 hours apart ⇒ the two zones are never on the same calendar day. A UTC stamp makes these equal.
    expect(stamped[0]).not.toBe(stamped[1]);
  });

  it('resolve stamps dateResolved in the pinned zone too', () => {
    write('9530-tz.md', item({ kind: 'task', status: 'active', dateOpened: '"2026-07-01"', dateStarted: '"2026-07-01"' }));
    const before = dayAtOffset(+14);
    const res = run(['resolve', '9530'], { BACKLOG_TZ: 'Pacific/Kiritimati' });
    const after = dayAtOffset(+14);
    expect(res.code).toBe(0);
    const m = read('9530-tz.md').match(/^dateResolved: "(\d{4}-\d{2}-\d{2})"$/m);
    expect(m).toBeTruthy();
    expect([before, after]).toContain(m[1]);
  });

  it('an invalid BACKLOG_TZ pin fails the CLI loudly instead of stamping a silently-wrong day', () => {
    write('9540-tz.md', item({ kind: 'task', status: 'open', dateOpened: '"2026-07-01"' }));
    const before = read('9540-tz.md');
    const res = run(['claim', '9540'], { BACKLOG_TZ: 'America/Toronoto' });
    expect(res.code).not.toBe(0);
    expect(read('9540-tz.md')).toBe(before); // no half-written stamp
  });
});
