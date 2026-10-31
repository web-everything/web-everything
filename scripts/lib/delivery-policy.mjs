/** Delivery-flow policy: human-gated values, base-ref isolation, and a best-effort event journal. */
import { build } from 'esbuild';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { defaultLogsDir } from '../conveyor/health-watch.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { isPolicySpecPath, readPolicySpecRegistryAt } from './gate-config.mjs';

export const POLICY_EVENT_REASON_MAX = 200;
export const DELIVERY_POLICY_FAILSAFE = Object.freeze({
  prCi: Object.freeze({ mainStateParity: 'on' }),
  mergeGate: Object.freeze({ recheckWhenMainMoved: 'always', recheckMaxAgeMin: 30, onMainRed: 'halt' }),
  dispatchGate: Object.freeze({ overlapOverride: 'off' }),
  heavyQueue: Object.freeze({ priority: 'repairs-first', reservedForRepairs: 1, reservedBorrowAfterMin: 10 }),
  drain: Object.freeze({ onStepRefusal: 'alert' }),
});
const DEFAULTS_FILE = 'config/deliveryPolicyDefaults.ts';
const ROOT_FILE = 'webeverything.config.json';
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_JOURNAL_RECORD_BYTES = 4096;
const JOURNAL_LOCK_STALE_MS = 30000;
const JOURNAL_LOCK_ATTEMPTS = 10;
const JOURNAL_LOCK_WAIT_MS = 1000;
const domains = {
  prCi: { mainStateParity: ['on', 'off'] },
  mergeGate: { recheckWhenMainMoved: ['if-older-than-N-min', 'always', 'off'], recheckMaxAgeMin: 1, onMainRed: ['halt', 'warn', 'off'] },
  dispatchGate: { overlapOverride: ['off', 'logged', 'free'] },
  heavyQueue: { priority: ['repairs-first', 'fifo'], reservedForRepairs: 0, reservedBorrowAfterMin: 1 },
  drain: { onStepRefusal: ['alert', 'log'] },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = (value, domain) => Array.isArray(domain) ? domain.includes(value) : Number.isSafeInteger(value) && value >= domain;
const clone = value => structuredClone(value);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };

export function assertStoredEntryName(dir, name, readdir = d => readdirSync(d, { withFileTypes: true })) {
  const entries = readdir(dir);
  const exact = entries.find(entry => entry.name === name);
  if (exact && !exact.isSymbolicLink()) return;
  if (exact || entries.some(entry => ['NFC', 'NFD'].some(form => entry.name.normalize(form).toLowerCase() === name.normalize(form).toLowerCase()))) {
    throw Object.assign(Error(`Policy path identity refused: ${name}`), { code: 'POLICY_PATH_IDENTITY' });
  }
  throw Object.assign(Error(`Policy entry not found: ${name}`), { code: 'ENOENT' });
}

/**
 * One trust boundary for worktree policy sources and the journal. Only the canonical
 * allowed base may contain symlinks; every component below it is checked with lstat.
 * create permits missing journal directories/leaf; beforeRead is a race-test hook.
 */
