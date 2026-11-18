// R971: regression fixtures intentionally quote private-host patterns.
// Escape synthetic home-path separators in source to satisfy the host-path ratchet; runtime fixtures stay literal.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { gzipSync, deflateSync, deflateRawSync } from 'node:zlib';
import { partitionLocal, partitionFindings } from '../../readiness/claimScope.mjs';
import { PATTERNS, scanText, loadAllowlist, selectChangedFiles, introducedFindings, decodePrivacyContent } from '../privacy-terms.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const policy = (entries = []) => ({ entries, operatorUsernameSha256: [digest('syntheticoperator')] });
const exactEntry = (path, pattern, match, lineText = match) => ({
  path, pattern, matchText: match, matchSha256: digest(match), lineSha256: digest(lineText), reason: 'Synthetic regression fixture',
});

describe('R971 privacy terms', () => {
  it.each(['%2Fhome%2Falice%2Fprojects', 'L2hvbWUvYWxpY2UvcHJvamVjdHM=',
    '\\u002fhome\\u002falice\\u002fprojects', '\\/home\\/alice\\/projects'])('decodes raw HTML attributes before tag stripping: %s', encoded => {
    const text = '<a href="' + encoded + '">';
    const path = 'scripts/lib/__tests__/fixtures/attribute.md';
    expect(scanText(text, { path })).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
    const allowlist = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice', text)])));
    expect(scanText(text, { path, allowlist })).toEqual([]);
  });
  it.each(['&#37;2Fhome&#37;2Falice', 'L2hvbWUv&#89;WxpY2U=', '&#92;u002fhome&#92;u002falice'])('decodes tokens exposed by normalisation: %s', text => {
    expect(scanText(text)).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
  });
  it.each(['MTAuMS4yLjM=', 'MTAuMS4yLjM'])('finds short padded or unpadded base64 private IPs: %s', encoded => {
    expect(scanText(encoded)).toContainEqual({ pattern: 'private-network-ip', line: 1, match: '10.1.2.3' });
  });
  it.each(['L2hvbWUvYm9i', ...['base64', 'base64url'].flatMap(encoding => {
    const token = Buffer.from('/home\u002fbob/~~~').toString(encoding);
    return [token, token.replace(/=+$/, '')];
  })])('finds short standard and URL-safe base64 home paths: %s', encoded => {
    expect(scanText(encoded)).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/bob' });
  });
  it.each(['ordinary', 'readable', 'deadbeef', '0123456789abcdef', 'a'.repeat(64),
    Buffer.from('ordinary text').toString('base64'), Buffer.from('\0ordinary text\n').toString('base64'),
    Buffer.concat([Buffer.from([255]), Buffer.from('/home/bob')]).toString('base64')])('does not flag ordinary tokens or invalid UTF-8 base64: %s', text => {
    expect(scanText(text)).toEqual([]);
  });
  it('detects base64 private paths with trailing newlines', () => {
    for (const text of ['/home\u002falice/projects\n', '\0/home\u002falice/projects\r\n', '\t/home\u002falice/projects\x1b']) {
      for (const encoding of ['base64', 'base64url']) {
        const encoded = Buffer.from(text).toString(encoding);
        const path = 'scripts/lib/__tests__/fixtures/controls.md';
        expect(scanText(encoded, { path })).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
        const allowlist = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice', encoded)])));
        expect(scanText(encoded, { path, allowlist })).toEqual([]);
      }
    }
  });
  it.each(['%2Fhome%2Falice', '%2fhome%2falice', '\\u002fhome\\u002falice', '\\/home\\/alice',
    Buffer.from('/home\u002falice/projects').toString('base64')])('R984 detects common encoded private text: %s', encoded => {
    expect(scanText('header\n' + encoded)).toContainEqual({ pattern: 'home-path', line: 2, match: '/home/alice' });
  });
  it('R984 keeps decoded-view exemptions tied to the raw encoded line', () => {
    const path = 'scripts/lib/__tests__/fixtures/encoded.md';
    const encoded = '%2Fhome%2Falice';
    const wrong = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice')])));
    expect(scanText(encoded, { path, allowlist: wrong })).toHaveLength(1);
    const exact = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice', encoded)])));
    expect(scanText(encoded, { path, allowlist: exact })).toEqual([]);
  });
  it('finds private text inside double gzip and mixed nested compression', () => {
    for (const bytes of [gzipSync(gzipSync('/home/alice')), gzipSync(deflateSync(deflateRawSync('/home/alice')))]) {
      expect(scanText(bytes)).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
    }
  });
  it('fails closed on a malformed nested gzip or zlib wrapper', () => {
    for (const bytes of [gzipSync(Buffer.from([31, 139])), gzipSync(Buffer.from([120, 156]))]) {
      expect(scanText(bytes).some(hit => hit.pattern === 'uninspectable-compressed')).toBe(true);
    }
  });
  it('allows eight inflation layers and fails closed when a ninth layer remains', () => {
    let bytes = Buffer.from('/home/alice');
    for (let layer = 0; layer < 8; layer++) bytes = gzipSync(bytes);
    expect(scanText(bytes)).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
    expect(scanText(bytes).some(hit => hit.pattern === 'uninspectable-compressed')).toBe(false);
    expect(scanText(gzipSync(bytes)).some(hit => hit.pattern === 'uninspectable-compressed')).toBe(true);
  });
  it('fails closed when cumulative inflated bytes exceed 32 MiB across layers', () => {
    const inner = deflateSync(Buffer.alloc(16 * 1024 * 1024, 120), { level: 0 });
    const onCompressionError = vi.fn();
    decodePrivacyContent(gzipSync(inner), { onCompressionError });
    expect(onCompressionError).toHaveBeenCalledOnce();
  });
  it.each([gzipSync, deflateSync])('scans inflated private text while retaining raw views: %s', compress => {
    expect(scanText(compress('/home/alice'), { path: 'payload.bin' }))
      .toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
  });
  it('fails closed on malformed or oversized compressed input while retaining raw scanning', () => {
    expect(scanText(Buffer.from('/home/alice'))).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
    const oversized = gzipSync('/home/alice\n' + 'x'.repeat(32 * 1024 * 1024));
    expect(decodePrivacyContent(oversized)).toHaveLength(6);
    for (const bytes of [oversized, Buffer.from([31, 139]), Buffer.from([120, 156])]) {
      expect(scanText(bytes).some(hit => hit.pattern === 'uninspectable-compressed')).toBe(true);
    }
    expect(scanText(Buffer.from([31, 139, ...Buffer.from('/home/alice')])).some(hit => hit.pattern === 'home-path')).toBe(true);
  });
  it('allows uninspectable compression only with an exact path and raw-line exemption', () => {
    const bytes = Buffer.from([31, 139]);
    const hit = scanText(bytes)[0];
    const path = 'scripts/lib/__tests__/fixtures/broken.gz';
    const allowlist = loadAllowlist(JSON.stringify(policy([exactEntry(path, hit.pattern, hit.match, bytes.toString('latin1'))])));
    expect(scanText(bytes, { path, allowlist })).toEqual([]);
    expect(scanText(bytes, { path: 'other.gz', allowlist })).toHaveLength(1);
    expect(introducedFindings([hit], [hit])).toHaveLength(1);
  });
  it('checks normalised findings against the raw committed line and preserves baseline provenance', () => {
    const path = 'scripts/lib/__tests__/fixtures/encoded.md';
    const raw = '/home/alice';
    const encoded = '&#47;home&#47;alice';
    const allowlist = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', raw)])));
    expect(scanText(raw, { path, allowlist })).toEqual([]);
    expect(scanText(encoded, { path, allowlist })).toContainEqual({ pattern: 'home-path', line: 1, match: raw });
    const encodedPolicy = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', raw, encoded)])));
    expect(scanText(encoded, { path, allowlist: encodedPolicy })).toEqual([]);
    expect(introducedFindings(scanText(encoded), scanText(raw))).toHaveLength(1);
    expect(introducedFindings(scanText(encoded), scanText(encoded))).toEqual([]);
  });
  it('retains findings before an unpaired UTF-16 surrogate in inflated content', () => {
    const bytes = Buffer.concat([Buffer.from('/home\u002falice/', 'utf16le'), Buffer.from([0, 216])]);
    expect(scanText(gzipSync(bytes)).some(hit => hit.pattern === 'home-path')).toBe(true);
  });
  it('preserves raw source-line exemptions for newline-producing HTML entities without throwing', () => {
    const path = 'scripts/lib/__tests__/fixtures/newline-entity.md';
    for (const encoded of ['&#10;/home/alice', '&#xA;/home/alice', '&#13;&#10;/home/alice', '&#10;&#47;home&#47;alice']) {
      const hits = scanText(encoded, { path });
      expect(hits).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
      const wrongLine = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice')])));
      expect(scanText(encoded, { path, allowlist: wrongLine }).some(hit => hit.pattern === 'home-path')).toBe(true);
      const rawLine = loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice', encoded)])));
      expect(scanText(encoded, { path, allowlist: rawLine })).toEqual([]);
      expect(scanText('header\n' + encoded)).toContainEqual({ pattern: 'home-path', line: 2, match: '/home/alice' });
    }
  });
  it.each(['Mac Studio', 'MacStudio', 'Studio host', 'MacBook-era', 'MacBook-Pro.local', 'Mac mini',
    '30 cores, 96 GB', '12-core, 64GB', '30 cores, 96 GiB', 'mac studio'])('detects %s', text => {
    expect(scanText(text)).toHaveLength(1);
  });
  it.each(['~2 GB Florence-2', '5GB RAM at 4-bit', '2 GB model', '1.2 GB RSS', '20 GB disk',
    'GitHub 8-core paid runner', 'maxWorkers: 4', 'Design Studio', 'primary host', 'remote runner'])('preserves %s', text => {
    expect(scanText(text)).toEqual([]);
  });
  it('reports stable pattern IDs and line numbers across repeated scans', () => {
    expect(PATTERNS.map(p => p.id)).toEqual(['uninspectable-compressed', 'machine-name', 'host-spec', 'home-path', 'operator-username',
      'private-service-url', 'network-name', 'private-network-ip', 'account-id']);
    const text = 'neutral\nMac mini\n30 cores, 96 GB';
    expect(scanText(text).map(h => [h.pattern, h.line])).toEqual([['machine-name', 2], ['host-spec', 3]]);
    expect(scanText(text)).toEqual(scanText(text));
  });
  it('loads exact daemon fixture lines without exempting new terms or new uses of the same term', () => {
    const allowlist = loadAllowlist(readFileSync('scripts/settings/privacy-terms-allowlist.json', 'utf8'));
    const path = 'scripts/lib/__tests__/daemon-jobs-runtime.test.mjs';
    const fixture = readFileSync(path, 'utf8');
    expect(scanText(fixture, { path, allowlist }).filter(hit => hit.pattern === 'machine-name')).toEqual([]);
    expect(scanText(`${fixture}\nconst newPrivateHost = 'MacBook';`, { path, allowlist })
      .filter(hit => hit.pattern === 'machine-name')).toHaveLength(1);
    expect(scanText('Mac Studio', { path, allowlist })).toHaveLength(1);
    expect(scanText('MacBook-Pro.local', { path: `${path}.md`, allowlist })).toHaveLength(1);
    expect(scanText('30 cores, 96 GB', { path, allowlist })).toHaveLength(1);
  });
  it.each(['{', '{}', '[]', JSON.stringify(policy([{}])),
    JSON.stringify(policy([exactEntry('../escape', 'machine-name', 'synthetic')])),
    JSON.stringify(policy([exactEntry('scripts/lib/__tests__/ok.md', 'unknown', 'synthetic')])),
    JSON.stringify(policy([{ ...exactEntry('scripts/lib/__tests__/ok.md', 'machine-name', 'synthetic'), reason: ' ' }]))])('rejects malformed allowlist %s', text => {
    expect(() => loadAllowlist(text)).toThrow();
  });
  it('selects changed paths regardless of extension, excluding deletions and out-of-scope files', () => {
    const changes = { changedFiles: ['a.md', 'b.md', 'removed.md', 'image.png', 'a.md'], deletedFiles: ['removed.md'] };
    expect(selectChangedFiles(changes)).toEqual(['a.md', 'b.md', 'image.png']);
    expect(selectChangedFiles(changes, ['b.md', 'unchanged.md', 'removed.md']))
      .toEqual(['a.md', 'b.md', 'image.png', 'unchanged.md']);
    expect(selectChangedFiles(changes, [])).toEqual(['a.md', 'b.md', 'image.png']);
    expect(() => selectChangedFiles(null)).toThrow(/evidence unavailable/);
  });
  it('does not let NUL suppress findings in decoded text', () => {
    expect(scanText('MacBook\0binary').map(hit => hit.pattern)).toEqual(['machine-name']);
    expect(scanText('\0/home\u002falice/').map(hit => hit.pattern)).toEqual(['home-path']);
  });
  it('selects configs, dotfiles, extensionless and binary-named paths for content inspection', () => {
    const text = ['.env', '.env.local', '.private', 'service.conf', 'Dockerfile', 'config.custom', 'image.svg'];
    const binary = ['image.PNG', 'font.woff2', 'archive.tar.gz', 'payload.zip', 'module.wasm'];
    expect(selectChangedFiles({ changedFiles: [...text, ...binary], deletedFiles: [] })).toEqual([...text, ...binary]);
  });
  it('rejects category-wide, missing-digest and invalid-digest exemptions and identity policy', () => {
    for (const entry of [
      { path: 'scripts/lib/__tests__/fixtures/example.md', pattern: 'machine-name', reason: 'Too broad' },
      { ...exactEntry('scripts/lib/__tests__/fixtures/example.md', 'machine-name', 'MacBook'), lineSha256: 'invalid' },
      { ...exactEntry('scripts/lib/__tests__/fixtures/example.md', 'machine-name', 'MacBook'), matchSha256: undefined },
      { ...exactEntry('scripts/lib/__tests__/fixtures/example.md', 'machine-name', 'MacBook'), matchText: undefined },
      { ...exactEntry('scripts/lib/__tests__/fixtures/example.md', 'machine-name', 'MacBook'), matchText: 'different text' },
    ]) expect(() => loadAllowlist(JSON.stringify(policy([entry])))).toThrow();
    for (const hashes of [[], ['invalid'], [123], undefined]) {
      expect(() => loadAllowlist(JSON.stringify({ entries: [], operatorUsernameSha256: hashes }))).toThrow();
    }
  });
  it.each(['public.md', 'docs/public.md', 'backlog/123-public.md', 'src/app.mjs',
    'docs/__tests__/../public.md'])('rejects an exact allowlist entry outside the approved scope: %s', path => {
    expect(() => loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice')]))))
      .toThrow(/Invalid privacy allowlist entry/);
  });
  it.each(['scripts/lib/__tests__/case.mjs', 'scripts/golden-corpus/case.json',
    'tests/case.spec.ts', 'tests/fixtures/case.txt', 'tests/__fixtures__/case.txt', 'scripts/lib/privacy-terms.mjs',
    'PUBLIC-CONTENT.md', 'scripts/settings/privacy-terms-allowlist.json'])('allows exact synthetic or policy excerpts at %s', path => {
    expect(loadAllowlist(JSON.stringify(policy([exactEntry(path, 'home-path', '/home/alice')]))).entries).toHaveLength(1);
  });
});

describe('R972 content classification', () => {
  it.each([
    ['PNG', '89504e470d0a1a0a'], ['JPEG', 'ffd8ff'], ['GIF87', '474946383761'],
    ['GIF89', '474946383961'], ['TIFF little endian', '49492a00'], ['TIFF big endian', '4d4d002a'],
    ['ICO', '00000100'], ['ZIP', '504b0304'], ['empty ZIP', '504b0506'], ['stream ZIP', '504b0708'],
    ['gzip', '1f8b'], ['bzip2', '425a68'], ['xz', 'fd377a585a00'], ['7z', '377abcaf271c'],
    ['RAR', '526172211a07'], ['zstd', '28b52ffd'], ['WOFF', '774f4646'], ['WOFF2', '774f4632'],
    ['OpenType', '4f54544f'], ['TTC', '74746366'], ['TTF', '00010000'], ['PDF', '255044462d'],
    ['WebAssembly', '0061736d'],
  ])('requires non-text payload evidence for %s instead of a signature-only exemption', (_type, hex) => {
    const textCollision = Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from('\nThis otherwise plain text explains a generic product workflow. syntheticoperator')]);
    expect(scanText(textCollision, { path: 'README.md', allowlist: policy() })
      .some(hit => hit.pattern === 'operator-username')).toBe(true);
    const bytes = Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(128), Buffer.from('syntheticoperator')]);
    expect(decodePrivacyContent(bytes)).toHaveLength(6);
    expect(scanText(bytes, { path: 'renamed.txt', allowlist: policy() })
      .some(hit => hit.pattern === 'operator-username')).toBe(true);
  });
  it('does not exempt plaintext collisions with offset signatures for WebP, AVIF and tar', () => {
    const webp = Buffer.from('RIFF0000WEBPpayload');
    const avif = Buffer.from('0000ftypavifpayload');
    const tar = Buffer.alloc(512, 32);
    tar.write('ustar', 257);
    for (const bytes of [webp, avif, tar]) {
      expect(decodePrivacyContent(bytes)).toHaveLength(6);
      expect(scanText(Buffer.concat([bytes, Buffer.from('\nsyntheticoperator')]), { allowlist: policy() })
        .some(hit => hit.pattern === 'operator-username')).toBe(true);
    }
  });
  it('detects the home path in OTTO-prefixed plaintext README content', () => {
    const text = 'OTTO\n/home\u002falice/projects/';
    expect(decodePrivacyContent(text)).toContain(text);
    expect(scanText(text, { path: 'README.md' })).toEqual([
      { pattern: 'home-path', line: 2, match: '/home/alice' },
    ]);
  });
  it('scans plaintext regardless of a binary-looking filename, including notes.pdf', () => {
    for (const path of ['notes.pdf', 'image.png', 'font.woff2', 'bundle.zip']) {
      expect(scanText(Buffer.from('syntheticoperator'), { path, allowlist: policy() })
        .map(hit => hit.pattern)).toEqual(['operator-username']);
    }
  });
  it('preserves single NUL, sparse NUL and sparse invalid-UTF-8 findings', () => {
    for (const bytes of [Buffer.from('\0syntheticoperator'),
      Buffer.from('syntheticoperator\0long otherwise plain text\0'),
      Buffer.concat([Buffer.from('syntheticoperator'), Buffer.from([255])])]) {
      expect(scanText(bytes, { allowlist: policy() }).map(hit => hit.pattern)).toEqual(['operator-username']);
    }
  });
  it('produces all six views regardless of NUL or invalid-UTF-8 density', () => {
    expect(decodePrivacyContent(Buffer.from([0, 0, 0, 65]))).toHaveLength(6);
    expect(decodePrivacyContent(Buffer.from([255, 255, 255, 65]))).toHaveLength(6);
    expect(decodePrivacyContent(Buffer.from('12345678\0\0'))).toHaveLength(6);
    expect(decodePrivacyContent(Buffer.concat([Buffer.from('123456789012345678'), Buffer.from([255, 255])]))).toHaveLength(6);
    expect(decodePrivacyContent('valid UTF-8 \ufffd text')).toContain('valid UTF-8 \ufffd text');
    expect(() => decodePrivacyContent(null)).toThrow(/requires text or file bytes/);
  });
  it('flags a home path with twenty trailing NULs despite binary classification', () => {
    const bytes = Buffer.concat([Buffer.from('/home\u002falice/'), Buffer.alloc(20)]);
    expect(decodePrivacyContent(bytes)).toHaveLength(6);
    expect(scanText(bytes).some(hit => hit.pattern === 'home-path' && hit.match === '/home/alice')).toBe(true);
  });
  it('always scans NUL-separated latin1 text and invalid-UTF-8 padding without recognized magic', () => {
    for (const bytes of [Buffer.from('prefix\0/home\u002falice/\0suffix'),
      Buffer.concat([Buffer.alloc(50, 255), Buffer.from('/home\u002falice/')])]) {
      expect(scanText(bytes).some(hit => hit.pattern === 'home-path' && hit.match === '/home/alice')).toBe(true);
    }
  });
  it('scans sensitive raw bytes in every recognized binary format regardless of filename', () => {
    const png = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const zip = Buffer.alloc(22); Buffer.from('504b0506', 'hex').copy(zip);
    const gzip = Buffer.alloc(18); Buffer.from([31, 139, 8, 0]).copy(gzip);
    const woff = Buffer.alloc(64); woff.write('wOFF'); woff.writeUInt32BE(64, 8); woff.writeUInt16BE(1, 12);
    const payload = Buffer.from('syntheticoperator');
    zip.writeUInt16LE(payload.length, 20);
    woff.writeUInt32BE(woff.length + payload.length, 8);
    const fixtures = [Buffer.concat([png, payload]),
      Buffer.concat([gif.subarray(0, -1), payload, gif.subarray(-1)]),
      Buffer.concat([zip, payload]), Buffer.concat([gzip, payload]), Buffer.concat([woff, payload])];
    for (const bytes of fixtures) {
      expect(scanText(bytes, { path: 'renamed.txt', allowlist: policy() })
        .some(hit => hit.pattern === 'operator-username')).toBe(true);
    }
  });
  it('detects home paths in printable PDF-like wrappers without document structure', () => {
    const text = '%PDF-1.7\n1 0 obj\n/home\u002falice/\nendobj\n%%EOF';
    expect(scanText(Buffer.from(text), { path: 'notes.pdf' })).toEqual([
      { pattern: 'home-path', line: 3, match: '/home/alice' },
    ]);
  });
  it('scans plaintext between JPEG magic and EOI without valid segments', () => {
    for (const header of [Buffer.from([255, 216, 255]), Buffer.from([255, 216, 255, 224, 0, 2])]) {
      const bytes = Buffer.concat([header,
        Buffer.from('\nAn otherwise printable product note includes /home\u002falice/projects/ and no image data.\n'),
        Buffer.from([255, 217])]);
      expect(scanText(bytes, { path: 'renamed.jpg' }).filter(hit => hit.pattern === 'home-path'))
        .toEqual([{ pattern: 'home-path', line: 2, match: '/home/alice' }]);
    }
  });
  it('scans a home path after an incomplete gzip header instead of exempting the payload', () => {
    const bytes = Buffer.concat([Buffer.from([31, 139, 8, 0]), Buffer.alloc(14),
      Buffer.from('\n/home\u002falice/projects/')]);
    expect(scanText(bytes, { path: 'payload.gz' }).some(hit => hit.pattern === 'home-path')).toBe(true);
  });
});

