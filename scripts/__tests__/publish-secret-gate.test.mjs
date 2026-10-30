/**
 * @file publish-secret-gate.test.mjs — ADVERSARIAL proof of the #3015 publish-seam secret gate.
 *
 * THE ACCEPTANCE THIS FILE OWNS. "The scrub is called earlier in the code" is not evidence that a secret
 * cannot be committed. So every test here drives a REAL write path end-to-end — the actual `backlog.mjs`
 * CLI as a subprocess, the actual `backlog-guard.mjs`/`check-memory.mjs` PreToolUse hooks fed a real hook
 * event on stdin, the actual `check-standards.mjs` corpus sweep — pushes a known synthetic marker through
 * it, and then asserts against the FILESYSTEM that the marker did not land. The four gates cover the four
 * ways content actually reaches a committed file:
 *
 *   1. the backlog CLI funnel   (`scaffold`/`resolve`/… → `writeBacklogMd`)      — a Bash-invoked `fs` write
 *   2. the backlog Edit/Write hook (`backlog-guard.mjs --pre`)                    — an agent editing a card
 *   3. the memory Edit/Write hook (`check-memory.mjs --pre`)                      — the ONLY memory gate
 *   4. the `check:standards` corpus sweep                                         — the bypass backstop
 *
 * Each gate has a companion NEGATIVE case that pushes ordinary, correct content — a `we:`-prefixed repo
 * path citation, the shape #883 and the #2978 Grounding filter both REQUIRE — through the same path and
 * asserts it passes. A gate that blocks correct authorship is a gate that gets turned off.
 *
 * THE MARKER IS SYNTHETIC. `sk-SYNTHETIC0000TESTMARKERNOTREAL` was never issued by any service and matches
 * no live credential; it is shaped only to trip the `sk-`-prefix rule. No real secret appears in this repo.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url))); // .../scripts
const ROOT = dirname(SCRIPTS);

/** The one marker every real-path test writes. Obviously synthetic — never a live credential. */
const MARKER = 'sk-SYNTHETIC0000TESTMARKERNOTREAL';
/** Ordinary, correct authorship: a `we:`-prefixed citation. Must pass every gate. */
const CLEAN = 'Grounded in we:scripts/lib/secret-scrub.mjs — the pure publish-seam detector.';

