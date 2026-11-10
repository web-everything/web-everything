// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialContentFinding } from '../forge-exec-manifest.mjs';

const root = new URL('../../../', import.meta.url);
const allowlistPath = 'scripts/readiness/forge-scan-allowlist.json';
const allowlist = JSON.parse(readFileSync(new URL(allowlistPath, root), 'utf8'));
const hash = span => createHash('sha256').update(span).digest('hex');
const scan = (path, content) => credentialContentFinding(Buffer.from(path), Buffer.from(content));
const cases = allowlist.entries.map(entry => {
  const content = readFileSync(new URL(entry.path, root), 'utf8');
  const span = content.split(/[\r\n]/).find(line => hash(line) === entry.sha256);
  if (span === undefined) throw new Error(`Stale reviewed span: ${entry.path} (${entry.rule})`);
  return { ...entry, content, span };
});

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

describe('reviewed Forge scan allowlist', () => {
  it.each(cases)('skips $rule at its real path $path with real content', ({ path, content, span }) => {
    expect(scan(path, span)).toBeNull();
    expect(scan(path, content)).toBeNull();
  });

  it.each(cases)('catches a one-character edit to $rule at $path', ({ path, content, span }) => {
    // Replacing one indentation byte preserves the rule but changes the pin.
    const changed = '\t' + span.slice(1);
    expect(scan(path, changed)).not.toBeNull();
    expect(scan(path, content.replace(span, changed))).not.toBeNull();
  });

  it.each(cases)('catches the same $rule span at another path ($path)', ({ path, span }) => {
    expect(scan(`unlisted/${path}`, span)).not.toBeNull();
  });

  it('keeps looking after an allowed raw pattern and an allowed assignment', () => {
    const bad = ['password', ': ', JSON.stringify('hunter' + '2')].join('');
    for (const { path, span } of cases) expect(scan(path, span + '\n' + bad)).not.toBeNull();
    const raw = cases.find(entry => entry.rule === 'pem-header');
    expect(scan(raw.path, raw.span + '\n' + ['-----', 'BEGIN'].join(''))).toBe('pem-header');
  });

  it('scans its own test and hash-only allowlist without findings', () => {
    for (const path of [allowlistPath, 'scripts/readiness/__tests__/forge-scan-allowlist.test.mjs']) {
      expect(scan(path, readFileSync(new URL(path, root)))).toBeNull();
    }
  });

  it.each([
    ['missing', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }],
    ['unreadable', () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }],
    ['invalid JSON', () => '{'],
    ['invalid schema', () => JSON.stringify({ entries: {} })],
    ['null', () => 'null'],
    ['incomplete entry', () => JSON.stringify({ entries: [{ path: cases[0].path }] })],
    ['invalid hash beside valid entries', () => JSON.stringify({ entries: [...allowlist.entries, { path: 'x', rule: 'x', sha256: 'bad' }] })],
  ])('fails closed with a %s allowlist', async (_name, read) => {
    vi.resetModules();
    const readAllowlist = vi.fn(read);
    vi.doMock('node:fs', () => ({ readFileSync: readAllowlist }));
    const { credentialContentFinding: closedScan } = await import('../forge-exec-manifest.mjs');
    for (const { path, content, span } of cases) {
      expect(closedScan(Buffer.from(path), Buffer.from(span))).not.toBeNull();
      expect(closedScan(Buffer.from(path), Buffer.from(content))).not.toBeNull();
    }
    expect(readAllowlist).toHaveBeenCalledTimes(1);
  });

  it('requires the rule as well as the path and span hash', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({ readFileSync: () => JSON.stringify({
      entries: allowlist.entries.map(entry => ({ ...entry, rule: entry.rule + '-other' })),
    }) }));
    const { credentialContentFinding: changedRulesScan } = await import('../forge-exec-manifest.mjs');
    for (const { path, span } of cases) {
      expect(changedRulesScan(Buffer.from(path), Buffer.from(span))).not.toBeNull();
    }
  });
});

// Expected findings were captured against the unmodified live scanner. Build all
// secret-shaped values at runtime so the fixtures themselves pass the scan.
const tok = ['aB3dE5fG', '7hJ9kL2m', 'N4pQ6rS8'].join('');
const assignment = value => ['token', ': ', value].join('');
const quoted = value => JSON.stringify(value);
const corpus = [
  ...['!', '+', '-', '_', '=', '$', 'A', '0'].flatMap(pad => {
    const padded = pad.repeat(128) + tok + pad.repeat(128);
    return [
      [`test padding ${pad}`, 'x.test.mjs', assignment(quoted(padded)), 'secret-assignment-token'],
      [`source String padding ${pad}`, 'x.mjs', assignment(`String('${padded}')`), 'secret-assignment-token'],
    ];
  }),
  ['hex between A padding', 'x.test.mjs', assignment(quoted('A'.repeat(128)
    + ['aabbccdd', 'eeff0011', '22334455', '66778899'].join('') + 'A'.repeat(128))), 'secret-assignment-token'],
  ['AABBCC repeat padding', 'x.test.mjs', assignment(quoted('AABBCC'.repeat(32) + tok + 'AABBCC'.repeat(32))), 'secret-assignment-token'],
  ['AB filler between chunks', 'x.test.mjs', assignment(quoted(tok.match(/.{8}/g).join('AB'.repeat(64)))), 'secret-assignment-token'],
  ['split String concat', 'x.mjs', assignment(`String('${tok.slice(0, 8)}').concat('${tok.slice(8, 16)}','${tok.slice(16)}')`), 'high-entropy-token'],
  ['test password', 'x.test.mjs', ['password', ': ', quoted('hunter' + '2')].join(''), 'secret-assignment-password'],
  ['unlisted createHash', 'x.mjs', ['pathKey', ": createHash('sha256').update(String(p)).digest('hex'),"].join(''), 'high-entropy-pathKey'],
  ['plain token', 'x.test.mjs', assignment(quoted(tok)), 'high-entropy-token'],
  ['GitHub token', 'x.test.mjs', assignment(quoted(['ghp', '_', tok].join(''))), 'github-token'],
  ['PEM header', 'x.mjs', ['-----', 'BEGIN', ' PRIV', 'ATE KE', 'Y-----'].join(''), 'pem-header'],
];

describe('unchanged live scanner corpus', () => {
  it.each(corpus)('catches %s with the original rule', (_name, path, content, rule) => {
    expect(scan(path, content)).toBe(rule);
  });
});
