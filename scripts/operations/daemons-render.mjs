/**
 * @file scripts/operations/daemons-render.mjs
 * @description Pure validation, portable launchd XML rendering and installed-plist comparison.
 */
import { DAEMON_MANIFEST } from '../../skills-src/conveyor/daemon-manifest.mjs';

/** @typedef {{home: string, nodePath: string, path: string}} HostOverlay */
const TOP_KEYS = new Set(['version', 'description', 'tasks']);
const TASK_KEYS = new Set(['label', 'program', 'workingDir', 'runAtLoad', 'keepAlive', 'startInterval', 'throttleInterval', 'processType', 'stdout', 'stderr', 'env', 'hostEnvKeys', 'manifestPass']);
const SECRET = /KEY|TOKEN|SECRET|PRIVATE|APP_ID|INSTALLATION|URL|PASSWORD|AUTH/i;
const TOKENS = /\{([^{}\s]+)\}/g;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new TypeError(`daemons-render: ${message}`); };
const string = (value, name) => { if (typeof value !== 'string' || !value.length) fail(`${name} must be a nonempty string`); };

function checkStrings(value) {
  if (typeof value === 'string') {
    if (/\/(?:Users|home)\//.test(value)) fail('literal user home path; use {home}');
    if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) fail('invalid XML character');
    for (const [, token] of value.matchAll(TOKENS)) if (!['home', 'node'].includes(token)) fail(`unknown token {${token}}`);
  } else if (Array.isArray(value)) value.forEach(checkStrings);
  else if (object(value)) for (const [key, child] of Object.entries(value)) { checkStrings(key); checkStrings(child); }
}