describe('R972 UTF-16 and latin1 views', () => {
  const encode = (text, bigEndian, bom) => {
    const bytes = Buffer.from(text, 'utf16le');
    if (bigEndian) bytes.swap16();
    return bom ? Buffer.concat([Buffer.from(bigEndian ? [254, 255] : [255, 254]), bytes]) : bytes;
  };
  it('finds a BOM-less UTF-16LE home path after 100 CJK characters', () => {
    const text = `${'界'.repeat(100)}\n/home\u002falice/`;
    const bytes = Buffer.from(text, 'utf16le');
    expect(decodePrivacyContent(bytes)).toContain(text);
    const hits = scanText(bytes);
    expect(hits).toContainEqual({ pattern: 'home-path', line: 2, match: '/home/alice' });
    expect(new Set(hits.map(hit => JSON.stringify([hit.line, hit.pattern, hit.match]))).size).toBe(hits.length);
  });
  it.each([
    ['LE at alignment zero', false, 0], ['LE at alignment one', false, 1],
    ['BE at alignment zero', true, 0], ['BE at alignment one', true, 1],
  ])('always scans mixed CJK/ASCII UTF-16 %s without a BOM', (_label, bigEndian, alignment) => {
    const text = `${'界'.repeat(100)}\n/home\u002falice/`;
    const bytes = Buffer.concat([Buffer.alloc(alignment, 127), encode(text, bigEndian, false)]);
    const views = decodePrivacyContent(bytes);
    expect(views).toHaveLength(6);
    expect(views).toContain(text);
    expect(scanText(bytes).some(hit => hit.pattern === 'home-path' && hit.line === 2)).toBe(true);
  });
  it('always produces UTF-8, latin1 and all four UTF-16 views even for empty or invalid data', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([255, 0, 127])]) {
      const views = decodePrivacyContent(bytes);
      expect(views).toHaveLength(6);
      expect(views[0]).toBe(new TextDecoder('utf-8').decode(bytes));
      expect(views[1]).toBe(bytes.toString('latin1').replace(/\0/g, ' '));
      expect(views.slice(2)).toEqual(['utf-16le', 'utf-16be'].flatMap(encoding =>
        [0, 1].map(alignment => new TextDecoder(encoding).decode(bytes.subarray(alignment)))));
    }
  });
  it.each([
    ['LE with BOM', false, true], ['BE with BOM', true, true],
    ['LE without BOM', false, false], ['BE without BOM', true, false],
  ])('finds the home path in UTF-16 %s before applying NUL-density skipping', (_label, bigEndian, bom) => {
    const text = 'generic note\n/home\u002falice/projects/';
    const bytes = encode(text, bigEndian, bom);
    expect(decodePrivacyContent(bytes)).toContain(text);
    expect(scanText(bytes)).toEqual([{ pattern: 'home-path', line: 2, match: '/home/alice' }]);
  });
  it('scans the latin1 fallback when UTF-16 text contains byte-visible ASCII identity and path data', () => {
    for (const bigEndian of [false, true]) {
      const mixed = Buffer.concat([encode('generic note '.repeat(30), bigEndian, true),
        Buffer.from('\n/home\u002falice/ syntheticoperator')]);
      const hits = scanText(mixed, { allowlist: policy() });
      expect(hits.some(hit => hit.pattern === 'home-path' && hit.match === '/home/alice')).toBe(true);
      expect(hits.some(hit => hit.pattern === 'operator-username')).toBe(true);
    }
  });
  it('preserves UTF-16 findings with an incomplete trailing code unit', () => {
    const bytes = Buffer.concat([encode('/home\u002falice/', false, false), Buffer.from([255])]);
    expect(scanText(bytes).some(hit => hit.pattern === 'home-path')).toBe(true);
  });
  it('deduplicates decoding views while preserving repeated values on the same line', () => {
    const bytes = Buffer.concat([Buffer.from([233]), Buffer.from('\n/home\u002falice/ /home\u002falice/')]);
    expect(scanText(bytes).filter(hit => hit.pattern === 'home-path')).toHaveLength(2);
    expect(scanText('/home\u002falice/\n/home\u002fbob/').filter(hit => hit.pattern === 'home-path')).toHaveLength(2);
  });
});

