import { describe, it, expect } from 'vitest';
import { ALERT_PATTERNS, classifyAlertLine, assessAlerts, alertsOperation } from '../alerts.mjs';
import { alertSources, collectAlerts, followAlerts } from '../alerts-io.mjs';
import { main } from '../alerts-cli.mjs';
import { alertsFilePath } from '../../lib/daemon-rebuild/state.mjs';
import { feedPath } from '../needs-you-feed.mjs';

const samples = {
  'needs-you': 'NEEDS-YOU owner/repo#5716 needs a ruling',
  'smoke-rejected': 'smoke-rejected {"pr":5716}',
  'daemon-held-on-last-good': 'daemon-held-on-last-good {"reason":"smoke"}',
  'red-main': 'red-main-hold: main is red since 2026-11-21',
  'daemon-down': '[high] daemon-down review',
  'tick-exceeded': 'review tick exceeded 30s',
};

describe('alerts', () => {
  it.each(Object.entries(samples))('classifies %s', (kind, line) => {
    expect(ALERT_PATTERNS[kind]).toBeInstanceOf(RegExp);
    expect(classifyAlertLine(line)?.kind).toBe(kind);
  });
  it('excludes PRs before truncation, with exact numeric boundaries', () => {
    for (const ref of ['"pr":5716', '"pr": 5716', '#5716']) {
      expect(classifyAlertLine(`smoke-rejected ${'x'.repeat(310)} ${ref}`, { excludePrs: ['5716'] })).toBeNull();
    }
    expect(classifyAlertLine('smoke-rejected #57160', { excludePrs: [5716] }).pr).toBe(57160);
    expect(classifyAlertLine(`tick exceeded ${'x'.repeat(400)}`).text).toHaveLength(300);
    expect(classifyAlertLine('normal tick')).toBeNull();
  });
  it('uses own ISO timestamps, rejecting undated, old, future, and excluded lines', () => {
    const read = { observedAt: '2026-11-01T12:00:00Z', lines: [
      '2026-11-01T11:30:00Z smoke-rejected #1', '2026-11-01T11:29:59Z smoke-rejected',
      'NEEDS-YOU #2', '2026-11-01T12:00:01Z tick exceeded', '2026-11-01T11:59:00Z smoke-rejected #5716',
    ] };
    expect(assessAlerts(read, { excludePr: '5716' }).map((a) => a.pr)).toEqual([1]);
    expect(assessAlerts(read, { sinceMin: 5, excludePr: '5716' })).toEqual([]);
    expect(() => assessAlerts(read, { sinceMin: -1 })).toThrow();
    expect(alertsOperation({ collect: () => read }).steps.map((s) => s.step.kind)).toEqual(['compute', 'compute']);
  });
  it('discovers both log streams, canonical rebuild records and the canonical feed, deduplicated', () => {
    const env = { WE_DAEMON_STATE_DIR: '/state' }, feedOptions = { home: '/testhome', file: {} };
    expect(alertSources({ env, dir: '/agents', feedOptions, list: () => ['com.we.a', 'com.we.b'],
      read: () => ({ StandardOutPath: '/logs/shared', StandardErrorPath: '/logs/stderr', WorkingDirectory: '/clone' })
    })).toEqual(['/logs/shared', '/logs/stderr', alertsFilePath('/clone', env), feedPath({ env, ...feedOptions })]);
  });
  it('respects feed environment and settings overrides and daemon state environment', () => {
    const discover = (env) => alertSources({ env, dir: '/agents', feedOptions: { file: { path: '/settings/feed' } },
      list: () => ['com.we.a'], read: () => ({ StandardErrorPath: '/logs/stderr', WorkingDirectory: '/clone',
        EnvironmentVariables: { WE_DAEMON_STATE_DIR: '/daemon-state' } }) });
    expect(discover({ WE_NEEDS_YOU_FEED: '/env/feed' })).toEqual([
      '/logs/stderr', alertsFilePath('/clone', { WE_DAEMON_STATE_DIR: '/daemon-state' }), '/env/feed',
    ]);
    expect(discover({}).at(-1)).toBe('/settings/feed');
  });
  it('reads canonical rebuild records and classifies their kind and own timestamp', () => {
    const at = '2026-11-01T11:59:00Z';
    const read = collectAlerts({ sources: ['records'], now: () => new Date('2026-11-01T12:00:00Z'),
      tail: () => ({ text: [
        'daemon-rebuild: smoke-rejected undated',
        JSON.stringify({ at, kind: 'smoke-rejected', detail: { pr: 1 } }),
        JSON.stringify({ at, kind: 'smoke-rejected', detail: { pr: 5716 } }),
        JSON.stringify({ at, kind: 'other', detail: 'smoke-rejected' }),
        JSON.stringify({ kind: 'smoke-rejected', detail: { at } }),
        JSON.stringify({ at: '2026-11-01T11:59:00', kind: 'smoke-rejected' }),
        JSON.stringify({ at: '2026-10-01T12:00:00Z', kind: 'smoke-rejected', detail: { at } }),
        '{invalid',
      ].join('\n') }) });
    expect(assessAlerts(read, { excludePr: '5716' })).toEqual([
      expect.objectContaining({ kind: 'smoke-rejected', pr: 1, count: 1 }),
    ]);
  });
  it('collapses five identical snapshot occurrences into one counted CLI line', async () => {
    const line = 'NEEDS-YOU repo#1 ruling {"at":"2026-11-01T11:59:00Z"}';
    let output = '';
    await main([], { collect: () => ({ observedAt: '2026-11-01T12:00:00Z', lines: Array(5).fill(line) }),
      stdout: { write: (text) => { output += text; } } });
    expect(output).toBe(`${line} ×5\n`);
  });
  it('bounds tail reads and discards an initial partial line', () => {
    expect(collectAlerts({ sources: ['log'], now: () => new Date(0), tail: (_, opts) => {
      expect(opts.maxBytes).toBe(512 * 1024);
      return { text: 'partial\nwhole\n', truncated: true };
    } }).lines).toEqual(['whole', '']);
    expect(() => collectAlerts({ sources: ['log'], tail: () => ({ error: 'denied' }) })).toThrow('denied');
  });
  it('documents Monitor use and forwards follow exclusions without collecting a snapshot', async () => {
    let help = '', followed;
    await main(['--help'], { stdout: { write: (text) => { help += text; } } });
    expect(help).toContain('Monitor command');
    expect(help).toContain('polls every 2 seconds');
    await main(['--follow', '--exclude-pr=5716,5717'], {
      collect: () => { throw new Error('must not collect'); }, follow: (options) => { followed = options; },
    });
    expect(followed.excludePrs).toEqual(['5716', '5717']);
    await expect(main(['--follow', '--unknown'])).rejects.toThrow(/follow accepts/);
  });
  it('runs the declared operation through the CLI with kebab-case flags and JSON', async () => {
    let output = '';
    const result = await main(['--since-min=5', '--exclude-pr=5716,5717', '--json'], {
      collect: () => ({ observedAt: '2026-11-01T12:00:00Z', lines: ['2026-11-01T11:59:00Z tick exceeded #1', '2026-11-01T11:59:00Z tick exceeded #5717'] }),
      stdout: { write: (text) => { output += text; } },
    });
    expect(result.code).toBe(0); expect(JSON.parse(output).map((a) => a.pr)).toEqual([1]);
  });
});