let clone;
beforeAll(() => {
  // Same throwaway-clone substrate as backlog-cli-snapshot.test.mjs: copy the real scripts/ tree so each
  // CLI's own ROOT (from its COPIED import.meta.url) resolves inside the throwaway dir. Any write these
  // tests provoke lands there, never in this lane's real backlog/.
  // realpath: on macOS `mkdtempSync` returns a `/var/...` path whose real location is `/private/var/...`,
  // and both check-memory.mjs and check-standards.mjs gate their CLI body on
  // `fileURLToPath(import.meta.url) === process.argv[1]`. An unresolved path makes that comparison false, so
  // the script silently does NOTHING and exits 0 — a green test proving only that nothing ran.
  clone = realpathSync(mkdtempSync(join(tmpdir(), 'we-publish-secret-gate-')));
  execFileSync('cp', ['-R', SCRIPTS, join(clone, 'scripts')]);
  cpSync(join(ROOT, 'skills-src/conveyor/daemon-manifest.mjs'),
    join(clone, 'skills-src/conveyor/daemon-manifest.mjs'));
  // The transcript check imports this skill module during CLI startup.
  cpSync(join(ROOT, 'skills-src', 'inspect-codex-transcript'),
    join(clone, 'skills-src', 'inspect-codex-transcript'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(clone, 'node_modules'), 'dir');
  mkdirSync(join(clone, '.claude', 'skills', 'batch-backlog-items'), { recursive: true });
  mkdirSync(join(clone, 'backlog'), { recursive: true });
});
afterAll(() => { try { rmSync(clone, { recursive: true, force: true }); } catch { /* best-effort */ } });

const run = (script, args, opts = {}) => spawnSync(process.execPath, [join(clone, 'scripts', script), ...args], {
  cwd: clone, encoding: 'utf8', input: opts.input ?? '', env: { ...process.env, ...(opts.env ?? {}) },
});
const backlogFiles = () => readdirSync(join(clone, 'backlog')).filter((f) => f.endsWith('.md'));

// ── 1. the backlog CLI funnel — `scaffold` writes straight to `fs`, past every PreToolUse hook ────────
describe('gate 1 — `backlog.mjs scaffold` (the CLI funnel: no hook can see this write)', () => {
  beforeEach(() => { for (const f of backlogFiles()) rmSync(join(clone, 'backlog', f)); });

  it('REFUSES a synthetic credential in --digest, and leaves NO file on disk', () => {
    const before = backlogFiles();
    const r = run('backlog.mjs', [
      'scaffold', '--kind=story', '--size=1',
      '--title=adversarial publish-seam probe',
      `--digest=${MARKER}`,
    ]);
    // (a) FIRST — the assertion that actually matters: nothing was persisted. Asserted ahead of the exit
    // code deliberately. A gate downgraded from `die()` to a warning still prints the right words and still
    // writes the file; if the exit-code assertion ran first it would fail first, and the filesystem check
    // — the only one that proves the marker never landed — would never execute.
    expect(backlogFiles(), `stdout=${r.stdout} stderr=${r.stderr}`).toEqual(before);
    for (const f of backlogFiles()) expect(readFileSync(join(clone, 'backlog', f), 'utf8')).not.toContain(MARKER);
    // (b) and the process refused, with the reason.
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/secret-scrub/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/api-key-shaped token/);
  });

  it('scaffolds normally when the digest is ordinary prose citing a we:-prefixed path', () => {
    const r = run('backlog.mjs', [
      'scaffold', '--kind=story', '--size=1',
      '--title=ordinary publish-seam control',
      `--digest=${CLEAN}`,
    ]);
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
    const written = backlogFiles();
    expect(written).toHaveLength(1);
    expect(readFileSync(join(clone, 'backlog', written[0]), 'utf8')).toContain('secret-scrub.mjs');
  });
});

// ── 2. the backlog Edit/Write hook — a card body edited by the agent's own tools ──────────────────────
describe('gate 2 — `backlog-guard.mjs --pre` (the Edit/Write path into a card)', () => {
  const CARD = 'backlog/x4242ab-adversarial-probe.md'; // hash id: the guard's OTHER rule bans a hand-picked NNN
  const body = (extra) => `---\nkind: story\nsize: 1\nstatus: open\n---\n\nAn ordinary first paragraph so the summary is non-empty. ${extra}\n`;
  const preEvent = (content) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(clone, CARD), content } });

  // #3383 — the hand-authored-new-file DENY (below, gate 2b) now fires for ANY new backlog file, not just a
  // hand-numbered NNN one, so these two tests (which are about SECRET-SCRUB behaviour on a card body, not
  // about creation) pre-touch the card so it already exists — an Edit/overwrite of an EXISTING file, exactly
  // the case #3383's own widening leaves untouched. Gate 2b below tests the CREATION case on its own.
  beforeAll(() => { writeFileSync(join(clone, CARD), body('placeholder')); });

  it('DENIES (exit 2) an edit that would introduce the synthetic marker into a card body', () => {
    const r = run('backlog-guard.mjs', ['--pre'], { input: preEvent(body(`The value was ${MARKER}.`)) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/api-key-shaped token/);
    expect(r.stderr).toMatch(/COMMITTED and PUSHED/);
    // a denied PreToolUse never runs the write — the pre-existing placeholder body is untouched, not the marker
    expect(readFileSync(join(clone, CARD), 'utf8')).not.toContain(MARKER);
  });

  it('PASSES (exit 0) an edit that adds ordinary prose plus a we:-prefixed path', () => {
    const r = run('backlog-guard.mjs', ['--pre'], { input: preEvent(body(CLEAN)) });
    expect(r.status, r.stderr).toBe(0);
  });

  // #3015 review F7 — `backlog-guard.mjs --pre` runs the secret scrub BEFORE the hand-numbering
  // (id-hygiene) deny, on the stated rationale that "reporting the id-hygiene nit first would hide it"
  // (a leaked credential is the more severe of the two). Both rules can fire on the SAME write — a
  // hand-numbered NEW file whose body also carries a secret — and `deny()` exits on the first hit, so only
  // the ordering decides which message the author actually sees. Pin it directly rather than leaving the
  // rationale comment unverified.
  it('when BOTH rules would fire on the same write, the secret-scrub denial wins — not the id-hygiene one', () => {
    const numberedCard = 'backlog/9999-adversarial-ordering-probe.md'; // hand-numbered NNN-, not yet on disk
    const ev = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(clone, numberedCard), content: body(`The value was ${MARKER}.`) },
    });
    const r = run('backlog-guard.mjs', ['--pre'], { input: ev });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/api-key-shaped token/); // the secret-scrub reason
    expect(r.stderr).not.toMatch(/hand-numbered/); // NOT the id-hygiene reason — scrub ran first and exited
  });
});