/** Throws on unknown fields, invalid evidence, nonportable literals or unsafe literal env keys. */
export function validateTable(table) {
  if (!object(table)) fail('table must be an object');
  for (const key of Object.keys(table)) if (!TOP_KEYS.has(key)) fail(`unknown table key ${key}`);
  if (table.version !== 1) fail('version must be 1');
  if (table.description !== undefined) string(table.description, 'description');
  if (!Array.isArray(table.tasks)) fail('tasks must be an array');
  checkStrings(table);
  const labels = new Set();
  for (const task of table.tasks) {
    if (!object(task)) fail('task must be an object');
    for (const key of Object.keys(task)) if (!TASK_KEYS.has(key)) fail(`unknown task key ${key}`);
    string(task.label, 'label');
    if (labels.has(task.label)) fail(`duplicate label ${task.label}`);
    labels.add(task.label);
    if (!Array.isArray(task.program) || !task.program.length || task.program.some(arg => typeof arg !== 'string')) fail('program must be a nonempty string array');
    string(task.program[0], 'program executable');
    for (const key of ['workingDir', 'processType', 'stdout', 'stderr', 'manifestPass']) if (task[key] !== undefined) string(task[key], key);
    for (const key of ['runAtLoad', 'keepAlive']) if (task[key] !== undefined && typeof task[key] !== 'boolean') fail(`${key} must be boolean`);
    for (const key of ['startInterval', 'throttleInterval']) if (task[key] !== undefined && (!Number.isSafeInteger(task[key]) || task[key] < (key === 'startInterval' ? 1 : 0))) fail(`${key} must be a valid integer interval`);
    if (task.env !== undefined && !object(task.env)) fail('env must be an object');
    for (const [key, value] of Object.entries(task.env ?? {})) {
      if (SECRET.test(key)) fail(`secret-like env key ${key}; use hostEnvKeys`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') fail('env requires names and string literals');
    }
    if (task.hostEnvKeys !== undefined && (!Array.isArray(task.hostEnvKeys) || task.hostEnvKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || new Set(task.hostEnvKeys).size !== task.hostEnvKeys.length)) fail('hostEnvKeys must be unique environment names');
    if ((task.hostEnvKeys ?? []).some(key => Object.hasOwn(task.env ?? {}, key) || key === 'PATH')) fail('hostEnvKeys overlaps rendered environment');
    const passes = task.program.filter(arg => arg.startsWith('--pass=')).map(arg => arg.slice(7));
    if (passes.length && (passes.length !== 1 || !Object.hasOwn(DAEMON_MANIFEST, task.manifestPass) || task.manifestPass !== passes[0])) fail('manifestPass must match --pass= and be a DAEMON_MANIFEST key');
  }
  return table;
}

const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n';

function xmlValue(value, depth = 0) {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) return `${indent}<array>\n${value.map(item => xmlValue(item, depth + 1)).join('')}${indent}</array>\n`;
  if (object(value)) return `${indent}<dict>\n${Object.entries(value).map(([key, child]) => `${indent}  <key>${escapeXml(key)}</key>\n${xmlValue(child, depth + 1)}`).join('')}${indent}</dict>\n`;
  if (typeof value === 'boolean') return `${indent}<${value}/>\n`;
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>\n`;
  return `${indent}<string>${escapeXml(value)}</string>\n`;
}

/** Render with explicit host inputs only. No ambient environment is copied. */
export function renderPlist(task, host) {
  validateTable({ version: 1, tasks: [task] });
  for (const key of ['home', 'nodePath', 'path']) string(host?.[key], `host.${key}`);
  const expand = value => value.replace(TOKENS, (_match, token) => token === 'home' ? host.home : host.nodePath);
  const plist = { Label: expand(task.label), ProgramArguments: task.program.map(expand) };
  for (const [source, target] of [['workingDir', 'WorkingDirectory'], ['runAtLoad', 'RunAtLoad'], ['keepAlive', 'KeepAlive'], ['startInterval', 'StartInterval'], ['throttleInterval', 'ThrottleInterval'], ['processType', 'ProcessType'], ['stdout', 'StandardOutPath'], ['stderr', 'StandardErrorPath']]) {
    if (task[source] !== undefined) plist[target] = typeof task[source] === 'string' ? expand(task[source]) : task[source];
  }
  plist.EnvironmentVariables = Object.fromEntries(Object.entries({ ...task.env, PATH: host.path }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, key === 'PATH' ? value : expand(value)]));
  return HEADER + xmlValue(plist) + '</plist>\n';
}

/** Pending host environment names are metadata, never plist values. */
export function renderAll(table, host) {
  validateTable(table);
  return table.tasks.map(task => ({ label: task.label, file: `${task.label}.plist`, xml: renderPlist(task, host), pendingHostEnv: [...(task.hostEnvKeys ?? [])].sort() }));
}

// Parse only the deterministic plist subset this module emits. Never resolve XML entities/DTDs.
function parseRendered(xml) {
  if (typeof xml !== 'string' || !xml.startsWith(HEADER)) fail('invalid rendered XML header');
  const source = xml.slice(HEADER.length);
  let cursor = 0;
  const consume = literal => { if (!source.startsWith(literal, cursor)) fail('invalid rendered XML'); cursor += literal.length; };
  const whitespace = () => { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; };
  const text = tag => {
    consume(`<${tag}>`);
    const end = source.indexOf(`</${tag}>`, cursor);
    if (end < 0) fail('invalid rendered XML text');
    const raw = source.slice(cursor, end);
    if (raw.includes('<') || /&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) fail('invalid XML entity');
    cursor = end; consume(`</${tag}>`);
    return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_m, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
  };
  const value = () => {
    whitespace();
    if (source.startsWith('<dict>', cursor)) {
      consume('<dict>'); const pairs = []; const keys = new Set(); whitespace();
      while (!source.startsWith('</dict>', cursor)) {
        const key = text('key');
        if (keys.has(key)) fail('duplicate XML key');
        keys.add(key); pairs.push([key, value()]); whitespace();
      }
      consume('</dict>'); return Object.fromEntries(pairs);
    }
    if (source.startsWith('<array>', cursor)) {
      consume('<array>'); const items = []; whitespace();
      while (!source.startsWith('</array>', cursor)) { items.push(value()); whitespace(); }
      consume('</array>'); return items;
    }
    for (const bool of [true, false]) if (source.startsWith(`<${bool}/>`, cursor)) { consume(`<${bool}/>`); return bool; }
    if (source.startsWith('<integer>', cursor)) { const raw = text('integer'); if (!/^\d+$/.test(raw)) fail('invalid XML integer'); return Number(raw); }
    return text('string');
  };
  const result = value(); whitespace(); consume('</plist>'); whitespace();
  if (cursor !== source.length || !object(result)) fail('invalid rendered XML root');
  return result;
}

/** Sorted differing key paths; arrays differ at their owning key. Missing evidence throws. */
export function diffPlists(renderedXml, installedJson) {
  const rendered = parseRendered(renderedXml);
  if (!object(installedJson)) fail('installed plist must be a JSON object');
  const differing = [];
  const compare = (a, b, prefix) => {
    if (object(a) && object(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) compare(a[key], b[key], prefix ? `${prefix}.${key}` : key);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) differing.push(prefix);
  };
  compare(rendered, installedJson, '');
  return differing;
}
