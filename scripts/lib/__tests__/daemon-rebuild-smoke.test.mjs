/** @file xhiqxz3 — the daemon's TICK rebuild runs the real dispatch smoke (#4481's) inside its candidate smoke, so
 * an overlay that breaks the worker launch is never adopted. Real-git fixtures; the worker launch is injected. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { addOverlay, readOverlayState } from '../daemon-overlays.mjs';
import { dispatchSmokeSuspects } from '../daemon-rebuild/smoke.mjs';
import { checkDaemonEntriesBoot, DAEMON_ENTRIES_ENV } from '../daemon-boot-smoke.mjs';
import { CUT_MARKER, redactDetail, redactSecrets, redactedTail } from '../daemon-rebuild/smoke-classify/redact-detail.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

const tempDirs = [];
function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function pushBranch(originDir, ref, mutate, from = 'origin/main') {
  const dir = join(mktemp('we-rebuild-dsmoke-author-'), 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', ref, from]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

function makeFixture() {
  const base = mktemp('we-rebuild-dsmoke-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  writeFile(cloneDir, 'scripts/operations/dispatch-lane-io.mjs', 'export const v = 1;\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']);
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-dsmoke-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-dsmoke-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-dsmoke-overlay-'),
  };
  return { originDir, cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
const SETTINGS = {
  dispatchSmoke: 'on', dispatchPaths: ['scripts/operations/dispatch-lane-io.mjs'], noPr: 'warn', smokeTimeoutMs: 60_000, smokeKind: 'ci-heal',
};
const head = (f) => gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim();
const rebuild = (f, run, { settings = SETTINGS, runSmoke = vi.fn(async () => PASS) } = {}) => rebuildClone({
  root: f.cloneDir, env: f.env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
  dispatchSmoke: { settings, run },
});
function addDispatchOverlay(f, ref = 'lane/s3b', file = 'scripts/operations/dispatch-lane-io.mjs') {
  const sha = pushBranch(f.originDir, ref, (dir) => writeFile(dir, file, `export const v = '${ref}';\n`));
  addOverlay(f.cloneDir, { ref, pr: 77, addedBy: 't' }, { env: f.env });
  return sha;
}
const refs = (f) => readOverlayState(f.cloneDir, { env: f.env }).overlays.map((o) => o.ref);

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('xhiqxz3 — dispatch smoke inside the tick rebuild', () => {
  it('preserves signal diagnostics and stderr tails in held state and self-sync alerts', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const tail = Array.from({ length: 30 }, (_, i) => `native stack frame ${i}: ${'x'.repeat(40)}`).join('\n');
    const boot = await checkDaemonEntriesBoot({ root: f.cloneDir,
      env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' },
      runChild: async () => { throw Object.assign(new Error('native abort'), {
        signal: 'SIGTRAP', status: null, stderr: `warning\n${tail}\nghp_secret`,
      }); },
    });
    const result = await rebuildClone({ root: f.cloneDir,
      env: { ...f.env, WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' },
      prState: async () => null, lockOpts: LOCK_OPTS, log: { error() {} },
      runSmoke: async () => ({ verdict: 'code', smoke: { results: [
        { name: 'daemon-entries-boot', ...boot },
      ] } }),
    });
    expect(result.adopted).toBeFalsy();
    const held = readRebuildState(f.cloneDir, f.env).held;
    expect(held.details[0].detail).toContain('signal=SIGTRAP, exitCode=null');
    expect(held.details[0].detail).toContain('native stack frame 29');
    expect(held.details[0].detail).not.toContain('ghp_secret');
    const alert = result.alerts.find(a => a.kind === 'daemon-held-on-last-good');
    expect(alert.detail.details).toEqual(held.details);
    const stale = result.alerts.find(a => a.kind === 'clone-held-stale');
    expect(stale.detail.broken.details).toEqual(held.details);
  });
  it('keeps timeout launch diagnostics in the failure alert, including all stderr tail lines', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const diagnostics = { wrapperPid: 42, wrapperAliveAtTimeout: true, launchStartedAt: '2026-10-16T00:00:00Z', sessionAppeared: false, transcriptAppeared: false, firstOutputMs: null,
      stderrTail: Array.from({ length: 30 }, (_, i) => `frame ${i} ${'x'.repeat(30)}`).join('\n') + '\nghp_secret' };
    const r = await rebuild(f, async () => ({ ok: false, reason: 'timeout', detail: 'launch timeout', diagnostics, attempts: [{ reason: 'timeout', diagnostics }] }));
    expect(r.adopted).toBeFalsy();
    const alert = r.alerts.find((a) => a.kind === 'dispatch-smoke-failed').detail;
    expect(alert.diagnostics).toMatchObject({ wrapperPid: 42, wrapperAliveAtTimeout: true, firstOutputMs: null });
    expect(alert.diagnostics.stderrTail).toContain('frame 29');
    expect(alert.diagnostics.stderrTail).not.toContain('ghp_secret');
    expect(alert.attempts[0].diagnostics).toEqual(alert.diagnostics);
  });
  it('a definite dispatch-smoke failure persists no secret and no unbounded detail in any sink', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const secrets = ['ghp_secretAAAA', 'sk-ant-api03-secretCCCC', 'npm_secretDDDDDDDDDDDDDDDDDDDD', 'Bearer secretEEEE'];
    const detail = `worker exited; stderr ${secrets.join(' ')} ${'z'.repeat(20_000)}`;
    const r = await rebuild(f, async () => ({ ok: false, reason: 'no-commands-ran', detail, diagnostics: { stderrTail: secrets.join('\n') } }));
    expect(r.adopted).toBeFalsy();
    expect(refs(f)).toEqual([]);
    const dir = f.env.WE_DAEMON_OVERLAY_DIR;
    const events = readdirSync(dir).filter((n) => n.endsWith('.events.jsonl'))
      .flatMap((n) => readFileSync(join(dir, n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    const dropped = events.find((e) => e.kind === 'dropped-dispatch-smoke-failed');
    expect(dropped.reason).toContain('dispatch-smoke-failed: no-commands-ran');
    expect(dropped.reason.length).toBeLessThanOrEqual(500);
    const sinks = [JSON.stringify(events), JSON.stringify(readRebuildState(f.cloneDir, f.env)), JSON.stringify(r.alerts)];
    for (const s of secrets) for (const sink of sinks) expect(sink).not.toContain(s);
  });
  it.each([
    ['SERVICE_KEY=opaqueCredential123', 'SERVICE_KEY=<redacted>'],
    ['export PRIVATE_KEY="opaqueCredential123"', 'export PRIVATE_KEY=<redacted>'],
    ['"stripe-key": "opaqueCredential123"', 'stripe-key=<redacted>'],
    ['KEY: opaqueCredential123', 'KEY=<redacted>'],
    ['config serviceKey=opaqueCredential123', 'config serviceKey=<redacted>'],
    ['--signing-key opaqueCredential123', '--signing-key=<redacted>'],
    // A plain word before the assignment must not swallow it.
    ['monkey token=opaqueCredential123', 'monkey token=<redacted>'],
    ['Auth token=opaqueCredential123', 'Auth token=<redacted>'],
    ['monkey: token=opaqueCredential123', 'token=<redacted>'],
    ['hockey:token=opaqueCredential123', 'token=<redacted>'],
    ['--hotkey --token opaqueCredential123', '--token=<redacted>'],
    ['PRIVATEKEY=opaqueCredential123', 'PRIVATEKEY=<redacted>'],
    ['passkey: opaqueCredential123', 'passkey=<redacted>'],
    ['"token": "ab\\"opaqueCredential123"', 'token=<redacted>'],
    [`${String.fromCharCode(0xff34, 0xff2f, 0xff2b, 0xff25, 0xff2e)}=opaqueCredential123`, 'TOKEN=<redacted>'],
    [`TO${String.fromCharCode(0x200b)}KEN=opaqueCredential123`, 'TOKEN=<redacted>'],
  ])('redacts the generic key assignment %s', (line, expected) => {
    expect(redactSecrets(line)).not.toContain('opaqueCredential123');
    expect(redactSecrets(line)).toContain(expected);
  });
  it.each([
    ['indented (YAML)', (l) => `    ${l}`],
    ['trailing whitespace', (l) => `${l}   `],
    ['Node inspect', (l) => `  '${l}\\n' +`],
  ])('drops an orphaned PEM body written %s', (_shape, wrap) => {
    const body = Array.from({ length: 30 }, (_, n) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ${String(n).padStart(2, '0')}`);
    const text = ['head line', ...body.map(wrap), wrap('AbC='), '-----END PRIVATE KEY-----', 'tail'].join('\n');
    expect(redactSecrets(text)).not.toContain('MIIEvQ');
    expect(redactSecrets(text)).not.toContain('AbC=');
    expect(redactSecrets(text)).toContain('tail');
    expect(redactedTail(text)).not.toContain('MIIEvQ');
  });
  it('drops an orphaned PEM body escaped onto the END line itself (JSON), and a PGP key block', () => {
    const json = `{"blob":"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----\\n"}`;
    expect(redactSecrets(json)).not.toContain('MIIEvQ');
    expect(redactSecrets(json)).toContain('{"blob":"<redacted private key>');
    const pgp = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'lQOYBGVsecretbody', '-----END PGP PRIVATE KEY BLOCK-----', 'ok'].join('\n');
    expect(redactSecrets(pgp)).not.toContain('lQOYBGV');
    expect(redactSecrets(['lQOYBGVsecretbodyAAAAAAAA', '=AbCd', '-----END PGP PRIVATE KEY BLOCK-----'].join('\n'))).not.toContain('lQOYBGV');
  });
  it('keeps the key-name scan fast on hostile key runs', () => {
    const t0 = Date.now();
    for (const run of ['key', '_key', 'token', 'Key']) redactSecrets(run.repeat(Math.ceil(64 * 1024 / run.length)));
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
  it.each(['monkey=banana', 'hockey: score 3', 'turkey sandwich', 'keyboard: true'])('leaves a word merely ending in "key" alone: %s', (line) => {
    expect(redactSecrets(line)).toBe(line);
  });
  describe('redact first, then truncate — a quoted secret straddling a cut never leaks (operator send-back 2026-10-17)', () => {
    const quoted = '"password": "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa"';
    const leaked = (out) => ['bravo', 'charlie', 'oscar', 'papa'].filter((w) => out.includes(w));
    it('a quoted value straddling the 2,000-char per-line cut', () => {
      // `token=<1,900 chars>` shrinks to 16 on redaction, so text past the old cut would land inside the 500-char line.
      const line = `token=${'s'.repeat(1_900)} ${quoted}`;
      expect(line.indexOf('alpha')).toBeLessThan(2_000);
      expect(line.indexOf('papa')).toBeGreaterThan(2_000);
      const out = redactSecrets(line);
      expect(leaked(out)).toEqual([]);
      expect(out).toContain('password=<redacted>');
    });
    it('a quoted value straddling the 8,000-char cut of a non-boot detail', () => {
      const detail = `token=${'s'.repeat(7_950)}\n${quoted}`;
      expect(detail.indexOf('alpha')).toBeLessThan(8_000);
      expect(detail.indexOf('papa')).toBeGreaterThan(8_000);
      expect(leaked(redactDetail(detail))).toEqual([]);
    });
    it('a quoted value straddling the 64 KiB tail window of a line with no break', () => {
      const text = `"password": "${'secretword '.repeat(8_000)}" then FATAL`;
      expect(text.length).toBeGreaterThan(64 * 1024);
      const out = redactedTail(text);
      expect(out).not.toContain('secretword');
      expect(out).toContain('password=<redacted>');
    });
    it('withholds a line too long to redact whole instead of cutting it first', () => {
      const out = redactedTail(`"password": "${'secretword '.repeat(40_000)}"`);
      expect(out).not.toContain('secretword');
      expect(out).toMatch(/withheld/);
    });
    it('redacts a secret assignment whose name is longer than 200 chars', () => {
      expect(redactSecrets(`${'A'.repeat(195)}_TOKEN=abc123secret`)).not.toContain('abc123secret');
    });
    it('stays linear on whole long lines (JWT-shaped runs, orphaned-PEM tails, NFKC growth)', () => {
      const t0 = Date.now();
      redactSecrets('eyJ-'.repeat(16_384));
      redactedTail(`${'A'.repeat(16)}${'+'.repeat(32_768)}!\n-----END PRIVATE KEY-----`);
      expect(Date.now() - t0).toBeLessThan(2_000);
      // NFKC can grow text many times over; the bound applies to the normalised text too.
      expect(redactSecrets(String.fromCharCode(0xfdfa).repeat(200_000))).toMatch(/withheld/);
    });
    it('fails closed: when redaction cannot run, no detail is emitted', () => {
      const hostile = { toString() { throw new Error('boom ghp_secretAAAA'); } };
      for (const out of [redactSecrets(hostile), redactedTail(hostile), redactDetail(hostile), redactDetail(hostile, 'daemon-entries-boot')]) {
        expect(out).toMatch(/withheld/);
        expect(out).not.toContain('ghp_secret');
      }
    });
  });
  describe('redacts multiline quoted assignments before splitting stderr lines (PR 5460 round 8)', () => {
    const SECRET_WORDS = ['alpha', 'bravo', 'charlie', 'delta'];
    const leaks = (out) => SECRET_WORDS.filter((w) => out.includes(w));
    const sinks = (text) => ({
      redactSecrets: redactSecrets(text), redactedTail: redactedTail(text),
      redactDetail: redactDetail(text), bootDetail: redactDetail(text, 'daemon-entries-boot'),
    });
    it.each([
      ['a double-quoted value', 'DB_PASSWORD="alpha bravo\ncharlie delta"'],
      ['a single-quoted value', "DB_PASSWORD='alpha bravo\ncharlie delta'"],
      ['a backtick value', 'token: `alpha bravo\ncharlie delta`'],
      ['a triple-quoted value', 'password = """alpha "bravo"\ncharlie delta"""'],
      ['a value over three lines', 'export API_TOKEN="alpha\nbravo\ncharlie\ndelta"'],
      ['a CRLF and U+2028 split value', `DB_PASSWORD="alpha bravo\r\ncharlie${String.fromCharCode(0x2028)}delta"`],
      ['a JSON key with a multiline value', '{"password": "alpha bravo\ncharlie delta"}'],
      ['a flag with a multiline value', '--token "alpha bravo\ncharlie delta"'],
      ['a Node inspect concatenation', "{ password: 'alpha bravo\\n' +\n    'charlie delta' }"],
      ['a concatenation led by +', "secret = 'alpha bravo'\n  + 'charlie delta'"],
      ['a YAML block scalar', 'db:\n  password: |\n    alpha bravo\n    charlie delta\n  host: db.local'],
      ['a YAML folded scalar', 'password: >-\n  alpha bravo\n  charlie delta\nhost: db.local'],
      ['a YAML value on the next line', 'db:\n  password:\n    alpha bravo charlie delta\n  host: db.local'],
      // The shell joins `alpha\<newline>bravo…` into one word.
      ['a backslash-continued value', 'export DB_PASSWORD=alpha\\\nbravo\\\ncharliedelta'],
      // Self-review round: the quote before the name (`bash -x`), prefixed and adjacent quotes, curly quotes.
      ['a bash -x trace (quote before the name)', "+ export 'DB_PASSWORD=alpha bravo\ncharlie delta'"],
      ['a $-quoted value', "PASSWORD=$'alpha bravo\ncharlie delta'"],
      ['a raw triple-quoted value', 'password = r"""alpha bravo\ncharlie delta"""'],
      ['a parenthesised value', 'PASSWORD=("alpha bravo\ncharlie delta")'],
      ['adjacent shell quotes', `PASSWORD="alpha"'bravo\ncharlie delta'`],
      ['curly quotes', `password: ${String.fromCharCode(0x201c)}alpha bravo\ncharlie delta${String.fromCharCode(0x201d)}`],
      ['a subscript name', 'env["PASSWORD"] = "alpha bravo\ncharlie delta"'],
      ['a next-line quoted value', 'db:\n  password:\n    "alpha bravo\n    charlie delta"\n  host: db.local'],
    ])('%s never leaks a line of its value', (_shape, value) => {
      const text = `starting worker\n${value}\nFATAL: connection refused`;
      for (const [sink, out] of Object.entries(sinks(text))) expect([sink, leaks(out)]).toEqual([sink, []]);
      expect(redactSecrets(text)).toContain('FATAL: connection refused');
      expect(redactSecrets(text)).toContain('starting worker');
    });
    it('fails closed on an unterminated quoted value: the rest of the text is redacted', () => {
      const out = redactSecrets('ok\nDB_PASSWORD="alpha bravo\ncharlie delta\nmore');
      expect(leaks(out)).toEqual([]);
      expect(out.startsWith('ok\nDB_PASSWORD=<redacted>')).toBe(true);
    });
    it('treats a quoted value longer than its line bound as unterminated, never as closed by a far quote', () => {
      const body = Array.from({ length: 80 }, (_, n) => `alpha line ${n}`).join('\n');
      const out = redactSecrets(`DB_PASSWORD="${body}"\nafter`);
      expect(out).not.toContain('alpha');
    });
    it('keeps a closed multiline value from swallowing what follows it', () => {
      expect(redactSecrets('DB_PASSWORD="alpha\nbravo" exit=1\nnext line')).toBe('DB_PASSWORD=<redacted> exit=1\nnext line');
    });
    it('a line cut upstream (its quote left open) never lets the next pair\'s value through', () => {
      for (const text of ['DB_PASSWORD="alpha bravo…\nAPI_TOKEN="charlie delta"\nnext', 'DB_PASSWORD="alpha bravo…\nAPI_TOKEN="charlie delta\nnext']) {
        expect(leaks(redactSecrets(text))).toEqual([]);
        expect(leaks(redactedTail(text))).toEqual([]);
      }
    });
    it('a cut tail of long lines keeps its error message: the readings never swallow past the value bound', () => {
      const lines = Array.from({ length: 200 }, (_, n) => `frame ${n} ${'x'.repeat(1_200)}`);
      const out = redactSecrets([...lines, "Error: Cannot find module 'left-pad'", '    at require (node:internal)'].join('\n'), { cut: true });
      expect(out).toContain("Error: Cannot find module 'left-pad'");
    });
    it('many pairs in a cut text never overflow the stack (no withheld detail)', () => {
      const out = redactSecrets('key=1\n'.repeat(130_000), { cut: true });
      expect(out).not.toMatch(/withheld/);
      expect(out).toContain('key=<redacted>');
      // One long line of quoted pairs stays linear (a per-pair newline search to the end of text would not).
      const t0 = Date.now();
      redactSecrets('token="a" '.repeat(100_000), { cut: true });
      expect(Date.now() - t0).toBeLessThan(3_000);
    });
    it('a 64 KiB tail window that opens inside a multiline quoted value never leaks its tail', () => {
      const tail = Array.from({ length: 1_400 }, (_, n) => `tail line ${String(n).padStart(4, '0')} ${'x'.repeat(28)}`).join('\n');
      for (const q of ['"', "'", '`', '"""']) {
        // The 64 KiB window cuts the opener's line, so its first whole line (`bravo`) is inside the value.
        const text = `DB_PASSWORD=${q}${'y'.repeat(6_000)} alpha\nbravo\ncharlie delta${q} FATAL\n${tail}`;
        const cut = text.length - 64 * 1024;
        expect(cut).toBeGreaterThan(text.indexOf('DB_PASSWORD'));
        expect(cut).toBeLessThan(text.indexOf('bravo'));
        const out = redactedTail(text, 5_000);
        expect(leaks(out)).toEqual([]);
        expect(out).toContain('tail line 0000');
        expect(leaks(redactSecrets(`bravo\ncharlie delta${q} FATAL\nok`, { cut: true }))).toEqual([]);
      }
    });
    it('a text cut at its start (CUT_MARKER) is read as possibly opening inside a value, in every continuation shape', () => {
      for (const body of ['charlie delta" FATAL\nok', "  'charlie delta'\nok", '    charlie delta\nok', 'charlie delta\nok']) {
        expect(leaks(redactedTail(`${CUT_MARKER}\n${body}`))).toEqual([]);
        expect(redactedTail(`${CUT_MARKER}\n${body}`)).toContain('ok');
      }
      // Under the cut reading, the first quote may close the cut-off value — and may also OPEN one. Both are covered.
      expect(leaks(redactSecrets('x\nDB_PASSWORD="alpha\nbravo"\nok', { cut: true }))).toEqual([]);
      // Text that was never cut keeps its first line.
      expect(redactedTail('charlie delta\nok')).toContain('charlie delta');
    });
    it('the rebuild alert sink redacts a multiline quoted credential in a diagnostics stderr tail', async () => {
      const f = makeFixture();
      addDispatchOverlay(f);
      const stderrTail = 'boot\nDB_PASSWORD="alpha bravo\ncharlie delta"\nFATAL: refused';
      const diagnostics = { wrapperPid: 7, stderrTail };
      const r = await rebuild(f, async () => ({ ok: false, reason: 'timeout', detail: `launch timeout ${stderrTail}`, diagnostics, attempts: [{ reason: 'timeout', diagnostics }] }));
      const alert = r.alerts.find((a) => a.kind === 'dispatch-smoke-failed').detail;
      expect(alert.diagnostics.stderrTail).toContain('FATAL: refused');
      for (const sink of [JSON.stringify(r.alerts), JSON.stringify(readRebuildState(f.cloneDir, f.env))]) expect(leaks(sink)).toEqual([]);
    });
  });
  it('redactedTail redacts before it cuts: an orphaned PEM body, CR runs, and a hostile key=value run stay bounded', () => {
    const body = Array.from({ length: 40 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ');
    const orphan = [...body.slice(-20), '-----END PRIVATE KEY-----', 'after'].join('\n');
    expect(redactSecrets(orphan)).not.toContain('MIIEvQ');
    expect(redactSecrets(orphan)).toContain('after');
    // An orphan longer than any line cap (an 8192-bit key), and one whose final body line is short.
    const long = ['before', ...Array.from({ length: 120 }, (_, n) => `MIIJQgIBADANBgkqhkiG9w0BAQEFAASCCSwwggkoAgEAAoICAQ${String(n).padStart(3, '0')}`),
      'AbC=', '-----END RSA PRIVATE KEY-----', 'after'].join('\n');
    expect(redactSecrets(long)).not.toContain('MIIJQg');
    expect(redactSecrets(long)).not.toContain('AbC=');
    expect(redactSecrets(long).split('\n')).toEqual(['before', '<redacted private key>', 'after']);
    const cut = redactedTail(['-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----', 'x'.repeat(70 * 1024)].join('\n'));
    expect(cut).not.toContain('MIIEvQ');
    const crs = redactedTail(Array.from({ length: 30 }, () => 'p\r'.repeat(500)).join('\n'));
    expect(crs.split('\n')).toHaveLength(30);
    // A 64 KiB window with no newline is kept, not emptied.
    expect(redactedTail(`${'progress\r'.repeat(10_000)}FATAL: native abort`)).toContain('FATAL: native abort');
    expect(redactedTail(`${'x'.repeat(70_000)}FATAL`)).toHaveLength(500);
    const t0 = Date.now();
    redactedTail(Array.from({ length: 200 }, () => 'token'.repeat(400)).join('\n'), 200);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it('bounds and redacts daemon-entries-boot tails without losing the last frames', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const tail = Array.from({ length: 30 }, (_, i) => `frame ${i} ${'q'.repeat(5_000)}`).join('\n');
    // Long real-shaped entry paths, a long first message line, and a PEM key whose BEGIN line falls outside the tail.
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `skills-src/conveyor/some-long-daemon-entry-name-${x}.mjs`);
    const pem = ['-----BEGIN PRIVATE KEY-----', ...Array.from({ length: 40 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'), '-----END PRIVATE KEY-----'].join('\n');
    const boot = await checkDaemonEntriesBoot({ root: f.cloneDir,
      env: { [DAEMON_ENTRIES_ENV]: entries.join(',') }, log: { error() {} },
      runChild: async () => { throw Object.assign(new Error(`native abort ${'m'.repeat(900)}`), {
        signal: null, status: 1, stderr: `sk-ant-api03-secretCCCC npm_secretDDDDDDDDDDDDDDDDDDDD\n${pem}\n${'cr\r'.repeat(5_000)}\n${tail}`,
      }); },
    });
    for (const e of boot.entries) expect(e.stderrTail.split('\n').length).toBeLessThanOrEqual(30);
    const result = await rebuildClone({ root: f.cloneDir,
      env: { ...f.env, WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' },
      prState: async () => null, lockOpts: LOCK_OPTS, log: { error() {} },
      runSmoke: async () => ({ verdict: 'code', smoke: { results: [{ name: 'daemon-entries-boot', ...boot }] } }),
    });
    const held = readRebuildState(f.cloneDir, f.env).held;
    const text = held.details[0].detail;
    // Every failed entry keeps its name and exit code, even past the cap.
    for (const entry of entries) expect(text).toContain(`${entry} (signal=null, exitCode=1)`);
    expect(text.match(/frame 29/g)).toHaveLength(6);
    expect(text.match(/child failed \(signal=null, exitCode=1\)/g)).toHaveLength(6);
    expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ');
    expect(text).not.toContain('sk-ant-api03-secretCCCC');
    expect(text).not.toContain('npm_secretDDDDDDDDDDDDDDDDDDDD');
    expect(text).toContain('frame 29');
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(500);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(result.alerts)).not.toContain('sk-ant-api03-secretCCCC');
  });

  it('a candidate whose new overlay fails the dispatch smoke is never adopted; the clone stays on last-good', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addOverlay(f.cloneDir, { ref: 'lane/other', pr: 5, addedBy: 't' }, { env: f.env });
    pushBranch(f.originDir, 'lane/other', (dir) => writeFile(dir, 'other.txt', 'x'));
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'commands-denied', detail: 'This command requires approval' }));
    const r = await rebuild(f, run);
    expect(run).toHaveBeenCalledTimes(1);
    // It smokes the CANDIDATE worktree, never the live clone.
    expect(run.mock.calls[0][0].tree).not.toBe(f.cloneDir);
    expect(r.adopted).toBeFalsy();
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.held.reason).toBe('dispatch-smoke-failed');
    // Only the offending overlay is dropped; the other one stays registered.
    expect(refs(f)).toEqual(['lane/other']);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-failed');
    // The next tick builds main + the remaining overlay, with no dispatch smoke needed.
    const run2 = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    const r2 = await rebuild(f, run2);
    expect(r2.adopted).toBe(true);
    expect(run2).not.toHaveBeenCalled();
  });

  it.each(['dispatch dry-run ok', 'dispatch dry-run failed (1/9): fix failed'])(
    'names slow passes in timings and alerts for %s', async (prefix) => {
      const f = makeFixture();
      addDispatchOverlay(f);
      const log = { error: vi.fn() };
      let clock = Date.now();
      const detail = `${prefix} — review 1ms, fix 0ms, reconcile-fix-pass 81.3s, reconcile-ci-heal-pass 41.8s, reconcile-review-pass 36.3s, boundary 1000ms, short 999ms, bad NaNs, fifth 2s, sixth 3s, seventh 4s`;
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, prState: async () => null, lockOpts: LOCK_OPTS,
        log, now: () => clock,
        runSmoke: async () => {
          clock += 65_000;
          return { verdict: 'pass', smoke: { results: [
            { name: 'dispatch-dry-run', ms: 495196, ok: true, detail },
            { name: 'reconcile-dry-run', ms: 229798, ok: true },
            { name: 'malformed', ms: 1, ok: true, detail: { timings: 'bad' } },
          ] } };
        },
        dispatchSmoke: { settings: SETTINGS, run: async () => ({ ok: true, reason: 'passed', ms: 5 }) },
      });
      const line = log.error.mock.calls.map(([message]) => message)
        .find(message => message.startsWith('daemon-rebuild: smoke-timings '));
      const payload = JSON.parse(line.slice('daemon-rebuild: smoke-timings '.length));
      const passes = { 'dispatch-dry-run': 'reconcile-fix-pass 81.3s, reconcile-ci-heal-pass 41.8s, reconcile-review-pass 36.3s, boundary 1000ms, fifth 2s, sixth 3s' };
      expect(payload.checks).toBe('dispatch-dry-run:495196ms reconcile-dry-run:229798ms malformed:1ms dispatch-smoke:5ms');
      expect(payload.passes).toEqual(passes);
      expect(result.alerts.find(alert => alert.kind === 'smoke-slow').detail).toEqual(payload);
    },
  );

  it('omits passes when no detail contains slow timing rows', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const log = { error: vi.fn() };
    await rebuildClone({
      root: f.cloneDir, env: f.env, prState: async () => null, lockOpts: LOCK_OPTS, log,
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [
        { name: 'missing', ms: 1, ok: true },
        { name: 'short', ms: 1, ok: true, detail: 'dispatch dry-run ok — review 1ms, fix 0ms' },
        { name: 'bad', ms: 1, ok: true, detail: 'review 2s' },
      ] } }),
      dispatchSmoke: { settings: SETTINGS, run: async () => ({ ok: true, reason: 'passed' }) },
    });
    const line = log.error.mock.calls.map(([message]) => message)
      .find(message => message.startsWith('daemon-rebuild: smoke-timings '));
    expect(JSON.parse(line.slice('daemon-rebuild: smoke-timings '.length))).not.toHaveProperty('passes');
  });

  it('a passing dispatch smoke adopts, and an unchanged overlay is not smoked again', async () => {
    const f = makeFixture();
    const sha = addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: true, reason: 'passed', ms: 5 }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-passed');
    gitOk(f.cloneDir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    pushBranch(f.originDir, 'main', (dir) => writeFile(dir, 'b.txt', 'b'));
    const r2 = await rebuild(f, run);
    expect(r2.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a timeout holds on last-good, keeps the overlay, and retries with backoff', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'timeout', detail: 'no command ran and no completion record' }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBeFalsy();
    expect(head(f)).toBe(lastGood);
    expect(refs(f)).toEqual(['lane/s3b']);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.rejected.dispatchSmoke).toBe(true);
    expect(Date.parse(st.rejected.retryAt)).toBeGreaterThan(Date.now());
    const r2 = await rebuild(f, run);
    expect(r2.reason).toBe('still-rejected');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an overlay off the dispatch path, or the setting off, never launches a worker', async () => {
    const f = makeFixture();
    addDispatchOverlay(f, 'lane/docs', 'docs/x.md');
    const run = vi.fn();
    expect((await rebuild(f, run)).adopted).toBe(true);
    const g = makeFixture();
    addDispatchOverlay(g);
    expect((await rebuild(g, run, { settings: { ...SETTINGS, dispatchSmoke: 'off' } })).adopted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };
  it('a failing ordinary smoke never reaches the dispatch smoke (plain main passes and is adopted)', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const run = vi.fn();
    const runSmoke = vi.fn().mockResolvedValueOnce(FAIL).mockResolvedValue(PASS);
    const r = await rebuild(f, run, { runSmoke });
    expect(r.reason).toBe('fallback-plain-main');
    expect(run).not.toHaveBeenCalled();
  });

  it('adopting a candidate "as no worse" (harness broken) still requires the dispatch smoke', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await rebuild(f, run, { runSmoke: vi.fn(async () => FAIL) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
  });
});

describe('dispatchSmokeSuspects', () => {
  const match = (files, pats) => files.filter((x) => pats.includes(x));
  const okGit = (files) => (args) => (args[0] === 'merge-base' ? { status: 0, stdout: 'base\n' } : { status: 0, stdout: files.join('\n') });
  it('skips an overlay already adopted at the same sha, and fails closed on an unreadable diff', () => {
    const applied = [{ ref: 'a', sha: '1' }, { ref: 'b', sha: '2' }];
    expect(dispatchSmokeSuspects({
      git: okGit(['p']), applied, adoptedApplied: [{ ref: 'a', sha: '1' }], patterns: ['p'], match,
    }).map((s) => s.ref)).toEqual(['b']);
    expect(dispatchSmokeSuspects({
      git: () => ({ status: 1 }), applied, adoptedApplied: null, patterns: ['p'], match,
    }).map((s) => s.reason)).toEqual(['diff-unknown', 'diff-unknown']);
    expect(dispatchSmokeSuspects({
      git: okGit(['q']), applied, adoptedApplied: null, patterns: ['p'], match,
    })).toEqual([]);
  });
});