// ── 2b. the WIDENED hand-authored-new-file DENY (#3383) — ANY new id shape, not just numeric ───────────
describe('gate 2b — `backlog-guard.mjs --pre` DENIES any brand-new backlog file made via the Write tool', () => {
  const body = 'An ordinary first paragraph so the summary is non-empty.';
  const preEvent = (rel, content) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(clone, rel), content } });

  it('DENIES a hash-shaped (xNNNNNN) brand-new file with a perfectly clean body — no secret involved', () => {
    const rel = 'backlog/x9f9f9f-brand-new-hash-probe.md';
    const r = run('backlog-guard.mjs', ['--pre'], { input: preEvent(rel, `---\nkind: task\n---\n\n${body}\n`) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hand-authored/);
    expect(existsSync(join(clone, rel))).toBe(false);
  });

  it('still DENIES a numeric brand-new file (the original #2288/#2323 rule, unchanged)', () => {
    const rel = 'backlog/8888-brand-new-numeric-probe.md';
    const r = run('backlog-guard.mjs', ['--pre'], { input: preEvent(rel, `---\nkind: task\n---\n\n${body}\n`) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hand-numbered/);
  });
});

// ── 3. the memory Edit/Write hook — memory files have NO CLI writer, so this is their only gate ───────
describe('gate 3 — `check-memory.mjs --pre` (the only write-time gate the memory corpus has)', () => {
  const TOPIC = 'agent-memory-src/999-adversarial-probe.md';
  const preEvent = (content) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(clone, TOPIC), content } });

  it('DENIES (exit 2) a new memory TOPIC file carrying the synthetic marker', () => {
    const r = run('check-memory.mjs', ['--pre'], { input: preEvent(`# Probe\n\nThe leaked value was ${MARKER}.\n`) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/api-key-shaped token/);
    expect(existsSync(join(clone, TOPIC))).toBe(false);
  });

  it('PASSES (exit 0) an otherwise-identical topic file whose only citation is a we:-prefixed path', () => {
    const r = run('check-memory.mjs', ['--pre'], { input: preEvent(`# Probe\n\n${CLEAN}\n`) });
    expect(r.status, r.stderr).toBe(0);
  });

  it('still no-ops on a non-memory path — the widened match did not become a catch-all', () => {
    const ev = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(clone, 'docs/notes.md'), content: MARKER } });
    expect(run('check-memory.mjs', ['--pre'], { input: ev }).status).toBe(0);
  });
});