export function resolveTrustedConfigPath(p, { root = process.cwd(), allowedRoots = [root], create = false, beforeRead } = {}) {
  const requested = resolve(root, p);
  const refused = (message, code) => Object.assign(Error(message), { code });
  const symlink = () => refused(`Policy symlink refused: ${p}`, 'POLICY_SYMLINK');
  const changed = () => Error(`Policy source changed during access: ${p}`);
  const unreadable = () => Error(`Unreadable or oversized policy source: ${p}`);
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  let base, anchor, real;
  for (const allowed of allowedRoots) {
    const lexical = resolve(root, allowed);
    // Missing journal bases are anchored at their nearest existing, canonical parent.
    let existing = lexical;
    for (;;) {
      try { anchor = realpathSync(existing); break; } catch (error) {
        if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error;
        existing = dirname(existing);
      }
    }
    const canonical = resolve(anchor, relative(existing, lexical));
    if (inside(lexical, requested)) real = resolve(canonical, relative(lexical, requested));
    else if (inside(canonical, requested)) real = requested;
    else continue;
    base = canonical;
    break;
  }
  if (!base || !inside(base, real)) throw refused(`Outside root: ${p}`, 'POLICY_OUTSIDE_ROOT');

  const directories = [];
  let current = anchor;
  let sourceStat;
  const parts = relative(anchor, real).split(sep).filter(Boolean);
  // Include the base in the snapshot so replacing it after resolution is refused too.
  for (let i = 0; i <= parts.length; i++) {
    const leaf = i === parts.length;
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      if (!leaf) {
        mkdirSync(current);
        stat = lstatSync(current);
      }
    }
    if (stat?.isSymbolicLink()) throw symlink();
    if (leaf) {
      if (stat && (!stat.isFile() || stat.size > MAX_SOURCE_BYTES)) throw unreadable();
      sourceStat = stat;
      break;
    }
    if (!stat.isDirectory()) throw unreadable();
    directories.push({ path: current, stat });
    current = join(current, parts[i]);
  }

  function checkDirectories() {
    for (const directory of directories) {
      const now = lstatSync(directory.path);
      if (now.isSymbolicLink()) throw symlink();
      if (!now.isDirectory() || !same(directory.stat, now)) throw changed();
    }
  }
  function access(append, data) {
    beforeRead?.();
    if (!append && !sourceStat) throw changed();
    // Check before creation as well, so a known parent swap cannot create a leaf there.
    checkDirectories();
    let fd;
    try {
      const flags = (append ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDONLY)
        | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
        | (append && !sourceStat ? constants.O_CREAT | constants.O_EXCL : 0);
      fd = openSync(real, flags, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw unreadable();
      if (sourceStat && !same(sourceStat, stat)) throw changed();
      // A parent swap can redirect open even with O_NOFOLLOW. Verify the captured
      // directory inodes before using the fd, never reopen a validated pathname.
      checkDirectories();
      const leaf = lstatSync(real);
      if (leaf.isSymbolicLink()) throw symlink();
      if (!same(leaf, stat)) throw changed();
      if (append) {
        if (stat.size + Buffer.byteLength(data) > MAX_SOURCE_BYTES) throw unreadable();
        writeFileSync(fd, data);
        sourceStat = fstatSync(fd);
        return;
      }
      // Bound allocation and IO even if another writer grows the inode after fstat.
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
      let bytes = 0, count;
      while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes))) bytes += count;
      if (bytes > MAX_SOURCE_BYTES) throw unreadable();
      return buffer.toString('utf8', 0, bytes);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { real, version: sourceStat?.mtimeMs,
    read: () => access(false), append: data => {
      if (!create) throw Error('Policy source is read-only');
      return access(true, data);
    } };
}

const clean = (value, max) => {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
function identityText(value, max, byteLimit) {
  let text = clean(value, max);
  // JSON escapes lone surrogates and quotes: character limits alone do not bound wire bytes.
  while (Buffer.byteLength(JSON.stringify(text)) > byteLimit) text = text.slice(0, -2) + '…';
  return text;
}
function sanitise(value, depth = 0, state = { remaining: 256, seen: new Set() }) {
  // Bound traversal before the wire-size check, even for trees without shared references.
  if (state.remaining-- <= 0) return null;
  if (typeof value === 'string') return clean(value, 500);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 8 || typeof value !== 'object' || state.seen.has(value)) return null;
  // Keep references for the entire traversal: aliases, like cycles, become null.
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < Math.min(value.length, 20) && state.remaining > 0; i++) {
      result.push(sanitise(value[i], depth + 1, state));
    }
    return result;
  }
  const entries = [];
  for (const key of Object.keys(value).slice(0, 100)) {
    if (state.remaining <= 0) break;
    entries.push([clean(key, 500), sanitise(value[key], depth + 1, state)]);
  }
  return Object.fromEntries(entries);
}

