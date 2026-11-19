/** Only this shell reads settings/cards/PRs and writes the local preparation store. */
import { readFileSync, writeFileSync, mkdirSync, renameSync, linkSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { PREP_DEFAULTS, resolvePrepSettings } from '../lib/prep-settings.mjs';
import { buildRecord, recordFromCard } from '../lib/prep-record.mjs';
import { PREP_STORE_EFFECT } from './prep.mjs';

export function loadPrepSettings({ env = process.env, readFile = readFileSync, platform, log = console.error } = {}) {
  let tool;
  const errors = [];
  try { tool = JSON.parse(readFile(new URL('../settings/prep-flow.json', import.meta.url), 'utf8')); }
  catch { errors.push('Prep settings unreadable; restore settings or request design review.'); }
  if (platform === undefined) {
    const result = readPlatformPreferences({ env, readFile, warn: log });
    platform = result.prefs.prepFlow ?? {};
    errors.push(...result.errors);
  }
  const resolved = cascadePolicy('prepFlow', tool, { standard: PREP_DEFAULTS, platform,
    envValues: env.WE_PREP_STORE_DIR ? { storeDir: env.WE_PREP_STORE_DIR } : {}, env, operatorOverride: null, log });
  const checked = resolvePrepSettings(errors.length ? null : resolved.value);
  // A malformed tool document cannot disappear into lower-layer defaults.
  const toolCheck = resolvePrepSettings(tool);
  const selected = toolCheck.errors.length ? toolCheck : checked;
  const provenance = errors.length || selected.errors.length ? { '*': 'strict-fallback' } : resolved.sources;
  log(`prep-flow: ${JSON.stringify({ sources: provenance, value: selected.config })}`);
  return { ...selected, errors: [...errors, ...selected.errors], provenance };
}

export function createPrepStore({ storeDir = PREP_DEFAULTS.storeDir, env = process.env } = {}) {
  const configured = env.WE_PREP_STORE_DIR || storeDir;
  const root = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured);
  const pathFor = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid prep id: use 1–128 letters, digits, underscores or hyphens');
    return join(root, `${id}.json`);
  };
  function persist(record, createOnly) {
    const target = pathFor(record.id);
    mkdirSync(root, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      // Publish a complete file without replacing an existing destination. Both names
      // are on the same filesystem; link is atomic and refuses an existing target.
      if (createOnly) linkSync(temporary, target);
      else renameSync(temporary, target);
    } catch (error) {
      if (createOnly && error.code === 'EEXIST') throw Object.assign(new Error('Prep record already exists; use amend', { cause: error }), { code: 'EEXIST' });
      throw error;
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { id: record.id, stored: true };
  }
  return {
    read(id) {
      const record = JSON.parse(readFileSync(pathFor(id), 'utf8'));
      if (record?.id !== id) throw new Error('Prep store identity mismatch; inspect the record before retrying');
      return record;
    },
    create: record => persist(record, true),
    write: record => persist(record, false),
    list: () => existsSync(root) ? readdirSync(root).filter(p => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(p)).map(p => p.slice(0, -5)).sort() : [],
  };
}

/** PR reader is injectable: fixtures never execute git or gh. No writes to GitHub. */
export function createPrepIO({ env = process.env, cwd = process.cwd(), settings = loadPrepSettings({ env }),
  store = createPrepStore({ storeDir: settings.config.storeDir, env }), readPR = number => JSON.parse(runGhSync(
    ['pr', 'view', number, '--repo', ghRepoSlug(DEFAULT_REPO_KEY), '--json', 'body,files,baseRefOid'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })) } = {}) {
  return {
    readContext(input) {
      try {
        let record;
        if (input.action !== 'new') record = store.read(input.id);
        else if (input.card) {
          const cardPath = /^\d+$/.test(input.card)
            ? join('backlog', readdirSync(join(cwd, 'backlog')).find(p => p.startsWith(`${input.card}-`)) ?? '__missing__') : input.card;
          record = recordFromCard({ text: readFileSync(resolve(cwd, cardPath), 'utf8'), cardPath,
            id: input.id || `card-${input.card.match(/^\d+$/)?.[0] || cardPath.split('/').pop().replace(/\.md$/, '')}`,
            baseSha: input.baseSha });
        } else if (input.pr) {
          if (!/^\d+$/.test(input.pr)) throw new Error('PR must be a positive number');
          const pr = readPR(input.pr);
          const fields = {};
          let current;
          let active = false;
          for (const line of pr.body.split(/\r?\n/)) {
            const clean = line.trim().replace(/^#+\s*|\*\*/g, '');
            if (/^PREP:?$/i.test(clean)) { active = true; current = undefined; continue; }
            if (!active) continue;
            const heading = clean.match(/^(Acceptance|Pre-mortem|Tests|Files):\s*(.*)$/i);
            if (heading) {
              current = { acceptance: 'acceptance', 'pre-mortem': 'preMortem', tests: 'testPlan' }[heading[1].toLowerCase()];
              if (current) fields[current] = heading[2];
            } else if (/^##?\s/.test(line)) { active = false; current = undefined; }
            else if (current) fields[current] += `\n${line}`;
          }
          record = buildRecord({ ...fields, id: input.id || `pr-${input.pr}`, source: `pull-request:${input.pr}`, kind: 'pr',
            baseSha: pr.baseRefOid, touchSet: pr.files.map(file => file.path) });
        } else {
          let brief = {};
          if (input.brief) {
            const body = readFileSync(resolve(cwd, input.brief), 'utf8');
            brief = body.trimStart().startsWith('{') ? JSON.parse(body)
              : { ...recordFromCard({ text: body }), brief: body };
          }
          const flags = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== '' && v !== undefined));
          record = buildRecord({ ...brief, ...flags, source: input.source || (input.brief ? `brief:${input.brief}` : brief.source),
            touchSet: input.touchSet ? input.touchSet.split(',').map(p => p.trim()) : brief.touchSet });
        }
        if (input.action === 'new') { try { store.read(record.id); throw new Error('Prep record already exists; use amend'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
        return { record, ...settings };
      } catch (error) { return { ...settings, errors: [...settings.errors, String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')] }; }
    },
    sinks: { [PREP_STORE_EFFECT]: payload => {
      // Old persisted effects carried the record alone. They may create but never
      // replace a record; replacement requires an explicit amend effect.
      if (!Object.hasOwn(payload, 'record')) return store.create(payload);
      if (payload.action === 'new') return store.create(payload.record);
      if (payload.action === 'amend') return store.write(payload.record);
      throw new Error('Unknown prep store action; inspect the request and retry new or amend');
    } },
  };
}
