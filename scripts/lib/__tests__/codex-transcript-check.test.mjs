import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { checkTranscriptText, resolveTranscriptCheckPolicy, runTranscriptCheck, checkRunTranscript } from '../codex-transcript-check.mjs';

const call = (cmd, name = 'exec_command') => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify({ cmd }) } });
const tokens = total_tokens => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens } } } });
const fixture = (...records) => records.join('\n');
const check = command => checkTranscriptText(call(command), { tokenCap: 3000000 });
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

describe('checkTranscriptText fixture rollouts', () => {
  it.each(['while true; do sleep 2; done', 'until ready; do sleep 1; done', 'for x in a b; do node scripts/readiness/heavy-admission.mjs run -- true; done', 'for x in a; do npx vitest run x; done'])('flags loop: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each(['echo x > /tmp/x', 'echo x >> /tmp/x', 'echo x | tee /tmp/x', 'mktemp', 'curl x -o /tmp/x', 'cp source /tmp/x', 'mv source /tmp/x', 'mkdir -p /tmp/x'])('flags tmp-write: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('tmp-write');
  });
  it('flags apply_patch and edit targets', () => {
    const patch = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: /tmp/x\n+hi\n*** End Patch' } });
    const edit = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'edit', arguments: '{"file_path":"/tmp/x","text":"hello"}' } });
    expect(checkTranscriptText(patch).flags[0].kind).toBe('tmp-write');
    expect(checkTranscriptText(edit).flags[0].kind).toBe('tmp-write');
  });
  it.each(['gh issue list', 'curl https://example.test', 'git fetch origin', 'git push origin HEAD', 'git -C repo fetch origin', 'git -C /srv/repo push origin HEAD', 'curl', 'curl https://example.test | grep ok'])('flags network: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('network');
  });
  it.each(['echo x > "$TMPDIR/x"', 'echo x > /private/tmp/claude-task/x', 'mktemp -p "$TMPDIR"', 'TMPDIR="$TMPDIR" mktemp', 'cat /tmp/x', 'rg "gh " file', 'grep "curl " file', 'for x in a b; do echo "$x"; done', 'sleep 1', 'echo gh issue list'])('does not flag %s', command => {
    expect(check(command).flags).toEqual([]);
  });
  it('does not count repeated bare sleep calls as loops', () => {
    expect(checkTranscriptText(fixture(call('sleep 1'), call('sleep 1'), call('sleep 1'))).flags).toEqual([]);
  });
  it('decodes command arrays and custom JS snippets; ignores assistant text', () => {
    const array = JSON.stringify({ payload: { type: 'function_call', name: 'shell', arguments: '{"command":["git","fetch","origin"]}' } });
    const custom = JSON.stringify({ payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({cmd: "echo hello > /tmp/file"})' } });
    const message = JSON.stringify({ payload: { type: 'message', content: [{ type: 'text', text: 'gh issue list' }] } });
    const result = checkTranscriptText(fixture(array, custom, message));
    expect(result.flags.map(flag => flag.kind)).toEqual(['network', 'tmp-write']);
    expect(result.commands).toEqual(['git fetch origin', 'echo hello > /tmp/file']);
  });
  it('uses maximum cumulative tokens and flags only above the cap', () => {
    expect(checkTranscriptText(fixture(tokens(100), tokens(90)), { tokenCap: 100 })).toMatchObject({ totalTokens: 100, flags: [] });
    expect(checkTranscriptText(fixture(tokens(100), tokens(90)), { tokenCap: 99 }).flags[0].kind).toBe('token-cap');
  });
  it('deduplicates identical findings and bounds excerpts and findings on oversized input', () => {
    const input = fixture(call('gh issue list'), call('gh issue list'), ...Array.from({ length: 30 }, (_, i) => call(`curl https://example.test/${i}/${'x'.repeat(300)}`)));
    const result = checkTranscriptText(input);
    expect(result.flags).toHaveLength(20);
    expect(result.flags.filter(flag => flag.detail === 'gh issue list')).toHaveLength(1);
    expect(result.flags.every(flag => flag.detail.length <= 160)).toBe(true);
  });
  it('inspects long tool arguments without the summarizer default truncation', () => {
    expect(check(`echo ${'x'.repeat(10000)}; git fetch origin`).flags[0].kind).toBe('network');
  });
  it('refuses empty or malformed evidence instead of reporting clean', () => {
    expect(() => checkTranscriptText('')).toThrow('Empty');
    expect(() => checkTranscriptText(`${call('true')}\n{broken`)).toThrow('Malformed');
  });
});

