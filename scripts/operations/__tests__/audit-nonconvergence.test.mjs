// @repo-scanning-test scope=files
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { diagnose, readManifest, runCli } from '../audit-nonconvergence.mjs';
import { scopedScanFiles, SCAN_ROOT_ENV } from '../../lib/repo-scan-tests.mjs';

const fixtures = resolve('scripts/operations/__tests__/fixtures/audit-nonconvergence');
const load = name => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const seed = () => load('two-new-classes.json');
const fallback = 'Human review of full audit history required';
const cli = resolve('scripts/operations/audit-nonconvergence.mjs');
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function manifest(classes) {
  const m = seed();
  m.rounds = classes.map((cs, i) => ({ ...structuredClone(m.rounds[0]), sequence: i + 1,
    head: (i + 1).toString(16).padStart(40, '0'), verdict: cs.length ? 'WEAKENED' : 'NOT WEAKENED',
    findings: cs.map((c, j) => ({ ...m.rounds[0].findings[0], id: `f${j}`, class: c })) }));
  m.provenance.sourceSha256 = sha(m.rounds);
  m.provenance.selection = m.rounds.map((r, i) => ({ sequence: i + 1, recordIndex: i + 1, recordSha256: sha(r) }));
  return m;
}
function incomplete(out, reason) {
  expect(out.exitCode).toBe(2);
  expect(out.result).toEqual({ schemaVersion: 1, kind: 'audit-nonconvergence-diagnostic', enforcement: false,
    status: 'INCOMPLETE', reason: reason ?? expect.any(String), action: fallback });
}
const streaks = m => diagnose(m).result.rounds.map(r => r.streak);
const temp = () => mkdtempSync(join(process.env.TMPDIR, 'audit-nonconvergence-'));
function child(args, cwd) {
  const p = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20 });
  expect(p.error).toBeUndefined();
  return { exitCode: p.status, result: JSON.parse(p.stdout), stderr: p.stderr };
}