/** An async fs fake, including independent file identities for rotation. */
function fakeFiles() {
  let bytes = Buffer.from('NEEDS-YOU old\n'), ino = 1, missing = false, rot = null;
  const stat = async () => { if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { size: bytes.length, ino, dev: 1 }; };
  return {
    fs: { stat, readFile: async () => {
      if (rot === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return `${rot}\n`;
    }, open: async () => { await stat(); return { stat, close: async () => {}, read: async (buffer, offset, length, position) => {
      const bytesRead = bytes.copy(buffer, offset, position, position + length); return { bytesRead };
    } }; } },
    append: (text) => { bytes = Buffer.concat([bytes, Buffer.from(text)]); },
    replace: (text, rotate = false) => { bytes = Buffer.from(text); if (rotate) ino++; },
    rotation: (value) => { rot = value; },
    missing: (value) => { missing = value; },
  };
}

describe('followAlerts', () => {
  it('emits complete appended lines once; handles truncation, rotation, disappearance and repeated occurrences', async () => {
    const files = fakeFiles(), emitted = [];
    let cancelled = false;
    const follow = await followAlerts({ sources: ['log'], fileSystem: files.fs,
      excludePrs: [5716], onLine: (alert) => emitted.push(alert.text),
      schedule: (_, ms) => { expect(ms).toBe(2000); return 1; }, cancel: () => { cancelled = true; } });
    files.append('NEEDS-YOU fresh'); await follow.poll(); expect(emitted).toEqual([]);
    files.append('\nNEEDS-YOU fresh\nNEEDS-YOU #5716\n'); await follow.poll(); await follow.poll();
    expect(emitted).toEqual(['NEEDS-YOU fresh', 'NEEDS-YOU fresh']);
    files.replace('tick exceeded\n'); await follow.poll(); expect(emitted.at(-1)).toBe('tick exceeded');
    files.replace('NEEDS-YOU rotated with a longer line\n', true); await follow.poll();
    expect(emitted.at(-1)).toBe('NEEDS-YOU rotated with a longer line');
    files.missing(true); await follow.poll(); files.missing(false);
    files.replace('NEEDS-YOU fresh\n', true); await follow.poll(); expect(emitted).toHaveLength(5);
    files.append('NEEDS-YOU fresh\n'); await follow.poll(); expect(emitted).toHaveLength(6);
    follow.stop(); expect(cancelled).toBe(true);
  });
  it.each([null, 3])('resets the cursor and decoder when copy-truncate regrows past the old offset (previous counter %s)', async (rot) => {
    const files = fakeFiles(), emitted = [];
    files.rotation(rot);
    const follow = await followAlerts({ sources: ['log'], fileSystem: files.fs, onLine: (a) => emitted.push(a.text),
      schedule: () => 1, cancel: () => {} });
    files.append(Buffer.concat([Buffer.from('NEEDS-YOU partial'), Buffer.from([0xc3])])); await follow.poll();
    files.replace(`NEEDS-YOU ${'new'.repeat(30)}\n`); files.rotation(4);
    await follow.poll(); await follow.poll();
    expect(emitted).toEqual([`NEEDS-YOU ${'new'.repeat(30)}`]); follow.stop();
  });
  it('emits identical occurrences across sources and lines with the same 300-character prefix', async () => {
    const files = fakeFiles(), emitted = [];
    const follow = await followAlerts({ sources: ['a', 'b'], fileSystem: files.fs, onLine: (a) => emitted.push(a.text),
      schedule: () => 1, cancel: () => {} });
    const prefix = `NEEDS-YOU ${'x'.repeat(300)}`;
    files.append(`${prefix}first\n${prefix}second\n`); await follow.poll(); await follow.poll();
    expect(emitted).toEqual(Array(4).fill(prefix.slice(0, 300))); follow.stop();
  });
  it('preserves split UTF-8 bytes and drops partial old content on rotation', async () => {
    const files = fakeFiles(), emitted = [];
    const follow = await followAlerts({ sources: ['log'], fileSystem: files.fs, onLine: (a) => emitted.push(a.text), schedule: () => 1, cancel: () => {} });
    files.append(Buffer.concat([Buffer.from('NEEDS-YOU '), Buffer.from([0xc3])])); await follow.poll();
    files.append(Buffer.from([0xa9, 10])); await follow.poll(); expect(emitted).toEqual(['NEEDS-YOU é']);
    files.append('NEEDS-YOU partial'); await follow.poll(); files.replace('tick exceeded rotated\n', true); await follow.poll();
    expect(emitted.at(-1)).toBe('tick exceeded rotated'); follow.stop();
  });
});