// Windows separators are joined at runtime so this source holds no literal home path.
const win = (separator, ...parts) => parts.join(separator);
describe('R972 Windows home paths', () => {
  const homePaths = text => scanText(text).filter(hit => hit.pattern === 'home-path').map(hit => hit.match);
  it('detects a backslash home path copied from Windows diagnostics', () => {
    expect(homePaths(win('\\', 'C:', 'Users', 'alice', 'project'))).toContain(win('\\', '', 'Users', 'alice'));
  });
  it('detects JSON-escaped, lowercase-drive and mixed-separator Windows home paths', () => {
    for (const text of [win('\\\\', 'C:', 'Users', 'alice', 'project'), win('\\', 'c:', 'users', 'alice', 'project'),
      'C:/Users' + win('\\', '', 'alice', 'project'), win('\\', '', '', 'host', 'c$', 'Users', 'alice'),
      win('\\', '', '', 'host', 'c$', 'users', 'alice'), win('&bsol;', 'C:', 'Users', 'alice'),
      win('/', '', 'c', 'Users', 'alice'), win('/', '', 'mnt', 'c', 'users', 'alice'), win('\\', 'D:', 'USERS', 'alice'),
      win('\\', 'C:', 'Documents and Settings', 'alice'), win('/', 'C:', 'Documents and Settings', 'alice')]) {
      expect(homePaths(text).some(match => match.endsWith('alice'))).toBe(true);
    }
  });
  it('keeps lowercase web routes and Windows environment variables out of the home-path category', () => {
    for (const text of [win('/', 'https:', '', 'api.github.com', 'users', 'octocat'), win('/', '', 'api', 'users', 'octocat'),
      win('/', '', 'v', 'users', 'me'), win('\\', 'C:', 'Users', '%USERNAME%', 'AppData'), win('\\', 'C:', 'Users', '%username%')]) {
      expect(homePaths(text)).toEqual([]);
    }
  });
  it('stays linear on long separator runs', () => {
    for (const text of ['/'.repeat(40000), '\\'.repeat(20000), '// ' + '/'.repeat(20000), 'C:' + '\\'.repeat(20000),
      '/Users' + '/'.repeat(20000)]) {
      const started = performance.now();
      scanText(text);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
  // PR 7008 self-review: host patterns restarted at every inner dot or dash (quadratic on a long run).
  it('stays linear on long dotted and dashed runs', () => {
    for (const text of ['1.'.repeat(40000), 'a-'.repeat(40000), 'a.'.repeat(40000) + 'workers', 'fd00:'.repeat(20000),
      `a::${'.'.repeat(80000)}a`, `a::${'1.'.repeat(40000)}`, `x:${'a:'.repeat(40000)}`]) {
      const started = performance.now();
      scanText(text);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
  it('reports every private address on one long line once, with its line number', () => {
    const text = `x\n${'::ffff:10.0.0.1 y '.repeat(2000)}`;
    const hits = scanText(text).filter(hit => hit.pattern === 'private-network-ip');
    expect(hits).toHaveLength(2000);
    expect(hits.every(hit => hit.line === 2 && hit.match === '::ffff:10.0.0.1')).toBe(true);
  });
  it('exempts complete template tokens behind Windows separators', () => {
    for (const token of ['<name>', 'username', '${user}']) {
      expect(homePaths(win('\\', 'C:', 'Users', token, 'project'))).toEqual([]);
    }
  });
  it('does not count a JSON-escaped forward slash as a second, raw backslash path', () => {
    for (const escaped of ['\\u002f', '\\/']) {
      expect(homePaths(['', 'home', 'alice', ''].join(escaped))).toEqual(['/home' + '/alice']);
    }
  });
});

describe('R972 tier-three patterns', () => {
  it.each(['>/home/alice<', '(/home/alice)', '"/Users/alice"', '`/Users/alice`',
    'prefix/home/alice', '/home/alice', '[/Users/alice]'])('finds home paths regardless of surrounding delimiters: %s', text => {
    expect(scanText(text)).toContainEqual(expect.objectContaining({ pattern: 'home-path', match: expect.stringMatching(/^\/(?:Users|home)\/alice$/) }));
  });
  it.each(['::ffff:10.2.3.4', '[::ffff:192.168.1.2]', 'http://[::ffff:172.16.1.2]:8080',
    '[::ffff:100.64.1.2]', '::ffff:a00:1', '0:0:0:0:0:ffff:c0a8:102', '[fd12::1]', '[10.2.3.4]'])('detects private mapped and bracketed IPs: %s', text => {
    expect(scanText(text).some(hit => hit.pattern === 'private-network-ip')).toBe(true);
  });
  it.each(['::ffff:8.8.8.8', '[::ffff:c000:201]', '[::ffff:999.1.1.1]'])('rejects public or invalid mapped IPs: %s', text => {
    expect(scanText(text).filter(hit => hit.pattern === 'private-network-ip')).toEqual([]);
  });
  // PR 7008 red team: ordinary punctuation and colon-joined syntax around a private address.
  // Addresses are assembled at runtime so this source adds no literal private address.
  const v4 = (...octets) => octets.join('.');
  const ula = (...groups) => groups.join(':');
  it.each([
    `Host address: ${v4(10, 23, 45, 67)}.`, `ssh -L 8080:${v4(10, 23, 45, 67)}:80 public-jump`,
    `addr:${v4(192, 168, 1, 2)}`, `(${v4(10, 2, 3, 4)}),`, `${v4(10, 2, 3, 4)};`, `see ${v4(172, 16, 0, 2)}!`,
    `::ffff:${v4(10, 2, 3, 4)}.`, `::ffff:${v4(10, 2, 3, 4)}:80`, `${ula('', '', 'ffff', 'a00', '1')}.`,
    `ULA ${ula('fd12', '', '1')}.`, `ULA ${ula('fd12', '', '1')}:`, `addr:${ula('fd12', '', '1')}`,
    // A key ending in a hex letter (source, type, node) is a word, not a preceding IPv6 group.
    `source:${ula('fd12', '3456', '', '1')}`, `type:${ula('fc00', '', '1')}`, `node:${ula('fe80', '', '1')}`,
    `mode:${ula('', '', 'ffff', 'a00', '1')}`,
    // A sentence colon after the hex mapped form, and the zero-prefixed mapped spelling.
    `Address ${ula('', '', 'ffff', 'a00', '1')}: blocked`, ula('0', '', 'ffff', 'a00', '1'),
    `ip::${ula('', 'ffff', 'a00', '1')}`, `${ula('fd00', v4(10, 0, 0, 1))}`,
    // Self-review round 2: a port or word joined after the address, and an underscore key before it.
    `IP6 ${ula('fe80', '', '1')}.546 > ff02::1:2.547`, `${ula('fd00', '', '1')}.53`, `host ${ula('fd00', '', '1')}:http`,
    `bind_addr:${ula('fd00', '', '1')}`, `node_ip:${ula('fe80', '', '1')}`,
  ])('detects private IPs beside ordinary punctuation: %s', text => {
    expect(scanText(text).some(hit => hit.pattern === 'private-network-ip')).toBe(true);
  });
  it.each([
    v4(10, 2, 3, 4, 5), v4(1, 10, 2, 3, 4), `${v4(10, 2, 3, 4)}a`, `${v4(8, 8, 8, 8)}.`,
    `8080:${v4(8, 8, 8, 8)}:80`, ula('2001', 'fd12', '', '1'), ula('2001', 'db8', '', 'fe80', '1'),
    // A key directly before a public address: the longest valid address (public) wins over its private-looking tail.
    `ip:${ula('2001', 'db8', 'fc00', '', '1')}`, `addr:${ula('2001', 'db8', 'fe80', '', '1')}`,
    ula('fd0', '', '1'), `v ${ula('2001', 'db8', '', '1')}.`,
  ])('keeps dotted-number and public-address boundaries: %s', text => {
    expect(scanText(text).filter(hit => hit.pattern === 'private-network-ip')).toEqual([]);
  });
  it.each(['&#47;home&#47;alice&#47;', '&sol;home&sol;alice&sol;', '/home/ali&#99;e/',
    '<b>/home/alice</b>', '/ho\u200bme/ali\u2060ce/', '／ｈｏｍｅ／ａｌｉｃｅ／'])('scans normalised HTML, zero-width and compatibility text: %s', text => {
    expect(scanText(text)).toContainEqual({ pattern: 'home-path', line: 1, match: '/home/alice' });
  });
  it('scans raw and normalised lines without losing raw tag attributes or line numbers', () => {
    const hits = scanText('header\n<a href="/home\u002falice/">&#47;home&#47;bob&#47;</a>');
    expect(hits).toContainEqual({ pattern: 'home-path', line: 2, match: '/home/alice' });
    expect(hits).toContainEqual({ pattern: 'home-path', line: 2, match: '/home/bob' });
  });
  it.each(['12-core/64GB', '12 cores 64 GB', '64GB RAM, 12-core', '12 cores | RAM: 64 GiB',
    '96 GB RAM / 30 cores', 'M2 Max 96GB', '96GB RAM M2 Max', 'M3 Pro with 48 GB RAM'])('detects nearby host hardware pairs: %s', text => {
    expect(scanText(text).some(hit => hit.pattern === 'host-spec')).toBe(true);
  });
  it.each(['12-core host', 'on 12 cores', '~2 GB Florence-2', '5GB RAM at 4-bit',
    'download: 64GB', 'M2 Max', `12 cores ${'unrelated prose '.repeat(8)}64 GB`])('does not infer a paired host spec from %s', text => {
    expect(scanText(text).filter(hit => hit.pattern === 'host-spec')).toEqual([]);
  });
  it.each([
    ['home-path', '/Users\u002falice/projects/'], ['home-path', '/home\u002falice/'],
    ['home-path', '/Users/alice'], ['home-path', '/home\u002ffirst.last/source'],
    ['private-service-url', 'https://personal-api.alice-projects.workers.dev/path'],
    ['network-name', 'build.tail123abc.ts.net'], ['network-name', 'builder.tailscale'],
    // PR 7008 self-review round 2: wildcard, leading-dot and leading-dash hosts.
    ['private-service-url', '*.my-app.workers.dev'], ['private-service-url', '-foo.workers.dev'],
    ['network-name', '*.tail1234.ts.net'], ['network-name', '.foo.ts.net'],
    ['network-name', 'tailscale hostname: private-builder'],
    ['private-network-ip', '10.23.45.67'], ['private-network-ip', '172.16.0.2'],
    ['private-network-ip', '172.31.255.254'], ['private-network-ip', '192.168.3.4'],
    ['private-network-ip', '100.64.1.2'], ['private-network-ip', '100.127.255.254'],
    ['private-network-ip', '169.254.2.3'], ['private-network-ip', 'fd12:3456::1'],
    ['private-network-ip', 'fc00::1'], ['private-network-ip', 'fe80::1%eth0'],
    ['account-id', 'GitHub App ID: 1234567'], ['account-id', 'installation ID = 7654321'],
    ['account-id', '"appId": "1234567"'], ['account-id', 'installation_id: 7654321'],
    ['account-id', 'WE_GITHUB_APP_ID=1234567'], ['account-id', 'LEGACY_PERSONAL_INSTALLATION_ID = "7654321"'],
    ['account-id', 'OWNER_INSTALLATIONS = Object.freeze({ "example-org": "7654321" })'],
    ['account-id', 'https://api.github.com/app/installations/7654321/access_tokens'],
    ['account-id', '"installations": { "example-org": "7654321" }'],
  ])('detects %s in synthetic fixture %s', (pattern, text) => {
    expect(scanText(text).map(hit => hit.pattern)).toContain(pattern);
  });
  it.each(['/Users/example', '/Users/example/', '/Users/<name>/', '/home/<name>/',
    '/home/username/', '/home/${user}/', '/home/user/', '/home/example/', '$HOME/projects', '${HOME}/repo', '~',
    'https://example.workers.dev/', 'https://your-worker.workers.dev/', '<private-service-url>',
    'example.ts.net', '<network-name>', 'tailscale hostname: <name>',
    '172.15.1.1', '172.32.0.1', '100.63.255.255', '100.128.0.0', '192.0.2.1',
    '198.51.100.1', '203.0.113.1', '127.0.0.1', '8.8.8.8', '10.999.1.2',
    '2001:db8::1', '::1', 'appId: process.env.APP_ID', 'installation ID: <account-id>',
    '"installations": { "example-org": "<account-id>" }'])('allows template or non-private value %s', text => {
    expect(scanText(text)).toEqual([]);
  });
  it('uses injected operator identity without committing it, including regex metacharacters', () => {
    expect(scanText('private.operator', { operatorUsername: 'private.operator' })[0].pattern).toBe('operator-username');
    expect(scanText('privateXoperator', { operatorUsername: 'private.operator' })).toEqual([]);
    expect(scanText('prefixprivate.operator', { operatorUsername: 'private.operator' })).toEqual([]);
    expect(scanText('example', { operatorUsername: 'example' })).toEqual([]);
  });
  // A generic execution account (container root, CI images) is not a private identity.
  it.each(['root', 'Root', 'admin', 'administrator', 'node', 'ubuntu', 'vscode', 'codespace', 'jenkins', 'nobody',
    'User', 'runneradmin', 'VssAdministrator', 'azureuser', 'vagrant', 'pi', 'dev', 'jovyan', 'coder', 'git', '1000'])(
    'never turns the generic execution account %s into an operator-username pattern', account => {
      expect(scanText(`const ${account.toLowerCase()} = document.documentElement;`, { operatorUsername: account })).toEqual([]);
    });
  it('still blocks committed identity digests when running as a generic account', () => {
    expect(scanText('syntheticoperator', { operatorUsername: 'root', allowlist: policy() })
      .map(hit => hit.pattern)).toEqual(['operator-username']);
  });
  it('detects hashed operator tokens on CI with an unrelated or unavailable local account', () => {
    const allowlist = loadAllowlist(JSON.stringify(policy()));
    for (const text of ['syntheticoperator', 'PREFIX_syntheticoperator_SUFFIX',
      '/Users\u002fsyntheticoperator/code', '/home\u002fsyntheticoperator/code', 'SYNTHETICOPERATOR']) {
      expect(scanText(text, { allowlist, operatorUsername: 'unrelated-ci-account' })
        .filter(hit => hit.pattern === 'operator-username')).toHaveLength(1);
      expect(scanText(text, { allowlist }).some(hit => hit.pattern === 'operator-username')).toBe(true);
    }
    expect(scanText('prefixsyntheticoperatorsuffix', { allowlist })).toEqual([]);
    expect(JSON.stringify(allowlist)).not.toContain('syntheticoperator');
  });
  it('hashes complete home tokens containing punctuation and does not print identity in policy errors', () => {
    const allowlist = { entries: [], operatorUsernameSha256: [digest('synthetic.operator')] };
    expect(scanText('/home\u002fsynthetic.operator/repo', { allowlist })
      .filter(hit => hit.pattern === 'operator-username')).toHaveLength(1);
    expect(() => loadAllowlist(JSON.stringify({ ...allowlist, operatorUsernameSha256: ['synthetic.operator'] })))
      .toThrow('Privacy policy requires entries and nonempty SHA-256 operator identity digests');
  });
  it('matches the configured dotted identity as a complete home or bare token and alternative joins', () => {
    for (const separator of ['.', '-', '_', '']) {
      const allowlist = { entries: [], operatorUsernameSha256: [digest(`synthetic${separator}operator`)] };
      for (const text of ['/Users\u002fsynthetic.operator/', 'synthetic.operator', 'synthetic-operator', 'synthetic_operator']) {
        expect(scanText(text, { allowlist }).filter(hit => hit.pattern === 'operator-username')).toHaveLength(1);
      }
    }
  });
  it('checks individual identity sub-tokens without matching larger alphanumeric names', () => {
    const allowlist = { entries: [], operatorUsernameSha256: [digest('operator')] };
    expect(scanText('synthetic.operator', { allowlist }).filter(hit => hit.pattern === 'operator-username')).toHaveLength(1);
    expect(scanText('syntheticoperator', { allowlist }).filter(hit => hit.pattern === 'operator-username')).toEqual([]);
  });
  it('grandfathers baseline occurrences without hiding them from whole-tree scans', () => {
    const baseline = scanText('/home\u002falice/');
    expect(baseline).toHaveLength(1);
    expect(introducedFindings(scanText('moved\n/home\u002falice/'), baseline)).toEqual([]);
    expect(introducedFindings(scanText('/home\u002falice/\n/home\u002falice/'), baseline)).toHaveLength(1);
    expect(introducedFindings(scanText('/home\u002fbob/'), baseline)).toHaveLength(1);
    expect(introducedFindings(scanText('Mac mini'), scanText('Mac mini'))).toHaveLength(1);
  });
  it('detects a new same-pattern value appended to a baseline line', () => {
    const baseline = scanText('/home\u002falice/');
    const current = scanText('/home\u002falice/ /home\u002fbob/');
    expect(current.filter(hit => hit.pattern === 'home-path')).toHaveLength(2);
    expect(introducedFindings(current, baseline)).toEqual([
      { pattern: 'home-path', line: 1, match: '/home/bob' },
    ]);
  });
  it('counts a second copy of an existing private value as an introduced occurrence', () => {
    const baseline = scanText('/home\u002falice/');
    for (const text of ['/home\u002falice/ /home\u002falice/', '/home\u002falice/\n/home\u002falice/']) {
      expect(introducedFindings(scanText(text), baseline)).toEqual([
        { pattern: 'home-path', line: text.includes('\n') ? 2 : 1, match: '/home/alice' },
      ]);
    }
  });
  it.each(['/home\u002fexample-alice-private/', '/home\u002ftest-alice-private/', '/home/<alice>/',
    'https://example-private-account.workers.dev/', 'https://test-private-account.workers.dev/',
    'example-private-account.ts.net'])('rejects placeholder prefixes and unlisted tokens: %s', text => {
    expect(scanText(text).length).toBeGreaterThan(0);
  });
  it('keeps new-category fixture exemptions exact and reasoned', () => {
    const allowlist = loadAllowlist(JSON.stringify(policy([exactEntry('scripts/lib/__tests__/fixtures/example.md', 'home-path', '/home/alice')])));
    // The exemption is tied to the complete line, not just its matching substring.
    expect(scanText('/home/alice', { path: 'scripts/lib/__tests__/fixtures/example.md', allowlist })).toEqual([]);
    expect(scanText('/home\u002falice/', { path: 'scripts/lib/__tests__/fixtures/example.md', allowlist })).toHaveLength(1);
    expect(scanText('/home\u002falice/', { path: 'other.md', allowlist })).toHaveLength(1);
    expect(scanText('10.23.45.67', { path: 'scripts/lib/__tests__/fixtures/example.md', allowlist })).toHaveLength(1);
  });
});

// Execute the actual standards producer block with injected IO; no full standards subprocess.
const source = readFileSync('scripts/check-standards.mjs', 'utf8');
const block = source.slice(source.indexOf('// R971 privacy changed-file check:'), source.indexOf('// End R971 privacy changed-file check.'));
const localBlock = source.slice(source.indexOf('// R972 privacy findings are mandatory'),
  source.indexOf('mark("Local / per-lane gating'));
const allDemotionBlocks = source.slice(source.indexOf('const scopeArg = '),
  source.indexOf('mark("Local / per-lane gating'));
function gate({ changes = { changedFiles: ['changed.md'], deletedFiles: [] }, localFiles = null,
  contents = { 'changed.md': 'Mac mini', 'unchanged.md': 'MacBook', 'other.md': 'neutral', 'unrelated.md': 'neutral' }, allowlist = JSON.stringify(policy()),
  baseline = '', base = 'base-sha', username = 'synthetic-operator', gitError = false, local = false, symlinks = {}, ignoreText = 'node_modules/\n', ignoreError = false } = {}) {
  const err = vi.fn();
  const readlink = vi.fn(file => Buffer.from(symlinks[file]));
  const read = vi.fn(file => {
    if (file === 'scripts/settings/privacy-terms-allowlist.json') return allowlist;
    if (file === '.gitignore') {
      if (ignoreError) throw new Error('ignore policy unavailable');
      return ignoreText;
    }
    if (!(file in contents)) throw new Error('unreadable text');
    return contents[file];
  });
  runInNewContext(block, { ROOT: '', join: (...parts) => parts.filter(Boolean).join('/'),
    localChangedSet: () => changes, execFileSync: vi.fn((_cmd, args) => {
      if (gitError) throw new Error('baseline read failed or exceeded output bound');
      return args[0] === 'ls-tree' ? (baseline ? 'changed.md' : '') : baseline;
    }), privacyMergeBase: () => base, userInfo: () => ({ username }),
    introducedPrivacyFindings: introducedFindings, SCOPE_TO_FILES: local && localFiles !== null,
    LOCAL_FILES_LIST: localFiles, privacyChangedFiles: selectChangedFiles, loadPrivacyAllowlist: loadAllowlist,
    scanPrivacyText: scanText, readFileSync: read, lstatSync: file => ({ isSymbolicLink: () => file in symlinks }),
    readlinkSync: readlink, err });
  return { err, read, readlink };
}
describe('R971 standards producer', () => {
  it('excludes only the literally ignored root dependency symlink, preserving tracked and explicit link scanning', () => {
    const options = { changes: { changedFiles: ['node_modules'], deletedFiles: [], untrackedFiles: ['node_modules'] },
      symlinks: { node_modules: '/home\u002falice/dependencies' } };
    const ignored = gate(options);
    expect(ignored.err).not.toHaveBeenCalled();
    expect(ignored.readlink).not.toHaveBeenCalled();
    for (const override of [{ localFiles: ['node_modules'] }, { ignoreText: '' }, { ignoreText: 'node_modules/\n!node_modules/\n' },
      { changes: { ...options.changes, untrackedFiles: [] } }]) {
      expect(gate({ ...options, ...override }).err).toHaveBeenCalledWith(expect.stringContaining('home-path'),
        { kind: 'privacy-terms', file: 'node_modules' });
    }
  });
  it('fails closed if dependency ignore evidence is unreadable', () => {
    const result = gate({ changes: { changedFiles: ['node_modules'], deletedFiles: [], untrackedFiles: ['node_modules'] },
      symlinks: { node_modules: '/home/alice' }, ignoreError: true });
    expect(result.err).toHaveBeenCalledWith(expect.stringContaining('privacy check failed'), { kind: 'privacy-terms', file: 'node_modules' });
  });
  it('scans symlink target text without following even a dangling link', () => {
    const { err, read, readlink } = gate({ contents: {}, symlinks: { 'changed.md': '/home/alice' } });
    expect(readlink).toHaveBeenCalledWith('changed.md', 'buffer');
    expect(read).not.toHaveBeenCalledWith('changed.md');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('home-path'), { kind: 'privacy-terms', file: 'changed.md' });
    expect(gate({ contents: { 'changed.md': '/home/alice' }, symlinks: { 'changed.md': 'neutral-target' } }).err).not.toHaveBeenCalled();
  });
  it('attributes compressed content findings to the original path', () => {
    expect(gate({ contents: { 'changed.md': gzipSync('/home/alice') } }).err)
      .toHaveBeenCalledWith(expect.stringContaining('changed.md:1'), { kind: 'privacy-terms', file: 'changed.md' });
  });
  it('blocks changed prose and never reads unchanged prose', () => {
    const { err, read } = gate();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('changed.md:1'), { kind: 'privacy-terms', file: 'changed.md' });
    expect(read).not.toHaveBeenCalledWith('unchanged.md');
  });
  it('unions explicit files with git changes instead of excluding changed content', () => {
    const { err, read } = gate({ localFiles: ['other.md'] });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('changed.md:1'), { kind: 'privacy-terms', file: 'changed.md' });
    expect(read).toHaveBeenCalledWith('changed.md');
    expect(read).toHaveBeenCalledWith('other.md');
    expect(read).not.toHaveBeenCalledWith('unchanged.md');
  });
  it('blocks a changed home path even when --files points elsewhere or is empty, and without flags', () => {
    for (const localFiles of [null, [], ['unrelated.md']]) {
      for (const local of [false, true]) {
        const { err, read } = gate({ localFiles, local,
          contents: { 'changed.md': '/home\u002falice/projects/', 'unrelated.md': 'neutral' } });
        expect(err).toHaveBeenCalledWith(expect.stringContaining('home-path'), { kind: 'privacy-terms', file: 'changed.md' });
        expect(read).toHaveBeenCalledWith('changed.md');
        expect(read).not.toHaveBeenCalledWith('unchanged.md');
      }
    }
  });
  it('validates empty changed sets and reads unchanged content only when explicitly named', () => {
    for (const localFiles of [null, [], ['other.md']]) {
      const result = gate({ changes: { changedFiles: [], deletedFiles: [] }, localFiles });
      expect(result.read.mock.calls).toEqual([['scripts/settings/privacy-terms-allowlist.json', 'utf8'],
        ...(localFiles?.length ? [['other.md']] : [])]);
      expect(result.err).not.toHaveBeenCalled();
    }
  });
  it('fails policy, baseline and identity validation independently of changed-file selection', () => {
    for (const selection of [{ changes: { changedFiles: [], deletedFiles: [] } },
      { localFiles: [] }, { localFiles: ['other.md'] }]) {
      for (const invalid of [{ allowlist: '{}' }, { base: null }, { username: '' }]) {
        const { err } = gate({ ...selection, ...invalid });
        expect(err).toHaveBeenCalledWith(expect.stringContaining('privacy check failed'),
          { kind: 'privacy-terms', file: selection.changes ? 'scripts/settings/privacy-terms-allowlist.json' : 'changed.md' });
      }
    }
  });
  it('reads bytes to scan plaintext notes.pdf and binary content', () => {
    const payload = Buffer.from('syntheticoperator');
    const zip = Buffer.alloc(22);
    Buffer.from('504b0506', 'hex').copy(zip);
    zip.writeUInt16LE(payload.length, 20);
    for (const [content, hits] of [[Buffer.from('syntheticoperator'), 1],
      [Buffer.from('%PDF-1.7\nsyntheticoperator'), 1],
      [Buffer.concat([Buffer.from('255044462d', 'hex'), Buffer.alloc(128), Buffer.from('syntheticoperator')]), 1],
      [Buffer.from('%PDF-1.7\n1 0 obj\nsyntheticoperator\nendobj\n%%EOF'), 1],
      [Buffer.concat([zip, payload]), 1], [Buffer.alloc(128), 0]]) {
      const { read, err } = gate({ changes: { changedFiles: ['notes.pdf'], deletedFiles: [] },
        contents: { 'notes.pdf': content } });
      expect(read).toHaveBeenCalledWith('notes.pdf');
      expect(err).toHaveBeenCalledTimes(hits);
    }
  });
  it('blocks decoded text with a NUL byte', () => {
    expect(gate({ contents: { 'changed.md': 'Mac mini\0' } }).err).toHaveBeenCalled();
  });
  it('fails closed with an operator fallback on unreadable text, missing diff or invalid policy', () => {
    for (const options of [{ contents: {} }, { changes: null }, { allowlist: '{}' }]) {
      expect(gate(options).err).toHaveBeenCalledWith(expect.stringContaining('Repair changed-file evidence'),
        { kind: 'privacy-terms', file: options.changes === null ? 'scripts/settings/privacy-terms-allowlist.json' : 'changed.md' });
    }
  });
  it('reports an invalid-policy error for an exemption hiding a private home path in public.md', () => {
    const { err } = gate({ allowlist: JSON.stringify(policy([exactEntry('public.md', 'home-path', '/home/alice')])) });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('privacy check failed'),
      { kind: 'privacy-terms', file: 'changed.md' });
  });
  it('blocks new tier-three text while preserving existing hits in a changed file', () => {
    expect(gate({ contents: { 'changed.md': '/home\u002falice/' } }).err).toHaveBeenCalled();
    expect(gate({ contents: { 'changed.md': '/home\u002falice/' }, baseline: '/home\u002falice/' }).err).not.toHaveBeenCalled();
    expect(gate({ contents: { 'changed.md': 'synthetic-operator' } }).err).toHaveBeenCalled();
    expect(gate({ contents: { 'changed.md': '/home\u002falice/ /home\u002falice/' }, baseline: '/home\u002falice/' }).err).toHaveBeenCalled();
  });
  it('fails closed on unknown baseline, missing identity, and unreadable or oversized baseline output', () => {
    for (const options of [{ base: null }, { username: '' }, { gitError: true }]) {
      expect(gate(options).err).toHaveBeenCalledWith(expect.stringContaining('Repair changed-file evidence'),
        { kind: 'privacy-terms', file: 'changed.md' });
    }
  });
  it('keeps every privacy failure blocking through partitionLocal under --local, with and without --files', () => {
    for (const localFiles of [null, ['changed.md']]) {
      for (const options of [{}, { changes: null }, { base: null }, { username: '' },
        { allowlist: '{}' }, { contents: {} }, { gitError: true }]) {
        const { err } = gate({ ...options, localFiles });
        const findings = err.mock.calls.map(([message, descriptor]) => ({ message, descriptor }));
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every(finding => typeof finding.descriptor.file === 'string')).toBe(true);
        const result = partitionLocal(findings, { local: true, fileSet: localFiles && new Set(localFiles) });
        expect(result.blocking).toEqual(findings);
        expect(result.demoted).toEqual([]);
      }
    }
  });
  it('blocks a Windows home path and its JSON-escaped form in a changed file', () => {
    for (const separator of ['\\', '\\\\']) {
      expect(gate({ contents: { 'changed.md': win(separator, 'C:', 'Users', 'alice', 'project') } }).err)
        .toHaveBeenCalledWith(expect.stringContaining('home-path'), { kind: 'privacy-terms', file: 'changed.md' });
    }
  });
  it('accepts ordinary identifiers when the gate runs as a generic root account', () => {
    expect(gate({ username: 'root', contents: { 'changed.md': 'const root = document.documentElement;' } }).err)
      .not.toHaveBeenCalled();
    expect(gate({ username: 'root', contents: { 'changed.md': 'syntheticoperator' } }).err)
      .toHaveBeenCalledWith(expect.stringContaining('operator-username'), { kind: 'privacy-terms', file: 'changed.md' });
  });
  it('uses committed identity hashes under a different executing account', () => {
    expect(gate({ contents: { 'changed.md': 'syntheticoperator' }, username: 'unrelated-ci-account' }).err)
      .toHaveBeenCalledWith(expect.stringContaining('operator-username'), { kind: 'privacy-terms', file: 'changed.md' });
  });
  it('keeps privacy errors hard in the real local gating producer even with an empty file set', () => {
    for (const fileSet of [new Set(), new Set(['other.md']), null]) {
      const { err } = gate({ changes: null });
      const findings = err.mock.calls.map(([message, descriptor]) => ({ message, descriptor }));
      for (const alreadyDemotedByScope of [false, true]) {
        const errors = [...(alreadyDemotedByScope ? [] : findings), { message: 'unrelated global' }];
        const context = { filesArg: '--files=', LOCAL_MODE: true, LOCAL_FILES_LIST: [],
          EFFECTIVE_FILES: fileSet, LINKED_FILES: null, errors,
          externalErrors: alreadyDemotedByScope ? [...findings] : [], partitionLocal };
        runInNewContext(localBlock, context);
        expect(errors).toEqual(findings);
        expect(context.externalErrors.some(finding => finding.descriptor?.kind === 'privacy-terms')).toBe(false);
      }
    }
  });
  it('keeps findings and prerequisite failures blocking for every scope/local/files flag combination', () => {
    for (const scopeFlag of [null, '--scope=review', '--mine=review']) {
      for (const local of [false, true]) {
        for (const files of [null, [], ['unrelated.md']]) {
          for (const failure of [{}, { base: null }, { username: '' }, { allowlist: '{}' }]) {
            const { err } = gate({ ...failure, localFiles: files, local,
              contents: { 'changed.md': '/home\u002falice/', 'unrelated.md': 'neutral' } });
            const privacy = err.mock.calls.map(([message, descriptor]) => ({ message, descriptor }));
            expect(privacy.length).toBeGreaterThan(0);
            if (!Object.keys(failure).length) {
              expect(privacy.some(finding => finding.message.includes('home-path') && finding.descriptor.file === 'changed.md')).toBe(true);
            }
            const errors = [...privacy, { message: 'external non-privacy', descriptor: { file: 'foreign.md' } }];
            const context = { errors, process: { argv: scopeFlag ? [scopeFlag] : [] },
              LOCAL_MODE: local, LOCAL_FILES_LIST: files, filesArgEarly: files ? '--files=' : undefined,
              EFFECTIVE_FILES: files ? new Set(files) : null, LINKED_FILES: null, mark: vi.fn(),
              ROOT: '', join: (...parts) => parts.join('/'), readFileSync: () => '{}', execFileSync: () => '',
              parseClaims: () => ({}), porcelainFiles: () => [], mineFiles: () => new Set(['owned.md']),
              partitionFindings, partitionLocal };
            runInNewContext(`${allDemotionBlocks}\nglobalThis.notes = externalErrors;`, context);
            expect(errors.filter(finding => finding.descriptor?.kind === 'privacy-terms')).toEqual(privacy);
            expect(context.notes.filter(finding => finding.descriptor?.kind === 'privacy-terms')).toEqual([]);
          }
        }
      }
    }
  });
  it('scans newly introduced private values in config and extensionless files', () => {
    for (const file of ['.env', 'private.conf', 'Dockerfile']) {
      expect(gate({ changes: { changedFiles: [file], deletedFiles: [] }, contents: { [file]: 'syntheticoperator' } }).err)
        .toHaveBeenCalledWith(expect.stringContaining('operator-username'), { kind: 'privacy-terms', file });
    }
  });
});
