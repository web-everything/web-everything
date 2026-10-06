/**
 * @file codex-delivery-provider-sandbox.test.mjs — #4443/#4807 REAL `codex sandbox -P locked` proof (no model) that an
 * extra writable WE root (`writableRoots`) grants ordinary file writes but NOT Git-metadata mutation, on the
 * production lane topology (independent clones sharing objects via `git clone --reference`).
 * Opt-in: `WE_TEST_SANDBOX=0 WE_CODEX_SANDBOX_TEST=1 npx vitest run codex-delivery-provider-sandbox.test` (setup otherwise
 * strips `WE_*`, fakes HOME). When requested, a missing CLI or unusable sandbox FAILS (positive control must
 * pass) rather than skipping; CI (`.github/workflows/codex-sandbox-proof.yml`) additionally fails on any skipped
 * case. Every subprocess goes through `./helpers/codex-sandbox-fixture.mjs`: a launch error, timeout or signal
 * is never read as a sandbox denial, and each denial is paired with an unchanged-filesystem observation.
 * Fixtures live under $HOME: ambient temp dirs are writable and would confound the ungranted-sibling control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNativeDenyCodexArgs } from '../../lib/isolation-provider.mjs';
import { createLaneFixture, expectDenied, expectSuccess, shellQuote } from './helpers/codex-sandbox-fixture.mjs';

const live = process.env.WE_CODEX_SANDBOX_TEST === '1';
const DENIAL = /Operation not permitted/;

describe.skipIf(!live)('4443 extra writable root vs Git metadata (live codex sandbox)', () => {
  let fx; let args; let cliVersion; let hostVersion;
  const cases = [];

  const argv = (cmd) => ['sandbox', '-P', 'locked', ...args, '--', 'sh', '-c', cmd];
  const ok = (cmd) => expectSuccess('codex', argv(cmd), { cwd: fx.impl });
  // A denial must carry Seatbelt's own refusal text: a bare nonzero exit could be a CLI argument error.
  const denied = (cmd) => expectDenied('codex', argv(cmd), { cwd: fx.impl }, DENIAL);
  const gitIdentity = () => {
    const st = statSync(join(fx.we, '.git'));
    return { ino: st.ino, dev: st.dev, head: readFileSync(join(fx.we, '.git/HEAD'), 'utf8') };
  };
  const record = (name) => cases.push(name);

  beforeAll(() => {
    cliVersion = expectSuccess('codex', ['--version']).stdout.trim();
    hostVersion = `${expectSuccess('uname', ['-srm']).stdout.trim()}`;
    fx = createLaneFixture();
    args = buildNativeDenyCodexArgs([fx.denyDir], { writableRoots: [fx.we] }).filter((a) => a !== '--strict-config');
  });
  afterAll(() => {
    const evidence = process.env.WE_CODEX_SANDBOX_EVIDENCE;
    if (evidence && fx) {
      writeFileSync(evidence, `${JSON.stringify({ cliVersion, hostVersion, topology: fx.topology, cases }, null, 2)}\n`);
    }
    fx?.cleanup();
  });

  it('4807 fixtures are production-shaped clones (directory .git, own common dir, reference alternates)', () => {
    for (const side of ['impl', 'we']) {
      expect(fx.topology[side].alternates.some((line) => line.endsWith('-primary/.git/objects'))).toBe(true);
    }
    record('topology');
  });

  it('4443 positive control: backlog write in the granted root succeeds (sandbox is usable)', () => {
    ok(`echo ok > ${shellQuote(join(fx.we, 'backlog/a.md'))}`);
    expect(readFileSync(join(fx.we, 'backlog/a.md'), 'utf8')).toBe('ok\n');
    expect(ok(`cat ${shellQuote(join(fx.we, 'README.md'))}`).stdout).toBe('we\n');
    record('positive-control');
  });

  it('4807 denied-read control: the deny entry holds alongside the writable-root grant', () => {
    const r = denied(`cat ${shellQuote(fx.secret)}`);
    expect(r.stdout).not.toContain('secret');
    record('denied-read');
  });

  it('4443 denies hook creation and overwrite', () => {
    const before = gitIdentity();
    denied(`echo x > ${shellQuote(join(fx.we, '.git/hooks/new'))}`);
    denied(`echo x > ${shellQuote(join(fx.we, '.git/hooks/pre-commit'))}`);
    expect(existsSync(join(fx.we, '.git/hooks/new'))).toBe(false);
    expect(readFileSync(join(fx.we, '.git/hooks/pre-commit'), 'utf8')).toBe('orig\n');
    expect(gitIdentity()).toEqual(before);
    record('hook-denied');
  });

  it('4443 denies metadata-root replacement and removal', () => {
    const before = gitIdentity();
    denied(`mv ${shellQuote(join(fx.we, '.git'))} ${shellQuote(join(fx.we, '.git-moved'))}`);
    denied(`rm -rf ${shellQuote(join(fx.we, '.git'))}`);
    expect(existsSync(join(fx.we, '.git/HEAD'))).toBe(true);
    expect(existsSync(join(fx.we, '.git-moved'))).toBe(false);
    expect(gitIdentity()).toEqual(before);
    record('metadata-denied');
  });

  it('4443 denies writes to an ungranted sibling', () => {
    denied(`echo x > ${shellQuote(join(fx.sibling, 'a'))}`);
    expect(existsSync(join(fx.sibling, 'a'))).toBe(false);
    record('sibling-denied');
  });
});