describe('transcript check policy cascade', () => {
  it('defaults to warn and 3000000 with standard provenance when settings are absent', () => {
    expect(resolveTranscriptCheckPolicy({ env: {}, readFile: missing })).toEqual({ mode: 'warn', tokenCap: 3000000, sources: { mode: 'standard', tokenCap: 'standard' } });
  });
  it('loads the tool settings file over platform preferences', () => {
    const readFile = vi.fn(() => '{"transcriptCheck":{"mode":"warn","tokenCap":200}}');
    expect(resolveTranscriptCheckPolicy({ env: {}, readFile, platform: { mode: 'fail', tokenCap: 100 } })).toEqual({ mode: 'warn', tokenCap: 200, sources: { mode: 'tool', tokenCap: 'tool' } });
    expect(String(readFile.mock.calls[0][0])).toMatch(/scripts\/settings\/codex-transcript-check.json$/);
  });
  it('uses platform below tool and environment above both', () => {
    expect(resolveTranscriptCheckPolicy({ env: {}, tool: {}, platform: { mode: 'fail', tokenCap: 12 } })).toMatchObject({ mode: 'fail', tokenCap: 12, sources: { mode: 'platform', tokenCap: 'platform' } });
    expect(resolveTranscriptCheckPolicy({ env: { WE_CODEX_TRANSCRIPT_CHECK_MODE: 'fail', WE_CODEX_TRANSCRIPT_TOKEN_CAP: '42' }, tool: { transcriptCheck: { mode: 'warn', tokenCap: 100 } }, platform: {} })).toEqual({ mode: 'fail', tokenCap: 42, sources: { mode: 'env', tokenCap: 'env' } });
  });
  it.each(['bad', '-1', '1.5', '9007199254740992'])('ignores invalid values: %s', invalid => {
    expect(resolveTranscriptCheckPolicy({ env: { WE_CODEX_TRANSCRIPT_CHECK_MODE: invalid, WE_CODEX_TRANSCRIPT_TOKEN_CAP: invalid }, tool: { transcriptCheck: { mode: false, tokenCap: invalid } }, platform: { mode: 'fail', tokenCap: 25 } })).toMatchObject({ mode: 'fail', tokenCap: 25 });
  });
});

describe('runTranscriptCheck', () => {
  it.each(['warn', 'fail'])('returns %s verdict and appends one structured log record', mode => {
    const appendLog = vi.fn(), readFile = vi.fn(() => fixture(call('gh issue list'), tokens(123)));
    const result = runTranscriptCheck({ rolloutFile: 'fixture.jsonl', threadId: 'own-thread', policy: { mode, tokenCap: 200 }, readFile, appendLog, now: () => new Date('2026-10-22T12:00:00Z') });
    expect(result).toMatchObject({ mode, rolloutFile: 'fixture.jsonl', totalTokens: 123, verdict: mode });
    expect(appendLog).toHaveBeenCalledOnce();
    expect(appendLog.mock.calls[0][0]).toBe(join(resolveCoordinationRoot(), 'codex-transcript-check.jsonl'));
    expect(appendLog.mock.calls[0][1].split('\n')).toHaveLength(2);
    expect(JSON.parse(appendLog.mock.calls[0][1])).toEqual({ ts: '2026-10-22T12:00:00.000Z', threadId: 'own-thread', rolloutFile: 'fixture.jsonl', verdict: mode, totalTokens: 123, flags: result.flags });
  });
  it('returns clean and supplies a real timestamp by default', () => {
    const appendLog = vi.fn();
    expect(runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode: 'fail' }, readFile: () => call('true'), appendLog }).verdict).toBe('clean');
    expect(Number.isFinite(Date.parse(JSON.parse(appendLog.mock.calls[0][1]).ts))).toBe(true);
  });
  it('records lookup errors without throwing from the runner boundary', () => {
    expect(checkRunTranscript({ env: {}, threadId: 'own', codexHome: 'fixture', emit: vi.fn(), findRolloutFile: () => { throw new Error('unreadable'); } })).toEqual({ error: 'unreadable' });
  });
  it('refuses missing, unreadable transcripts and failed append operations', () => {
    expect(() => runTranscriptCheck({ policy: {} })).toThrow('not found');
    expect(() => runTranscriptCheck({ rolloutFile: 'fixture', policy: {}, readFile: missing })).toThrow('missing');
    expect(() => runTranscriptCheck({ rolloutFile: 'fixture', policy: {}, readFile: () => call('true'), appendLog: () => { throw new Error('log denied'); } })).toThrow('log denied');
  });
});