export function policyEventsPath(env = process.env) {
  try { return env.WE_POLICY_EVENTS_FILE || join(defaultLogsDir(env), 'policy-events.jsonl'); } catch { return undefined; }
}

// Keep the R88 resolver unchanged. Journal descriptors use its confinement rules,
// then retain directory identities across exclusive creation/open and unlink.
function journalTarget(path, options) {
  let trusted;
  // Another journal writer may create a missing parent during the resolver's
  // mkdir. Retry that specific race; every attempt repeats the full trust check.
  for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt++) {
    try { trusted = resolveTrustedConfigPath(path, { ...options, create: true }); break; } catch (error) {
      if (error.code !== 'EEXIST' || attempt + 1 === JOURNAL_LOCK_ATTEMPTS) throw error;
    }
  }
  const { real } = trusted;
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  const changed = () => Error('Policy journal path changed during access');
  const directories = [];
  for (let parent = dirname(real);; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    directories.push({ path: parent, stat });
    if (dirname(parent) === parent) break;
  }
  function check(expected) {
    for (const directory of directories) {
      const stat = lstatSync(directory.path);
      if (!stat.isDirectory() || !same(stat, directory.stat)) throw changed();
    }
    let stat;
    try { stat = lstatSync(real); } catch (error) {
      if (error.code !== 'ENOENT' || expected) throw error;
      return undefined;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
    if (expected && !same(stat, expected)) throw changed();
    return stat;
  }
  function unlinkExpected(expected, canRemove = () => true) {
    const current = check();
    if (!current || !same(current, expected)) return;
    if (!canRemove(current)) return;
    try { unlinkSync(real); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    check,
    readOwner(expected) {
      check(expected);
      const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || !same(stat, expected)) throw changed();
        // Bound reads even if a lock is replaced or grows during access.
        const buffer = Buffer.alloc(MAX_JOURNAL_RECORD_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const bytes = readSync(fd, buffer, length, buffer.length - length, length);
          if (!bytes) break;
          length += bytes;
        }
        check(stat);
        if (length > MAX_JOURNAL_RECORD_BYTES) throw Error('Oversized policy journal lock; event not recorded. Verify no writer is active before removing the lock.');
        let owner;
        try { owner = JSON.parse(buffer.toString('utf8', 0, length)); } catch { return null; }
        return object(owner) && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
      } finally { closeSync(fd); }
    },
    // Only the exclusive owner removes a generation guard. These guards are
    // NEVER reclaimed by age: doing so would recreate the check/unlink race.
    removeOwnedGuard: unlinkExpected,
    remove(expected, canRemove) {
      const guardPath = `${real}.${expected.dev}-${expected.ino}-${expected.birthtimeMs}.reclaim`;
      const guard = journalTarget(guardPath, options);
      let held;
      for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt++) {
        try {
          held = guard.open(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (attempt + 1 < JOURNAL_LOCK_ATTEMPTS) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * (attempt + 1), 80));
          }
        }
      }
      if (!held) throw Object.assign(Error(`Policy journal reclamation guard busy: ${guardPath}; event may not be recorded. If abandoned, verify no writer is active, then remove this guard.`), {
        code: 'POLICY_JOURNAL_RECLAIM_BUSY',
      });
      try {
        // Both normal release and stale reclamation take this generation's
        // guard. A second remover cannot validate/unlink until the first has
        // finished, and must then revalidate against any replacement owner.
        unlinkExpected(expected, canRemove);
      } finally {
        try { guard.removeOwnedGuard(held.stat); } finally { closeSync(held.fd); }
      }
    },
    open(flags) {
      const before = check();
      const fd = openSync(real, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (!before ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
      try {
        const stat = fstatSync(fd);
        // O_EXCL success proves this is our new lock, even if the previous
        // holder released between check() and openSync().
        if (!stat.isFile() || (!(flags & constants.O_EXCL) && before && !same(before, stat))) throw changed();
        check(stat);
        return { fd, stat };
      } catch (error) { closeSync(fd); throw error; }
    },
  };
}

