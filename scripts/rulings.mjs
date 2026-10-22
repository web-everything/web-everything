import { open, readFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDigest, resolveDigestPath } from './lib/rulings-digest.mjs';

async function readDigest(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function updateDigest(path, update) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30000) {
          // Never steal a live writer's lock, even on a slow filesystem.
          const pid = Number(await readFile(lockPath, 'utf8'));
          let live = Number.isInteger(pid) && pid > 0;
          if (live) {
            try { process.kill(pid, 0); } catch (probe) {
              if (probe.code === 'ESRCH') live = false;
              else if (probe.code !== 'EPERM') throw probe;
            }
          }
          if (!live && (await stat(lockPath)).ino === info.ino) await unlink(lockPath);
        }
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockPath}`);
      await delay(25);
    }
  }
  let temporary;
  try {
    await lock.writeFile(String(process.pid));
    const { text, line } = update(await readDigest(path));
    temporary = join(dirname(path), `.${randomUUID()}.rulings.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return line;
  } finally {
    if (temporary) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

function etNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function singleLine(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} must be nonempty single-line text`);
  return value.trim();
}

async function main() {
  const options = {};
  const positional = [];
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) positional.push(arg);
    else {
      const equals = arg.indexOf('=');
      const key = arg.slice(2, equals < 0 ? undefined : equals);
      if (key in options) throw new Error(`duplicate option --${key}`);
      options[key] = equals < 0 ? true : arg.slice(equals + 1);
    }
  }
  const [command, id] = positional;
  const allowed = { add: ['class', 'quote', 'rule', 'tags'], list: ['active', 'json'], retire: ['by', 'superseded-by', 'codified-in'] };
  if (!allowed[command] || positional.length !== (command === 'retire' ? 2 : 1)) {
    throw new Error('usage: rulings.mjs add|list|retire <id> [--digest=<path>] [options]');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'digest' && !allowed[command].includes(key)) throw new Error(`unknown option --${key}`);
  }
  const env = { ...process.env };
  if ('digest' in options) env.RULINGS_DIGEST_PATH = singleLine(options.digest, '--digest');
  const resolved = resolveDigestPath({ env });
  if ('digest' in options) resolved.source = 'cli:--digest';
  const { path, source } = resolved;
  console.error(`rulings digest: ${path} (source ${source})`);
  if (command === 'list') {
    const rulings = parseDigest(await readDigest(path)).filter((r) => !options.active || r.active);
    console.log(options.json ? JSON.stringify(rulings, null, 2) : rulings.map((r) => r.raw).join('\n'));
  } else if (command === 'add') {
    const cls = singleLine(options.class, '--class');
    if (!/^(?:D|J|S:[^\s|]+(?: \(pending\))?)$/.test(cls)) throw new Error('invalid class');
    const quote = singleLine(options.quote, '--quote');
    const rule = singleLine(options.rule, '--rule');
    if (rule.includes(' | ')) throw new Error('--rule cannot contain the field separator');
    const tags = options.tags === undefined ? '' : singleLine(options.tags, '--tags').split(/[\s,]+/).join(' ');
    if (tags && !tags.split(' ').every((tag) => /^(?:mem:owed|(?:superseded-by|codifiedIn|review|retired):[^|\s]+)$/.test(tag))) throw new Error('invalid tags');
    console.log(await updateDigest(path, (text) => {
      const next = Math.max(0, ...parseDigest(text).map((r) => r.num)) + 1;
      const line = `R${next} | ${etNow()} | ${cls} | "${quote}" | ${rule}${tags ? ` ${tags}` : ''}`;
      return { text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`, line };
    }));
  } else {
    const modes = ['by', 'superseded-by', 'codified-in'].filter((key) => key in options);
    if (modes.length !== 1) throw new Error('retire requires exactly one of --by, --superseded-by, --codified-in');
    const mode = modes[0];
    if (mode === 'by' && /\s/.test(options[mode])) throw new Error('invalid retirement marker');
    const value = singleLine(options[mode], `--${mode}`);
    if (value.includes(' | ') || /\s/.test(value)) throw new Error('invalid retirement marker');
    if (mode === 'superseded-by' && !/^R\d+$/.test(value)) throw new Error('invalid superseding id');
    const marker = mode === 'by' ? `→ enforced by ${value}` : `${mode === 'codified-in' ? 'codifiedIn' : mode}:${value}`;
    console.log(await updateDigest(path, (text) => {
      const ruling = parseDigest(text).find((r) => r.id === id);
      if (!ruling) throw new Error(`unknown ruling ${id}`);
      if (!ruling.active) throw new Error(`already retired: ${id}`);
      const line = `${ruling.raw.trimEnd()} ${marker}`;
      // Replace only the matching physical row, preserving comments and line endings.
      const rows = text.split('\n');
      const index = rows.findIndex((row) => row.replace(/\r$/, '') === ruling.raw);
      rows[index] = line + (rows[index].endsWith('\r') ? '\r' : '');
      return { text: rows.join('\n'), line };
    }));
  }
}

main().catch((error) => { console.error(`rulings: ${error.message}`); process.exitCode = 1; });
