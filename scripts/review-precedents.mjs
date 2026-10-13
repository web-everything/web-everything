#!/usr/bin/env node
/** Operator precedent library CLI. Writes preview until --apply is supplied. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadPrecedentSettings, readPrecedents, appendPrecedentEvents, readPrInfo,
  capturePrecedents, draftPatternWithModel, recordCitationsFromComments,
} from './lib/review-precedents-io.mjs';
import {
  precedentEvent, statusEvent, withPrecedents, matchPrecedents,
  precedentAgreement, formatPrecedentSettings,
} from './lib/review-precedents.mjs';
import { createReviewPrReader } from './operations/review-pr-io.mjs';
import { shapeReadFinding, buildReviewJudgeRequest } from './operations/review-pr.mjs';

const board = fileURLToPath(new URL('../', import.meta.url));
const seeds = () => JSON.parse(readFileSync(new URL('./review-precedents.seeds.json', import.meta.url), 'utf8')).precedents;
const help = `Usage: node scripts/review-precedents.mjs <command> [flags]
  list [--status=active|draft|superseded|all]
  seed [--apply]
  capture --pr=N [--apply] [--no-model]
  promote --id=ID --actor=LOGIN [--note=TEXT] [--apply]
  supersede --id=OLD --by=NEW --actor=LOGIN [--apply]
  preview --pr=N [--lens=correctness] [--include-seeds]
  record-citations --pr=N [--apply]
  report
  help
Common: --repo=OWNER/REPO (default web-everything/web-everything), --json
Every write previews by default; --apply appends to ops/review-requests.`;

function flagsOf(args) {
  const flags = {};
  const booleans = new Set(['apply', 'json', 'no-model', 'include-seeds']);
  const values = new Set(['repo', 'status', 'pr', 'id', 'actor', 'note', 'by', 'lens']);
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(args[index]);
    if (!match) throw new Error(`unexpected argument: ${args[index]}`);
    const [, key, inline] = match;
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate flag: --${key}`);
    if (booleans.has(key)) {
      if (inline !== undefined) throw new Error(`--${key} takes no value`);
      flags[key] = true;
    } else if (values.has(key)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      flags[key] = value;
    } else throw new Error(`unknown flag: --${key}`);
  }
  return flags;
}

async function main() {
  const settings = loadPrecedentSettings();
  const [command = 'help', ...args] = process.argv.slice(2);
  const flags = flagsOf(args);
  const allowed = {
    list: ['status'], seed: ['apply'], capture: ['pr', 'apply', 'no-model'],
    promote: ['id', 'actor', 'note', 'apply'], supersede: ['id', 'by', 'actor', 'apply'],
    preview: ['pr', 'lens', 'include-seeds'], 'record-citations': ['pr', 'apply'], report: [], help: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`unknown command: ${command}`);
  for (const key of Object.keys(flags)) if (!['repo', 'json', ...allowed[command]].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  const repo = flags.repo ?? 'web-everything/web-everything';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('invalid --repo; use OWNER/REPO');
  const print = (value, lines) => console.log(flags.json ? JSON.stringify(value, null, 2) : lines.join('\n'));
  const required = key => {
    if (!flags[key]?.trim()) throw new Error(`--${key} is required`);
    return flags[key];
  };
  const prNumber = () => {
    const value = required('pr');
    const pr = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(pr) || pr < 1) throw new Error('--pr must be a positive integer');
    return pr;
  };
  const readLibrary = () => {
    const result = readPrecedents({ board, repo });
    if (result.status !== 'ok') {
      const error = new Error(`precedent transport unreadable: ${result.error}`);
      error.exitCode = 2;
      throw error;
    }
    if (result.malformed) console.error(`warning: ${result.malformed} malformed precedent log lines`);
    return result;
  };
  const write = events => flags.apply && events.length ? appendPrecedentEvents({ board, repo, events }) : null;
  const mode = flags.apply ? 'Applied' : 'Preview (use --apply to write)';
  const at = new Date().toISOString();
  if (command === 'help') { print({ help }, [help]); return; }
  if (command === 'list') {
    const status = flags.status ?? 'all';
    if (!['active', 'draft', 'superseded', 'all'].includes(status)) throw new Error('invalid --status');
    const { precedents } = readLibrary();
    const records = [...precedents.values()].filter(record => status === 'all' || record.status === status);
    print(records, records.length ? records.map(record => `${record.id} · ${record.status} · ${record.decision} · ${record.pattern}`) : ['No precedents.']);
  } else if (command === 'seed') {
    const { precedents } = readLibrary();
    const records = seeds().filter(record => !precedents.has(record.id));
    const events = records.map(record => precedentEvent(record, { at }));
    const appended = write(events);
    print({ mode: flags.apply ? 'apply' : 'preview', precedents: records, appended }, [`${mode}: ${records.length} new seeds`, ...records.map(record => `${record.id} · ${record.pattern}`)]);
  } else if (command === 'capture') {
    const pr = prNumber();
    const info = readPrInfo({ repo, pr });
    const { precedents } = readLibrary();
    const result = await capturePrecedents({ repo, pr, info, existing: precedents,
      draft: flags['no-model'] ? async () => null : draftPatternWithModel, now: at });
    const appended = write(result.drafts.map(record => precedentEvent(record, { at })));
    print({ ...result, appended, mode: flags.apply ? 'apply' : 'preview' }, [
      `${mode}: ${result.drafts.length} drafts, ${result.skipped.length} skipped, ${result.invalid.length} invalid`,
      ...result.drafts.map(record => `${record.id} · draft · ${record.decision} · ${record.pattern}`),
      ...result.invalid.map(record => `invalid ${record.id}: ${record.errors.join(', ')}`),
    ]);
  } else if (command === 'promote' || command === 'supersede') {
    const id = required('id'), actor = required('actor');
    const by = command === 'supersede' ? required('by') : null;
    const { precedents } = readLibrary();
    const record = precedents.get(id);
    if (!record) throw new Error(`unknown precedent: ${id}`);
    if (command === 'promote' && record.status !== 'draft') throw new Error(`${id} must be draft to promote`);
    if (command === 'supersede') {
      if (by === id) throw new Error('a precedent cannot supersede itself');
      if (precedents.get(by)?.status !== 'active') throw new Error(`${by} must exist and be active`);
    }
    const event = statusEvent({ id, actor, at, status: command === 'promote' ? 'active' : 'superseded', supersededBy: by, note: flags.note ?? '' });
    const appended = write([event]);
    print({ mode: flags.apply ? 'apply' : 'preview', event, appended }, [`${mode}: ${id} -> ${event.status}${by ? ` by ${by}` : ''} (actor ${actor})`]);
  } else if (command === 'preview') {
    const pr = prNumber(), lens = flags.lens ?? 'correctness';
    const raw = await createReviewPrReader()({ pr, repo });
    // A preview never judges or records anything, so the clearer-independence refusal (which stops a PR's author
    // from paying for a verdict it could never record) does not apply: the reader runs as an unknown clearer.
    const read = shapeReadFinding({ ...raw, clearerId: null }, { pr, repo });
    const request = buildReviewJudgeRequest({ read, lens });
    const { precedents } = readLibrary();
    if (flags['include-seeds']) for (const record of seeds()) if (!precedents.has(record.id)) precedents.set(record.id, { ...record, status: 'active' });
    const text = [read.title, read.body, read.diffText].join('\n');
    const matches = matchPrecedents(precedents, { files: read.netChangedFiles, text, lens: request.lens });
    const result = withPrecedents(request, { precedents, files: read.netChangedFiles, text, settings });
    const injected = matches.filter(match => result.injected.ids.includes(match.precedent.id)).map(match => ({ id: match.precedent.id, why: match.why }));
    const block = result.request.input.slice(request.input.length).replace(/^\n\n/, '');
    const output = { pr, repo, lens, netFiles: read.netChangedFiles.length, settings: formatPrecedentSettings(settings), injected, dropped: result.injected.dropped, block,
      inputChars: { before: request.input.length, after: result.request.input.length } };
    print(output, [`PR #${pr} · ${repo} · lens ${lens}`, `net files: ${output.netFiles}`, output.settings,
      ...injected.map(item => `injected ${item.id}: ${item.why.join(', ')}`),
      `dropped: ${output.dropped.join(', ') || '(none)'}`, block || '(no injected block)',
      `input chars ${output.inputChars.before} -> ${output.inputChars.after}`]);
  } else if (command === 'record-citations') {
    const pr = prNumber();
    const info = readPrInfo({ repo, pr });
    readLibrary(); // Refuse unknown transport state even for a backfill preview.
    const events = recordCitationsFromComments({ repo, pr, info, at });
    const appended = write(events);
    print({ mode: flags.apply ? 'apply' : 'preview', events, appended }, [`${mode}: ${events.length} citation events`, ...events.map(event => `${event.id} · ${event.verdict} · ${event.ids.join(', ')}`)]);
  } else if (command === 'report') {
    const { precedents, citations } = readLibrary();
    const decisions = [...precedents.values()].map(record => ({ repo: record.source.repo, pr: record.source.pr, head: record.source.head, decision: record.decision }));
    const agreement = precedentAgreement({ precedents, citations, decisions });
    const autoDecide = `autoDecide=${settings.autoDecide} (${settings.sources.autoDecide})`;
    const humanSurfaces = 'autoDecide never applies to human-only surfaces (scripts/settings/human-review-surfaces.json)';
    print({ ...agreement, autoDecide, humanSurfaces }, [
      ...[...precedents.keys()].map(id => `${id}: agree=${agreement.byPrecedent[id]?.agree ?? 0} disagree=${agreement.byPrecedent[id]?.disagree ?? 0}`),
      ...Object.entries(agreement.byDecision).map(([decision, counts]) => `${decision}: agree=${counts.agree} disagree=${counts.disagree}`),
      `pairs=${agreement.pairs}`, autoDecide, humanSurfaces,
    ]);
  }
}

main().catch(error => {
  console.error(`review-precedents: ${error.message ?? error}`);
  process.exitCode = error.exitCode ?? 1;
});
