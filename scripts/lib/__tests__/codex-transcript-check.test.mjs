import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  it.each(['/bin/sleep', '/usr/bin/sleep', './sleep', '../bin/sleep'])('flags polling loops with path-qualified sleep executables: %s', executable => {
    expect(check(`while true; do ${executable} 1; done`).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each(['/bin/sleepy', './oversleep'])('does not treat other executable names as sleep: %s', executable => {
    expect(check(`while true; do ${executable} 1; done`).flags).toEqual([]);
  });
  it.each([
    '(while true; do sleep 1; done)',
    '{ until x; do sleep 1; done; }',
    'poll() { until x; do sleep 1; done; }',
    '(echo ready; while true; do sleep 1; done)',
    '(true && while true; do sleep 1; done)',
    '(false || while true; do sleep 1; done)',
    '(echo ready | while true; do sleep 1; done)',
    '(if true; then while true; do sleep 1; done; fi)',
    '(for x in a; do while true; do sleep 1; done; done)',
    '(echo ready\nwhile true; do sleep 1; done)',
    '(for x in a; do npx vitest run x; done)',
  ])('flags shell loops at grouped command boundaries: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each([
    '{ until x; do :; done; }',
    '(while ready; do :; done)',
    '(echo "while true; do sleep 1; done")',
    '(echo while true; do sleep 1; done)',
    'for (let x = 0; x < 2; x++) { echo("while sleep"); }',
  ])('does not invent risky loops in clean groups or JS headers: %s', command => {
    expect(check(command).flags).toEqual([]);
  });
  it('flags polling loops after then and else', () => {
    const commands = [
      'if true; then while true; do sleep 1; done; fi',
      'if false; then echo no; else while true; do sleep 1; done; fi',
      'if true; then for x in a; do npx vitest run x; done; fi',
      'if false; then echo no; else until ready; do sleep 1; done; fi',
      'if true; then\nwhile true; do sleep 1; done; fi',
    ];
    for (const command of commands) expect(check(command).flags.map(flag => flag.kind), command).toContain('loop');
  });
  it.each([
    'if while ready; do sleep 1; done; then echo yes; fi',
    'if false; then echo no; elif while ready; do sleep 1; done; then echo yes; fi',
    '! while ready; do sleep 1; done',
  ])('flags polling loops in shell control conditions: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each([
    'echo then while true; do sleep 1; done',
    'echo else while true; do sleep 1; done',
    'echo "then while true; do sleep 1; done"',
    'if true; then echo "else for while sleep"; fi',
  ])('does not treat argument or quoted control keywords as command boundaries: %s', command => {
    expect(check(command).flags).toEqual([]);
  });
  it('flags polling loops when ordinary arguments contain loop keywords', () => {
    expect(check('while true; do echo waiting for server; sleep 1; done').flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each([
    'while true; do echo while until for do done; sleep 1; done',
    'while true; do echo "for do done"; sleep 1; done',
    "while true; do echo 'done while for'; sleep 1; done",
    String.raw`while true; do echo "escaped \" for"; sleep 1; done`,
    'while true; do for x in a b; do echo waiting for server; done; sleep 1; done',
    'while true; do for x in a b; do sleep 1; done; done',
    'while (ready) { console.log("for while done"); sleep(1); }',
    'while (ready) { for (let i = 0; i < 2; i++) { sleep(1); } }',
  ])('distinguishes loop syntax from arguments and quoted strings: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each([
    'echo "while true; do sleep 1; done"',
    "echo 'for x in a; do sleep 1; done'",
    'while true; do echo "done sleep for"; done',
    'for x in a b; do while ready; do echo ok; done; done',
  ])('does not invent risky loops from quoted syntax or clean nested loops: %s', command => {
    expect(check(command).flags).toEqual([]);
  });
  it.each(['echo x > /tmp/x', 'echo x >> /tmp/x', 'echo x | tee /tmp/x', 'mktemp', 'curl x -o /tmp/x', 'cp source /tmp/x', 'mv source /tmp/x', 'mkdir -p /tmp/x'])('flags tmp-write: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('tmp-write');
  });
  it('scans oversized adversarial loop syntax within a bounded runtime', () => {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { checkTranscriptText } from './scripts/lib/codex-transcript-check.mjs';
      const cmd = 'for do '.repeat(20000);
      const record = JSON.stringify({ payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) } });
      console.log(JSON.stringify(checkTranscriptText(record).flags));
    `], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual([]);
  });
  it.each(['while (ready) { sleep(1); }', 'for (let i = 0; i < 2; i++) { vitest(); }'])('flags JS loop: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('loop');
  });
  it.each(['env curl x', 'sudo curl x', 'command curl x', 'exec curl x', 'KEY=value curl x', 'rg curl file; curl x'])('honours network wrappers and per-segment suppression: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('network');
  });
  it.each([
    'curl https://x/rg', 'curl https://x/grep', 'curl x rg', 'gh api /grep',
    'git fetch origin rg', 'env KEY=value sudo command curl https://x/rg',
    'rg curl file; curl https://x/grep', 'grep curl file | curl https://x/rg',
  ])('does not suppress network commands with search words in arguments: %s', command => {
    expect(check(command).flags.map(flag => flag.kind)).toContain('network');
  });
  it.each([
    'rg curl file', 'grep gh file', 'env KEY=value sudo command rg do curl file',
    'KEY=value exec grep do curl file',
  ])('suppresses search commands only at the command word after wrappers: %s', command => {
    expect(check(command).flags).toEqual([]);
  });
  it('does not treat npx as an allowed network wrapper', () => {
    expect(check('npx curl x').flags).toEqual([]);
  });
  it.each([
    'curl x -H "X-Secret: header-secret"',
    "curl x -H 'X-Secret: header-secret'",
    'curl x -HX-Secret:header-secret',
    'curl x Authorization: auth-secret',
    'curl x Bearer bearer-secret',
    'curl https://example.test?token=query-secret&x=1',
    'curl x token="quoted secret"',
    'curl x -H "Authorization: Bearer header-secret"',
    'curl x -H "X-Secret: header-secret',
    'curl x -H "X-Secret:\nheader-secret"',
    'curl x token="quoted secret',
  ])('omits secret arguments from returned and persisted flags: %s', command => {
    const appendLog = vi.fn();
    const result = runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode: 'warn' }, readFile: () => call(command), appendLog });
    expect(result.flags).toHaveLength(1);
    const persisted = JSON.stringify(result.flags) + appendLog.mock.calls[0][1];
    for (const secret of ['header-secret', 'auth-secret', 'bearer-secret', 'query-secret', 'quoted secret']) expect(persisted).not.toContain(secret);
    expect(result.flags[0]).toEqual({ kind: result.flags[0].kind, length: command.length });
  });
  it.each([
    'GH_TOKEN=credential-value curl x',
    'API_KEY=credential-value curl x',
    'MY_SECRET_VALUE=credential-value curl x',
    'PASSWORD=credential-value curl x',
    'DB_PASS=credential-value curl x',
    'MONKEY=credential-value curl x',
    'curl x password=credential-value',
    'curl x api_key="credential-value with spaces"',
    'curl x secret=credential-value',
    'curl x -u user:credential-value',
    'curl x -uuser:credential-value',
    'curl x --user "user:credential-value"',
    'curl x --user=user:credential-value',
    'curl x --header "X-Custom: credential-value"',
    'curl x --header="X-Custom: credential-value"',
    'curl x -b "session=credential-value"',
    'curl x -bsession=credential-value',
    'curl x --cookie=session=credential-value',
    'curl x --cookie "session=credential-value"',
    'curl x -d "field=credential-value"',
    'curl x -dfield=credential-value',
    'curl x --data "field=credential-value"',
    'curl x --data=field=credential-value',
    'curl https://user:credential-value@example.test/path',
    'curl x --header "X-Custom: credential-value',
    'curl x --user "user:\ncredential-value"',
    'curl x --cookie "session=\ncredential-value',
    'curl x --data "field=\ncredential-value',
    'API_KEY="credential-value\ntrailing-sensitive-value" curl x; echo x > /tmp/x',
    'curl x ' + 'x'.repeat(100) + ' --data "credential-value trailing-sensitive-value"',
  ])('omits additional credential forms from returned and persisted flags: %s', command => {
    const appendLog = vi.fn();
    const result = runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode: 'warn' }, readFile: () => call(command), appendLog });
    expect(result.flags).toHaveLength(1);
    const persisted = JSON.stringify(result.flags) + appendLog.mock.calls[0][1];
    expect(persisted).not.toContain('credential-value');
    expect(persisted).not.toContain('trailing-sensitive-value');
    expect(result.flags[0]).toEqual({ kind: result.flags[0].kind, length: command.length });
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
    expect(result).not.toHaveProperty('commands');
  });
  it('uses maximum cumulative tokens and flags only above the cap', () => {
    expect(checkTranscriptText(fixture(tokens(100), tokens(90)), { tokenCap: 100 })).toMatchObject({ totalTokens: 100, flags: [] });
    expect(checkTranscriptText(fixture(tokens(100), tokens(90)), { tokenCap: 99 }).flags[0].kind).toBe('token-cap');
  });
  it('deduplicates identical findings and bounds findings without retaining arguments', () => {
    const input = fixture(call('gh issue list'), call('gh issue list'), ...Array.from({ length: 30 }, (_, i) => call(`curl https://example.test/${i}/${'x'.repeat(300)}`)));
    const result = checkTranscriptText(input);
    expect(result.flags).toHaveLength(20);
    expect(result.flags.filter(flag => flag.kind === 'network' && flag.length === 'gh issue list'.length)).toHaveLength(1);
    expect(result.flags.every(flag => Object.keys(flag).sort().join(',') === 'kind,length' && Number.isSafeInteger(flag.length))).toBe(true);
  });
  it('inspects long tool arguments without the summarizer default truncation', () => {
    expect(check(`echo ${'x'.repeat(10000)}; git fetch origin`).flags[0].kind).toBe('network');
  });
  it.each([
    'gh api /private/path --field arbitrary=unclassified-value',
    'curl https://example.test/private?session=unclassified-value',
    'unknown-private-executable unclassified-value > /tmp/private-path',
    'while true; do echo unclassified-value; sleep 1; done',
    'echo unclassified-value',
  ])('returns no command text or arguments for any inspected command: %s', command => {
    const appendLog = vi.fn();
    const inspected = check(command);
    const report = runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode: 'warn' }, readFile: () => call(command), appendLog });
    expect(inspected).not.toHaveProperty('commands');
    const output = JSON.stringify({ inspected, report }) + appendLog.mock.calls[0][1];
    for (const argument of ['unclassified-value', '/private/path', 'unknown-private-executable', '/tmp/private-path', 'https://example.test']) expect(output).not.toContain(argument);
    for (const flag of inspected.flags) expect(flag).toEqual({ kind: flag.kind, length: command.length });
  });
  it.each(['warn', 'fail'])('flags capped tool input as truncated and returns %s for unverifiable evidence', mode => {
    const command = `echo ${'x'.repeat(200001)}; gh api /hidden-tail`;
    const appendLog = vi.fn();
    const result = runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode }, readFile: () => call(command), appendLog });
    expect(result.verdict).toBe(mode);
    expect(result.flags).toEqual([{ kind: 'truncated', length: JSON.stringify({ cmd: command }).length }]);
    expect(appendLog.mock.calls[0][1]).not.toContain('/hidden-tail');
  });
  it('inspects tool input at the cap and flags custom snippets above it', () => {
    const suffix = '; git fetch origin';
    const command = `echo ${'x'.repeat(200000 - JSON.stringify({ cmd: 'echo ' + suffix }).length)}${suffix}`;
    expect(JSON.stringify({ cmd: command })).toHaveLength(200000);
    expect(check(command).flags).toEqual([{ kind: 'network', length: command.length }]);
    const input = `await tools.exec_command({cmd: "${'x'.repeat(200001)}; gh api /private-tail"})`;
    const custom = JSON.stringify({ payload: { type: 'custom_tool_call', name: 'exec', input } });
    expect(checkTranscriptText(custom).flags).toEqual([{ kind: 'truncated', length: input.length }]);
  });
  it('flags oversized raw tool input even when printable sanitization shrinks it', () => {
    const input = '\u001b[31m'.repeat(40001) + 'echo clean';
    const custom = JSON.stringify({ payload: { type: 'custom_tool_call', name: 'exec', input } });
    expect(checkTranscriptText(custom).flags).toEqual([{ kind: 'truncated', length: input.length }]);
  });
  it.each(['{}', '{}\n{}', '{"type":"message"}', '{"type":"future_record","payload":{"type":"future_event","text":"private-value"}}'])('flags wholly unrecognized evidence: %s', transcript => {
    expect(checkTranscriptText(transcript).flags).toEqual([{ kind: 'unrecognized', length: transcript.length }]);
  });
  it.each(['warn', 'fail'])('returns %s and logs no content for wholly unrecognized evidence', mode => {
    const transcript = '{"private":"private-value"}';
    const appendLog = vi.fn();
    const result = runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode }, readFile: () => transcript, appendLog });
    expect(result.verdict).toBe(mode);
    expect(result.flags).toEqual([{ kind: 'unrecognized', length: transcript.length }]);
    expect(appendLog.mock.calls[0][1]).not.toContain('private-value');
  });
  it.each([
    call('true'), tokens(0),
    JSON.stringify({ payload: { type: 'message', content: [] } }),
    JSON.stringify({ payload: { type: 'function_call_output', output: 'ok' } }),
    JSON.stringify({ type: 'turn_context', payload: { cwd: 'repo' } }),
  ])('accepts recognized evidence alongside unknown records: %s', record => {
    expect(checkTranscriptText(fixture('{}', record)).flags).toEqual([]);
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
  it('uses the supplied runner env coordination root for the log', () => {
    const appendLog = vi.fn();
    const env = { WE_COORDINATION_ROOT: './fixture-coordination-root' };
    const result = checkRunTranscript({ env, threadId: 'own', emit: vi.fn(),
      resolvePolicy: () => ({ mode: 'warn' }), findRolloutFile: () => 'fixture',
      runCheck: options => runTranscriptCheck({ ...options, readFile: () => call('true'), appendLog }) });
    expect(result.verdict).toBe('clean');
    expect(appendLog.mock.calls[0][0]).toBe(join(resolveCoordinationRoot({ env }), 'codex-transcript-check.jsonl'));
  });
  it('tells the operator to inspect the full rollout when capped evidence is rejected', () => {
    const emit = vi.fn();
    const result = checkRunTranscript({ env: {}, threadId: 'own', emit,
      resolvePolicy: () => ({ mode: 'fail' }), findRolloutFile: () => 'fixture',
      runCheck: options => runTranscriptCheck({ ...options, readFile: () => call('x'.repeat(200001)), appendLog: vi.fn() }) });
    expect(result.verdict).toBe('fail');
    expect(emit).toHaveBeenCalledWith('codex-transcript-check · truncated input: inspect the full rollout manually; retry with smaller commands');
  });
  it('returns clean and supplies a real timestamp by default', () => {
    const appendLog = vi.fn();
    expect(runTranscriptCheck({ rolloutFile: 'fixture', policy: { mode: 'fail' }, readFile: () => call('true'), appendLog }).verdict).toBe('clean');
    expect(Number.isFinite(Date.parse(JSON.parse(appendLog.mock.calls[0][1]).ts))).toBe(true);
  });
  it('records lookup errors without throwing from the runner boundary', () => {
    expect(checkRunTranscript({ env: {}, threadId: 'own', codexHome: 'fixture', emit: vi.fn(), findRolloutFile: () => { throw new Error('unreadable'); } })).toEqual({ mode: 'warn', error: 'unreadable' });
  });
  it.each(['lookup', 'read', 'log', 'emit'])('retains resolved fail mode after %s failure', stage => {
    const error = () => { throw new Error(`${stage} denied`); };
    const result = checkRunTranscript({ threadId: 'own', env: { WE_CODEX_TRANSCRIPT_CHECK_MODE: 'warn' },
      resolvePolicy: () => ({ mode: 'fail' }), runCheck: options => runTranscriptCheck({ ...options, readFile: stage === 'read' ? error : () => call('true'), appendLog: stage === 'log' ? error : vi.fn() }),
      findRolloutFile: stage === 'lookup' ? error : () => 'fixture', emit: stage === 'emit' ? error : vi.fn() });
    expect(result).toEqual({ mode: 'fail', error: `${stage} denied` });
  });
  it.each(['fail', 'warn'])('uses environment %s when policy resolution fails', mode => {
    expect(checkRunTranscript({ env: { WE_CODEX_TRANSCRIPT_CHECK_MODE: mode },
      resolvePolicy: () => { throw new Error('policy denied'); }, emit: vi.fn() }))
      .toEqual({ mode, error: 'policy denied' });
  });
  it('refuses missing, unreadable transcripts and failed append operations', () => {
    expect(() => runTranscriptCheck({ policy: {} })).toThrow('not found');
    expect(() => runTranscriptCheck({ rolloutFile: 'fixture', policy: {}, readFile: missing })).toThrow('missing');
    expect(() => runTranscriptCheck({ rolloutFile: 'fixture', policy: {}, readFile: () => call('true'), appendLog: () => { throw new Error('log denied'); } })).toThrow('log denied');
  });
});