/** Synchronous, bounded best-effort append; recordPolicyEvent absorbs any refusal. */
export function appendPolicyJournal(path, record, options = {}) {
  const data = Buffer.from(record);
  if (data.length > MAX_JOURNAL_RECORD_BYTES) throw Error('Oversized policy journal record; event not recorded');
  const lock = journalTarget(`${path}.lock`, options);
  const token = randomUUID();
  const reclaimable = stat => {
    if (Date.now() - stat.mtimeMs <= JOURNAL_LOCK_STALE_MS) return false;
    const owner = lock.readOwner(stat);
    if (!owner) return true;
    try { process.kill(owner.pid, 0); } catch (error) { return error.code === 'ESRCH'; }
    return false;
  };
  let held;
  // A time budget, not an attempt count: a live holder on a loaded host (CI shards run
  // at load 40+) can keep the lock well past ten short sleeps, and a refused append is
  // a silently lost event. The budget stays far below the 30s stale age.
  // Monotonic time keeps wall-clock corrections from changing the wait budget.
  const deadline = performance.now() + JOURNAL_LOCK_WAIT_MS;
  // Every retry spends the budget, including stale reclamation without a sleep.
  for (let attempt = 0; attempt === 0 || performance.now() < deadline; attempt++) {
    try {
      held = lock.open(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = lock.check();
      if (existing && reclaimable(existing)) {
        // Recheck age and liveness under the generation's removal guard too.
        lock.remove(existing, reclaimable);
      } else if (performance.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * (attempt + 1), 80));
      } else break;
    }
  }
  if (!held) throw Error('Policy journal lock timeout; event not recorded');
  try {
    const owner = Buffer.from(JSON.stringify({ pid: process.pid, token }));
    if (writeSync(held.fd, owner, 0, owner.length, null) !== owner.length) {
      throw Error('Short policy journal lock write; event not recorded');
    }
    // Resolve only after acquiring the lock, including a formerly missing leaf.
    const journal = journalTarget(path, options);
    const { fd, stat } = journal.open(constants.O_WRONLY | constants.O_APPEND);
    try {
      if (stat.size + data.length > MAX_SOURCE_BYTES) throw Error('Oversized policy journal; event not recorded');
      if (lock.readOwner(held.stat)?.token !== token) {
        throw Error('Policy journal lock ownership lost; event not recorded');
      }
      if (writeSync(fd, data, 0, data.length, null) !== data.length) {
        throw Error('Short policy journal write; event incomplete');
      }
    } finally { closeSync(fd); }
  } finally {
    try { lock.remove(held.stat, stat => lock.readOwner(stat)?.token === token); } finally { closeSync(held.fd); }
  }
}

/** Optional env argument keeps callers and fixtures independent of ambient daemon state. */
export function recordPolicyEvent(input, env = process.env) {
  try {
    const event = { at: new Date().toISOString(), key: identityText(input.key, 200, 800), event: identityText(input.event, 200, 800), subject: identityText(input.subject, 500, 2000), reason: clean(input.reason, POLICY_EVENT_REASON_MAX) };
    if (input.detail !== undefined) event.detail = sanitise(input.detail);
    const bytes = () => Buffer.byteLength(JSON.stringify(event) + '\n');
    if (bytes() > 4096 && object(event.detail)) {
      for (const key of Object.keys(event.detail).reverse()) {
        delete event.detail[key];
        if (bytes() <= 4096) break;
      }
    }
    if (bytes() > 4096) delete event.detail;
    // Non-detail text is bounded too; keep the identity fields even for multibyte input.
    if (bytes() > 4096) event.reason = '…';
    appendPolicyJournal(policyEventsPath(env), JSON.stringify(event) + '\n', {
      allowedRoots: [process.cwd(), daemonStateDir(env), defaultLogsDir(env)],
    });
  } catch (error) {
    // Ordinary journal failures remain best effort. An abandoned removal guard
    // needs operator cleanup; never recursively reclaim it or hide this bound.
    if (error?.code === 'POLICY_JOURNAL_RECLAIM_BUSY') {
      try { console.warn(clean(error.message, 1000)); } catch { /* Logging is best effort too. */ }
    }
  }
}