describe('diagnostic v1', () => {
  it('two_new_classes_recommend_after_second_round', () => {
    expect(diagnose(seed())).toEqual({ exitCode: 10, result: load('two-new-classes.expected.json') });
    const m = seed();
    expect(m.provenance.sourceSha256).toBe(sha(m.rounds));
    m.rounds.forEach((r, i) => expect(m.provenance.selection[i].recordSha256).toBe(sha(r)));
  });
  it('unchanged_class_resets_without_erasing_history', () => {
    expect(streaks(manifest([['B2'], ['B2'], ['B1']]))).toEqual([1, 0, 1]);
    expect(streaks(manifest([['B2'], [], ['B2']]))).toEqual([1, 0, 0]);
    expect(diagnose(load('unchanged.json'))).toEqual({ exitCode: 0, result: load('unchanged.expected.json') });
  });
  it('sticky_recommendation_survives_later_reset', () => {
    const out = diagnose(manifest([['B2'], ['B1'], ['B1']]));
    expect(out.exitCode).toBe(10); expect(out.result.recommendationAt).toBe(2);
    expect(out.result.rounds.map(r => r.streak)).toEqual([1, 2, 0]);
  });
  it('rename_only_does_not_create_class_novelty', () => {
    const m = manifest([['B2'], ['B2']]); m.rounds[1].findings[0].file = 'src/renamed.mjs';
    m.rounds[1].findings[0].text = 'Renamed symbol'; expect(streaks(m)).toEqual([1, 0]);
  });
  it('distinct_findings_same_file_class_are_preserved', () => {
    const m = manifest([['B2', 'B2']]); const out = diagnose(m);
    expect(out.result.rounds[0].findings).toEqual(m.rounds[0].findings);
    expect(out.result.rounds[0].newClasses).toEqual(['B2']); expect(out.exitCode).toBe(0);
  });
  it.each(['unchanged_findings_do_not_increment', 'rebase_unchanged_classes_reset'])('%s', () => {
    expect(streaks(manifest([['B2'], ['B2']]))).toEqual([1, 0]);
  });
  it('first_clean_round_is_zero', () => expect(streaks(manifest([[], ['B2']]))).toEqual([0, 1]));
  it('class_arrays_are_sorted_and_input_is_unchanged', () => {
    const m = manifest([['X2', 'B2', 'B1']]); const before = structuredClone(m);
    expect(diagnose(m).result.rounds[0].newClasses).toEqual(['B1', 'B2', 'X2']); expect(m).toEqual(before);
  });
  it('B1_is_preserved_in_recommendation_and_no_recommendation', () => {
    for (const m of [seed(), manifest([['B1', 'B1']])]) {
      const out = diagnose(m); expect(out.result.rounds.map(r => r.findings)).toEqual(m.rounds.map(r => r.findings));
      expect(out.result.enforcement).toBe(false);
    }
  });
  it('invalid_tail_cannot_hide_behind_recommendation', () => {
    const m = manifest([['B2'], ['B1'], ['B3']]); m.rounds[2].findings[0].class = 'unknown'; incomplete(diagnose(m));
  });
  it('malformed_location_or_class_is_incomplete', () => {
    for (const patch of [{file:'/abs'}, {file:'../escape'}, {file:'a/../b'}, {file:'./a'}, {file:'a//b'},
      {file:'a\u0000b'}, {line:0}, {line:1.5}, {line:Number.MAX_SAFE_INTEGER + 1}, {class:undefined}, {class:'B8'}]) {
      const m = seed(); Object.assign(m.rounds[0].findings[0], patch); incomplete(diagnose(m));
    }
  });
  it('unrelated_repository_ref_or_pr_is_rejected', () => {
    for (const [key, value] of [['repo','other/repo'], ['pr',2], ['ref','refs/heads/other']]) {
      const m = seed(); m.rounds[1][key] = value; incomplete(diagnose(m));
    }
  });
  it('sequence_gaps_reordering_and_same_head_retries_are_incomplete', () => {
    for (const change of [m => m.rounds[1].sequence = 3, m => m.rounds.reverse(),
      m => m.rounds[1].head = m.rounds[0].head, m => m.provenance.selection.reverse(),
      m => m.provenance.selection.pop(), m => m.provenance.selection[1].recordIndex = 1]) {
      const m = seed(); change(m); incomplete(diagnose(m));
    }
  });
  it('question_change_requires_new_episode', () => {
    const m = seed(); m.rounds[1].questionHash = 'b'.repeat(64); incomplete(diagnose(m));
    const fresh = manifest([['B2']]); fresh.questionHash = fresh.rounds[0].questionHash = 'b'.repeat(64);
    expect(streaks(fresh)).toEqual([1]);
  });
  it('historical_claims_require_pinned_selection', () => {
    for (const field of ['source', 'sourceSha256', 'selection', 'verifiedBy']) {
      const m = seed(); m.synthetic = false; delete m.provenance[field]; incomplete(diagnose(m));
    }
    const m = seed(); m.synthetic = false;
    expect(diagnose(m).result.evidenceBasis).toBe('operator-attested; not authenticated');
    expect(diagnose(seed()).result.synthetic).toBe(true);
  });
  it('legacy_and_unknown_evidence_fail_closed', () => {
    for (const m of [null, [], {head:'1'.repeat(40), findings:'prose'}, {...seed(), schemaVersion:2},
      {...seed(), completeFromStart:false}, {...seed(), repo:'Example/repo'}, {...seed(), pr:0},
      {...seed(), ref:'main'}, {...seed(), questionHash:'A'.repeat(64)}, {...seed(), synthetic:'true'}]) incomplete(diagnose(m));
    for (const edit of [m => m.rounds[0].base = 'x', m => m.rounds[0].head += '\n',
      m => m.provenance.selection[0].recordSha256 = '', m => m.provenance.verifiedBy = ' ',
      m => m.rounds[0].findings[0].text = '', m => m.rounds[0].findings.push({...m.rounds[0].findings[0]})]) {
      const m = seed(); edit(m); incomplete(diagnose(m));
    }
  });
  it('waiver_and_head_carry_are_outside_diagnostic', () => {
    for (const key of ['enforcement','waiver','hold','owner','resume','fingerprint']) {
      for (const select of [m => m, m => m.rounds[0], m => m.rounds[0].findings[0], m => m.provenance, m => m.provenance.selection[0]]) {
        const m = seed(); select(m)[key] = true; incomplete(diagnose(m));
      }
    }
  });
  it('empty_conflicting_and_unknown_cli_inputs_are_incomplete', async () => {
    for (const m of [{...seed(), rounds:[]}, manifest([[]])]) {
      if (m.rounds.length) m.rounds[0].verdict = 'WEAKENED'; incomplete(diagnose(m));
    }
    const m = seed(); m.rounds[0].verdict = 'NOT WEAKENED'; incomplete(diagnose(m));
    for (const args of [[], ['--help'], ['--manifest'], ['--manifest','a','--unknown'], ['--manifest','a','--manifest','b']]) {
      let output = ''; const code = await runCli(args, {stdout: new Writable({write(c,e,cb){output += c; cb();}})});
      incomplete({exitCode:code, result:JSON.parse(output)}, 'INVALID_ARGUMENTS');
    }
  });
  it('oversized_input_requires_human_review', () => {
    const many = manifest(Array.from({length:101}, () => ['B2'])); incomplete(diagnose(many), 'LIMIT_EXCEEDED');
    const m = seed(); m.rounds[0].findings = Array.from({length:101}, (_,i) => ({...m.rounds[0].findings[0], id:`f${i}`}));
    incomplete(diagnose(m), 'LIMIT_EXCEEDED');
    for (const value of ['x'.repeat(4097), 'é'.repeat(2049)]) {
      const m = seed(); m.rounds[0].findings[0].text = value; incomplete(diagnose(m), 'LIMIT_EXCEEDED');
    }
  });
  it.each([65536, 7777])('bounded_reader_never_exceeds_one_mib_plus_one_byte (%i chunks)', async chunk => {
    let returned = 0, reads = 0, closed = 0, output = '';
    const io = {openSync:() => 42, closeSync:fd => {expect(fd).toBe(42); closed++;},
      readFileSync:() => {throw Error('unbounded reader forbidden');},
      readSync(fd, buffer, offset, length) {
        expect(returned).toBeLessThan(1048577); expect(length).toBeLessThanOrEqual(1048577-returned);
        const n = Math.min(chunk, length); buffer.fill(32, offset, offset+n); returned += n; reads++; return n;
      }};
    const code = await runCli(['--manifest','virtual'], {io, stdout:new Writable({write(c,e,cb){output += c; cb();}})});
    incomplete({exitCode:code, result:JSON.parse(output)}, 'LIMIT_EXCEEDED');
    expect(returned).toBe(1048577); expect(reads).toBeGreaterThan(1); expect(closed).toBe(1);
  });
  it('bounded_reader_handles_short_reads_and_closes_on_failure', () => {
    const bytes = Buffer.from(JSON.stringify(seed())); let position = 0, closed = 0;
    const io = {openSync:()=>1, closeSync:()=>closed++, readSync(fd,b,o,n){
      const count = Math.min(17, n, bytes.length-position); bytes.copy(b,o,position,position+count); position += count; return count;
    }};
    expect(readManifest('virtual', io)).toEqual(seed()); expect(closed).toBe(1);
    io.readSync = () => {throw Error('read failure');}; expect(() => readManifest('virtual',io)).toThrow(); expect(closed).toBe(2);
  });
  it('injected_output_failure_is_incomplete', async () => {
    let stderr = '';
    const code = await runCli(['--manifest', join(fixtures, 'two-new-classes.json')], {
      stdout:new Writable({write(c,e,cb){cb(Object.assign(Error('bad\u001b[31m pipe'), {code:'EPIPE'}));}}),
      stderr:{write:s => {stderr += s;}}});
    expect(code).toBe(2); expect(stderr).toContain('OUTPUT_WRITE_FAILED'); expect(stderr).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});

describe('real CLI adapters', () => {
  it('real_cli_reads_manifest_and_emits_only_diagnostic', () => {
    const dir = temp();
    try {
      for (const name of ['two-new-classes','unchanged']) writeFileSync(join(dir, `${name}.json`), JSON.stringify(load(`${name}.json`)));
      const before = readdirSync(dir).map(n => [n,readFileSync(join(dir,n),'utf8')]);
      for (const [name,code] of [['two-new-classes',10],['unchanged',0]]) {
        const out = child(['--manifest',join(dir,`${name}.json`)],dir);
        expect(out.exitCode).toBe(code); expect(out.result).toEqual(load(`${name}.expected.json`)); expect(out.stderr).toBe('');
      }
      incomplete(child(['--manifest',join(dir,'unreadable.json')],dir), 'READ_FAILED');
      expect(readdirSync(dir).map(n => [n,readFileSync(join(dir,n),'utf8')])).toEqual(before);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('terminal_controls_and_shell_text_remain_data', () => {
    const dir = temp();
    try {
      const m = seed(); m.rounds[0].findings[0].text = '$(touch PWNED) `command` \u001b[31m\u009b payload';
      const input = JSON.stringify(m); writeFileSync(join(dir,'input.json'),input);
      const out = child(['--manifest',join(dir,'input.json')],dir);
      expect(out.result.rounds[0].findings[0].text).toBe(m.rounds[0].findings[0].text);
      expect(readdirSync(dir)).toEqual(['input.json']); expect(readFileSync(join(dir,'input.json'),'utf8')).toBe(input);
      const raw = spawnSync(process.execPath,[cli,'--manifest',join(dir,'input.json')],{encoding:'utf8',timeout:10000,maxBuffer:2**20});
      expect(raw.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('real_cli_malformed_and_oversized_bytes_fail_closed', () => {
    const dir = temp();
    try {
      for (const [text, reason] of [['{','INVALID_JSON'], ['{}\n{}','INVALID_JSON'], [' '.repeat(1048577),'LIMIT_EXCEEDED']]) {
        writeFileSync(join(dir,'input.json'), text); incomplete(child(['--manifest',join(dir,'input.json')],dir),reason);
      }
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('real_cli_output_failure_is_incomplete', async () => {
    const proc = spawn(process.execPath,[cli,'--manifest',join(fixtures,'two-new-classes.json')], {stdio:['ignore','pipe','pipe']});
    proc.stdout.destroy(); let stderr=''; proc.stderr.on('data',c => {stderr+=c;});
    const code = await new Promise((resolve,reject) => {proc.on('error',reject);proc.on('close',resolve);});
    expect(code).toBe(2); expect(stderr).toContain('OUTPUT_WRITE_FAILED');
  });
  it('diagnostic_has_no_production_consumers_and_no_mutating_adapters', () => {
    const root = process.env[SCAN_ROOT_ENV] || process.cwd();
    const walk = dir => readdirSync(join(root,dir),{withFileTypes:true}).flatMap(e =>
      e.name === '__tests__' || e.name === '__fixtures__' ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
    for (const file of scopedScanFiles(walk('scripts').filter(f => /\.(mjs|cjs|js|ts)$/.test(f)))) {
      const source = readFileSync(join(root,file),'utf8');
      if (file === 'scripts/operations/audit-nonconvergence.mjs') {
        expect(source).not.toMatch(/node:(?:child_process|https?|net)|\b(?:writeFile|appendFile|mkdir|unlink|rename|fetch)\s*\(/);
        expect(source).not.toMatch(/from ['"][^'"]*(?:ledger|ownership|card|gate|conveyor)[^'"]*['"]/);
      } else expect(source, file).not.toMatch(/(?:import|require\s*\()[^;\n]*['"][^'"]*audit-nonconvergence\.mjs['"]/);
    }
  });
});