// ── 4. the corpus sweep — the backstop for a write that used neither the CLI nor the hooks ────────────
//
// SCOPE OF THIS PROOF, stated honestly: unlike gates 1–3, this one is NOT driven as a subprocess. The full
// `check-standards.mjs` cannot run against a throwaway clone (it walks `src/`, `site/`, `node_modules/`), so
// a subprocess run here would prove nothing about the sweep and everything about the fixture. Instead the
// pure rule is exercised directly, and a separate assertion pins that `check-standards.mjs` still CALLS it —
// two OF THE WAYS this backstop can break (rule stops detecting; rule stops being wired) each have a test.
// A third way — the walk's glob silently matching zero files (e.g. `.endsWith('.md')` becoming
// `.endsWith('.mdx')`) — would still look "wired" from the call-site regex alone, so the wiring test below
// also pins the real call site's filter IN CONTEXT (not a bare global regex — this file has several other
// `.md` walks a global pattern would blindly match) and asserts the walk actually finds files.
describe('gate 4 — the `check:standards` corpus sweep (the bypass backstop)', () => {
  it('FLAGS a card that reached disk carrying the synthetic marker (a hook-bypassing write)', async () => {
    const { scanPublishSecrets } = await import('../check-standards-rules.mjs');
    const findings = scanPublishSecrets([
      { file: 'backlog/4243-bypassed-the-hooks.md', content: `---\nkind: story\n---\n\nSmuggled past both gates: ${MARKER}\n` },
      { file: 'agent-memory-src/999-probe.md', content: `# Probe\n\nAlso smuggled: ${MARKER}\n` },
    ]);
    expect(findings.map((f) => f.file)).toEqual(['backlog/4243-bypassed-the-hooks.md', 'agent-memory-src/999-probe.md']);
    expect(findings[0].reasons.join(' ')).toMatch(/api-key-shaped token/);
  });

  it('stays silent on the same files with ordinary we:-prefixed content', async () => {
    const { scanPublishSecrets } = await import('../check-standards-rules.mjs');
    expect(scanPublishSecrets([
      { file: 'backlog/4243-bypassed-the-hooks.md', content: `---\nkind: story\n---\n\n${CLEAN}\n` },
      { file: 'agent-memory-src/999-probe.md', content: `# Probe\n\n${CLEAN}\n` },
    ])).toEqual([]);
  });

  it('is actually WIRED into check-standards.mjs over both committed corpora', () => {
    // An unwired rule is the silent failure this backstop exists to prevent, and it looks exactly like a
    // passing rule from the outside. Pin the call site and the two directories it walks.
    const src = readFileSync(join(ROOT, 'scripts', 'check-standards.mjs'), 'utf8');
    expect(src).toMatch(/scanPublishSecrets\(docs\)/);
    expect(src).toMatch(/for \(const label of \['backlog', 'agent-memory-src'\]\)/);
    // #3015 review round 2, F4 — the call-site regex above proves the TEXT is there, not that the walk it
    // names actually finds any file. A REPLICA walk (below) only proves the repo tree has `.md` files
    // somewhere; it does not couple to the real call site's filter, so a mutation there
    // (`.endsWith('.md')` → `.endsWith('.mdx')`) survived it undetected — this file has several other
    // `.md` walks (e.g. the id-hygiene and reports scans above), so a bare global regex on `.endsWith('.md')`
    // would be just as blind. Pin the filter IN CONTEXT, scoped to this walk block specifically, so the
    // mutation this test names is the one it actually catches.
    // #4168 — the walk now lists through `scopedReaddir(dirRel, exts)` (so `--local --files=…` scopes it),
    // which makes the `.md` filter its `['.md']` extension argument instead of an inline `.endsWith('.md')`.
    // Pin THAT argument in context: the same `.md` → `.mdx` mutation is still what this assertion catches.
    expect(src).toMatch(
      /for \(const label of \['backlog', 'agent-memory-src'\]\)[\s\S]{0,400}?scopedReaddir\(`\$\{label\}\/`, \['\.md'\]\)/,
    );
    const docs = [];
    for (const label of ['backlog', 'agent-memory-src']) {
      const dir = join(ROOT, label);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) docs.push(`${label}/${f}`);
    }
    expect(docs.length).toBeGreaterThan(0);
  });
});

// ── 5. the REAL corpus is clean right now ────────────────────────────────────────────────────────────
describe('the committed corpus this gate was calibrated against', () => {
  it('carries no publish-seam finding today (the sweep would be red on the next close otherwise)', async () => {
    const { scrubPublish } = await import('../lib/secret-scrub.mjs');
    const hits = [];
    for (const dir of ['backlog', 'agent-memory-src']) {
      const abs = join(ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs).filter((n) => n.endsWith('.md'))) {
        const reasons = scrubPublish(readFileSync(join(abs, f), 'utf8'));
        if (reasons.length) hits.push(`${dir}/${f}: ${reasons.join('; ')}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