export function readPolicyEvents({ sinceMs = 0, env = process.env } = {}) {
  try {
    const journal = resolveTrustedConfigPath(policyEventsPath(env), {
      allowedRoots: [process.cwd(), daemonStateDir(env), defaultLogsDir(env)],
    });
    return journal.read().split('\n').flatMap(line => {
      try { const entry = JSON.parse(line); return object(entry) && Date.parse(entry.at) >= sinceMs ? [entry] : []; } catch { return []; }
    });
  } catch { return []; }
}

// Cache source-derived data, never the trust decision: confinement and the registry are checked each run.
const cache = new Map();
async function cached(key, version, read) {
  if (cache.get(key)?.version === version) return cache.get(key).value;
  const value = await read();
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, { version, value });
  return value;
}
function resultFrom(defaults) {
  return { ...clone(defaults), sources: Object.fromEntries(Object.entries(defaults).map(([key, fields]) => [key, Object.fromEntries(Object.keys(fields).map(field => [field, 'default']))])), warnings: [], filesRead: [] };
}

// Policy defaults have no runtime dependencies. This list is code-owned, never
// sourced from policy/env input, and resolved once when this module loads.
export const POLICY_DEFAULTS_IMPORT_ALLOW_LIST = Object.freeze([]);

// Pure-data defaults must not reach code constructors or ambient runtime APIs.
// Match syntax identifiers, never text inside comments or string literals.
const POLICY_DEFAULTS_FORBIDDEN_IDENTIFIERS = new Set([
  'eval', 'Function', 'constructor', 'globalThis', 'process', 'require', 'module',
  'setTimeout', 'setInterval', 'WebAssembly', 'Worker',
]);

/** Injectable for conformance tests; neither the list nor its resolution map escapes. */
export function createPolicyImportGuard(allowList = POLICY_DEFAULTS_IMPORT_ALLOW_LIST, resolveImport = specifier => import.meta.resolve(specifier)) {
  const resolved = new Map(allowList.map(specifier => [specifier, resolveImport(specifier)]));
  const allowed = new Set([...resolved.keys(), ...resolved.values()]);
  const refuse = () => { throw Error('Policy defaults runtime import refused; only allow-listed string literals are permitted'); };
  const literal = node => {
    if (!node || !ts.isStringLiteral(node) || !allowed.has(node.text)) refuse();
  };
  // An identifier denylist alone cannot constrain computed property access.
  // Permit only data construction, erased types, and the explicit import list.
  function dataExpression(node) {
    if (!node) refuse();
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
      || ts.isRegularExpressionLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      dataExpression(node.expression);
      return;
    }
    if (ts.isPrefixUnaryExpression(node)
      && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)
      && (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand))) return;
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(dataExpression);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)
          || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) refuse();
        dataExpression(property.initializer);
      }
      return;
    }
    if (ts.isAwaitExpression(node)) {
      if (!ts.isCallExpression(node.expression) || node.expression.expression.kind !== ts.SyntaxKind.ImportKeyword) refuse();
      dataExpression(node.expression);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1) refuse();
      literal(node.arguments[0]);
      return;
    }
    refuse();
  }
  function dataStatement(node) {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) refuse();
        dataExpression(declaration.initializer);
      }
      return;
    }
    // Import validation below retains the code-owned allow-list and type erasure.
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isEmptyStatement(node)) return;
    if (ts.isExportDeclaration(node) && (node.isTypeOnly || node.moduleSpecifier
      || (node.exportClause && ts.isNamedExports(node.exportClause)))) return;
    if (ts.isExpressionStatement(node)) {
      dataExpression(node.expression);
      return;
    }
    refuse();
  }
  function check(source) {
    const ast = ts.createSourceFile('policy.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (ast.parseDiagnostics.length) refuse();
    function visit(node) {
      if (ts.isImportTypeNode(node)) return; // Erased TS type queries.
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly))) return;
        literal(node.moduleSpecifier);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (node.isTypeOnly) return;
        literal(node.moduleSpecifier);
      }
      if (ts.isImportEqualsDeclaration(node)) {
        if (node.isTypeOnly) return;
        if (!ts.isExternalModuleReference(node.moduleReference)) refuse();
        literal(node.moduleReference.expression);
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) refuse();
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1) refuse();
        literal(node.arguments[0]);
      }
      // Refuse aliases and member access too, including literal computed members.
      if (ts.isIdentifier(node) && POLICY_DEFAULTS_FORBIDDEN_IDENTIFIERS.has(node.text)) refuse();
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        && POLICY_DEFAULTS_FORBIDDEN_IDENTIFIERS.has(node.argumentExpression.text)) refuse();
      ts.forEachChild(node, visit);
    }
    visit(ast);
    ast.statements.forEach(dataStatement);
  }
  return Object.freeze({
    check,
    resolve(specifier) { if (!resolved.has(specifier)) refuse(); return resolved.get(specifier); },
    async importModule(source) {
      // Runtime boundary: recheck the exact bytes about to execute, even if a
      // caller bypassed the source/bundle lint checks.
      check(source);
      return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    },
  });
}
const defaultsImportGuard = createPolicyImportGuard();

