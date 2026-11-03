import { describe, expect, it } from 'vitest';
import { formatTimingLine, instrumentGit, summarizePackets, summarizeTrace2 } from '../freeze-read-timing-log.mjs';

describe('freeze-read-timing-log', () => {
  it('formats one prefixed JSON line', () => {
    const line = formatTimingLine({ cmd: 'fetch', ms: 21000, ok: false });
    expect(line).toBe('freeze-read-timing {"cmd":"fetch","ms":21000,"ok":false}');
  });
  it('summarizes trace2 child spans', () => {
    const t = [{ event: 'child_start', child_id: 1, t_abs: 1, argv: ['git-remote-https', 'origin'] }, { event: 'child_exit', child_id: 1, t_abs: 3.5, t_rel: 3.5 }].map((e) => JSON.stringify(e)).join('\n');
    expect(summarizeTrace2(t)).toEqual([{ child: 'git-remote-https origin', ms: 2500 }]);
  });
  it('summarizes packet offsets', () => {
    const p = '10:00:01.500000 pkt-line.c:80 packet: fetch< 000\n10:00:02.000000 pkt-line.c:80 packet: fetch> want abc\n10:00:04.000000 pkt-line.c:80 packet: fetch< packfile\n';
    expect(summarizePackets(p, 10 * 3600 * 1000 + 1000)).toMatchObject({ packets: 3, firstPacketMs: 500, wantMs: 1000, packfileMs: 3000 });
  });
  it('is transparent: returns the result, scopes trace env to fetch, logs a line', () => {
    const lines = []; const seen = [];
    const run = instrumentGit((args, opts) => { seen.push(opts.env); return 'out'; }, { log: (l) => lines.push(l) });
    expect(run(['fetch', '--quiet'], { cwd: '/nonexistent' })).toBe('out');
    expect(run(['ls-tree', 'x'], { cwd: '/nonexistent' })).toBe('out');
    expect(seen[0].GIT_TRACE2_EVENT).toBeTruthy();
    expect(seen[1]).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^freeze-read-timing \{.*"cmd":"fetch".*\}$/);
  });
  it('rethrows the original error and still logs', () => {
    const lines = []; const boom = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    const run = instrumentGit(() => { throw boom; }, { log: (l) => lines.push(l) });
    expect(() => run(['fetch'], { cwd: '/nonexistent' })).toThrow(boom);
    expect(lines[0]).toContain('"err":"ETIMEDOUT"');
  });
});