async function transpileDefaults(source, env) {
  let scratch;
  try {
    defaultsImportGuard.check(source);
    scratch = mkdtempSync(join(env.TMPDIR || process.env.TMPDIR || tmpdir(), 'delivery-policy-defaults-'));
    const entry = join(scratch, 'deliveryPolicyDefaults.ts');
    writeFileSync(entry, source);
    // The component-tokens pattern: bundle real TS to an in-memory ESM data URL.
    // Scan before bundling (including dead code), and again after transformation.
    const output = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      plugins: [{ name: 'policy-import-allow-list', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? undefined
          : { path: defaultsImportGuard.resolve(args.path), external: true });
      } }],
    });
    const bundled = output.outputFiles[0].text;
    defaultsImportGuard.check(bundled);
    const module = await defaultsImportGuard.importModule(bundled);
    const defaults = module.PLATFORM_DELIVERY_POLICY_DEFAULTS;
    if (!object(defaults) || Object.keys(defaults).length !== Object.keys(domains).length) throw Error('Incomplete defaults');
    for (const [key, fields] of Object.entries(domains)) {
      if (!Object.hasOwn(defaults, key) || !object(defaults[key]) || Object.keys(defaults[key]).length !== Object.keys(fields).length) throw Error('Incomplete defaults');
      for (const [field, domain] of Object.entries(fields)) {
        if (!Object.hasOwn(defaults[key], field)) throw Error('Incomplete defaults');
        if (!valid(defaults[key][field], domain)) throw Error('Invalid default');
      }
    }
    return defaults;
  } finally {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Best effort. */ } }
  }
}

/** Resolve only human-gated sources. On incomplete evidence, retain defaults (or the protective failsafe). */
export async function loadDeliveryPolicy({ root = process.cwd(), env = process.env, ref, readdir } = {}) {
  const emergency = resultFrom(DELIVERY_POLICY_FAILSAFE);
  try {
    root = realpathSync(root);
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_SOURCE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    let commit;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) throw Error('Invalid base ref');
      commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error('Invalid base commit');
    }
    let registry;
    // Defaults/post-check fall back to the live registry if the base registry is unavailable; ref pointers do not.
    const registered = (path, requireBaseRegistry = false) => commit && (registry || requireBaseRegistry)
      ? registry?.has(basename(path)) === true : isPolicySpecPath(path);
    const filesRead = [];
    const opened = new Set();
    const mark = path => { if (!opened.has(path)) { opened.add(path); filesRead.push(path); } };
    function locate(path, external = false) {
      const absolute = resolve(root, path);
      if (commit && !external) {
        const normalized = relative(root, absolute).split(sep).join('/');
        if (!inside(root, absolute)) throw Error(`Outside root: ${path}`);
        const tree = git(['ls-tree', '-z', commit, '--', normalized]);
        const match = /^(100644|100755) blob [a-f0-9]+\t([^\0]+)\0$/.exec(tree);
        if (!match || match[2] !== normalized) throw Error(`Not a regular policy blob: ${path}`);
        return { path: normalized, version: commit, read: () => git(['show', `${commit}:${normalized}`]) };
      }
      if (!external) {
        try { assertStoredEntryName(dirname(absolute), basename(absolute), readdir); } catch (error) {
          // Listed nowhere yet reachable by path means the filesystem aliased the name (case, normalization): refuse.
          if (error.code === 'ENOENT' && lstatSync(absolute, { throwIfNoEntry: false })) throw Object.assign(Error(`Policy path identity refused: ${basename(absolute)}`), { code: 'POLICY_PATH_IDENTITY' });
          throw error;
        }
      }
      const trusted = resolveTrustedConfigPath(path, { root, allowedRoots: external ? [daemonStateDir(env)] : [root] });
      return { path: external ? trusted.real : relative(root, trusted.real).split(sep).join('/'), version: trusted.version, read: trusted.read };
    }
    async function read(location, kind) {
      return cached(`${root}:${commit || 'worktree'}:${location.path}:${kind}`, location.version, async () => {
        const source = location.read();
        mark(location.path);
        if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw Error('Oversized source');
        return kind === 'defaults' ? transpileDefaults(source, env) : JSON.parse(source);
      }).then(value => { mark(location.path); return value; });
    }
    // A missing registry refuses pointers. Defaults and root still have the fixed, human-gated contract.
    if (commit) registry = await readPolicySpecRegistryAt(commit, { root });
    let defaults;
    try {
      const location = locate(DEFAULTS_FILE);
      if (!registered(location.path)) throw Error('Ungated defaults');
      defaults = await read(location, 'defaults');
    } catch {
      emergency.filesRead = filesRead;
      emergency.warnings.push('Policy defaults unreadable; using most-protective failsafe. Restore the human-gated defaults file.');
      recordPolicyEvent({ key: 'deliveryPolicy', event: 'policy-defaults-unreadable', subject: DEFAULTS_FILE, reason: emergency.warnings[0] }, env);
      return emergency;
    }
    const result = resultFrom(defaults);
    result.filesRead = filesRead;
    const warn = message => result.warnings.push(clean(message, 1000));
    let sourcePath = ROOT_FILE, external = false, envSource = false;
    if (env.WE_POLICY_CONFIG) {
      try {
        if (env.GITHUB_ACTIONS || commit) throw Error('WE_POLICY_CONFIG ignored for PR/Actions gates');
        const requested = resolve(root, env.WE_POLICY_CONFIG);
        if (!requested.endsWith('.json')) throw Error('WE_POLICY_CONFIG must be JSON');
        let real;
        try {
          ({ real } = resolveTrustedConfigPath(env.WE_POLICY_CONFIG, { root, allowedRoots: [root, daemonStateDir(env)] }));
        } catch (error) {
          if (error.code === 'POLICY_SYMLINK') throw Error('WE_POLICY_CONFIG symlink refused');
          if (error.code === 'POLICY_OUTSIDE_ROOT') throw Error('WE_POLICY_CONFIG is outside registered repo sources and daemon state');
          throw error;
        }
        const inRoot = inside(root, real);
        if (inRoot && !isPolicySpecPath(relative(root, real).split(sep).join('/'))) throw Error('WE_POLICY_CONFIG is outside registered repo sources and daemon state');
        sourcePath = inRoot ? relative(root, real).split(sep).join('/') : real;
        external = !inRoot;
        envSource = true;
      } catch (error) { warn(error.message); }
    }
    let config, location;
    try {
      location = locate(sourcePath, external);
      if (!external && !isPolicySpecPath(location.path)) throw Error(`Unregistered policy source: ${location.path}`);
      config = await read(location, 'json');
      if (!object(config)) throw Error('Policy config must be an object');
    } catch (error) {
      // Absence of the conventional root file is normal; unreadable existing sources are not.
      const absent = sourcePath === ROOT_FILE && (commit ? !git(['ls-tree', '-z', commit, '--', ROOT_FILE]) : error.code === 'ENOENT');
      if (!absent) warn(`Cannot read policy config ${sourcePath}: ${error.message}`);
    }
    const origins = new Map();
    async function entry(value, chain) {
      if (typeof value !== 'string') return { value, chain };
      if (chain.length >= 20 || isAbsolute(value) || !value.endsWith('.json') || !inside(root, resolve(root, value))) throw Error(`Policy pointer refused: ${value}`);
      const target = locate(value);
      if (!registered(target.path, true)) throw Error(`Unregistered policy pointer: ${target.path}`);
      if (chain.includes(target.path)) throw Error(`Policy pointer cycle: ${target.path}`);
      return entry(await read(target, 'json'), [...chain, target.path]);
    }
    if (object(config)) for (const [key, fields] of Object.entries(domains)) {
      if (!Object.hasOwn(config, key)) continue;
      try {
        const resolved = await entry(config[key], [location.path]);
        let value = resolved.value;
        if (object(value) && value.kind === 'extends-flavor') {
          if (!Array.isArray(value.flavors) || value.flavors.some(flavor => typeof flavor !== 'string')) throw Error(`Invalid descriptor: ${key}`);
          value = value.overrides ?? {};
        }
        if (!object(value)) throw Error(`Invalid policy dimension: ${key}`);
        for (const [field, setting] of Object.entries(value)) {
          if (!Object.hasOwn(fields, field) || !valid(setting, fields[field])) { warn(`Invalid policy value: ${key}.${field}`); continue; }
          result[key][field] = setting;
          result.sources[key][field] = 'config';
          origins.set(`${key}.${field}`, resolved.chain);
        }
      } catch (error) { warn(error.message); }
    }
    // Independent post-check over every opened value source, even if an earlier guard was bypassed.
    const exempt = file => external && envSource && file === sourcePath && !inside(root, file)
      && resolveTrustedConfigPath(file, { root, allowedRoots: [daemonStateDir(env)] }).real === file;
    for (const file of filesRead) {
      const allowed = exempt(file) || registered(file);
      if (allowed) continue;
      warn(`Ungated policy source dropped by post-check: ${file}`);
      if (file === DEFAULTS_FILE) {
        const protective = resultFrom(DELIVERY_POLICY_FAILSAFE);
        return { ...protective, warnings: result.warnings, filesRead };
      }
      for (const [key, fields] of Object.entries(domains)) for (const field of Object.keys(fields)) {
        if (origins.get(`${key}.${field}`)?.includes(file)) { result[key][field] = defaults[key][field]; result.sources[key][field] = 'default'; }
      }
    }
    if (envSource) for (const [key, fields] of Object.entries(domains)) {
      const changed = Object.keys(fields).filter(field => result[key][field] !== defaults[key][field]);
      if (changed.length) recordPolicyEvent({ key, event: 'policy-source-env', subject: key, detail: { file: sourcePath, fields: changed.map(field => `${key}.${field}`) } }, env);
    }
    return result;
  } catch {
    emergency.warnings.push('Policy sources unavailable; using most-protective failsafe. Check the root and trusted base ref.');
    recordPolicyEvent({ key: 'deliveryPolicy', event: 'policy-defaults-unreadable', subject: DEFAULTS_FILE, reason: emergency.warnings[0] }, env);
    return emergency;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  const ref = flags.find(flag => flag.startsWith('--ref='))?.slice(6);
  const index = flags.indexOf('--ref');
  const result = await loadDeliveryPolicy({ ref: ref ?? (index >= 0 ? flags[index + 1] || '' : undefined) });
  process.stdout.write(JSON.stringify(result, null, flags.includes('--json') ? 0 : 2) + '\n');
}
