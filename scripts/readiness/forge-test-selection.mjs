import {execFile} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {promisify} from 'node:util';
import {isAbsolute, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const refuse = async () => true;
// Bound at call time: importing this module must not touch child_process.
const execute = (...args) => promisify(execFile)(...args);
const child = fileURLToPath(new URL('./forge-vitest-select.mjs', import.meta.url));
const MAX_OUTPUT = 4 * 1024 * 1024;

// Deliberately smaller than Vitest's CLI. Unknown syntax keeps local fallback;
// only Vitest itself interprets configs, workspaces, globs and filename filters.
function selectionArgs(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) return;
  const args = argv[0] === 'npx' && argv[1] === 'vitest' && argv[2] === 'run' ? argv.slice(3)
    : argv[0] === 'vitest' && argv[1] === 'run' ? argv.slice(2) : undefined;
  if (!args) return;
  const options = {watch:false, run:true}, filters = [];
  const valued = new Map([['--config','config'], ['-c','config'], ['--root','root'], ['-r','root'], ['--dir','dir'], ['--project','project'], ['--reporter','reporter']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { filters.push(arg); continue; }
    const equal = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    const key = valued.get(flag);
    if (key) {
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith('-')) return;
      if (key === 'reporter') continue;
      if (key === 'project') (options.project ??= []).push(value);
      else {
        // Repeated scalar flags have CLI-dependent array/coercion semantics.
        if (Object.hasOwn(options, key)) return;
        options[key] = value;
      }
    } else if (flag === '--silent' || flag === '--coverage') {
      if (equal >= 0 ? !['true','false'].includes(arg.slice(equal + 1)) : /^(?:true|false)/i.test(args[i+1] ?? '')) return;
    } else return;
  }
  return {options, filters};
}

// exec has the promisified execFile signature, independent of Git/SSH exec.
// A killed/oversized/unreadable listing always retains ignored-test refusal.
export async function loadTestSelector({cwd, argv, env = process.env, exec = execute, timeoutMs = 60000} = {}) {
  try {
    const selection = selectionArgs(argv);
    if (!selection || !isAbsolute(cwd) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return refuse;
    // A child reports physical process.cwd(), even when the caller used a lane
    // symlink (or /var on macOS). Compare paths in that same coordinate system.
    cwd = await realpath(cwd);
    const {stdout} = await exec(process.execPath, [child, JSON.stringify(selection)], {
      cwd, env, encoding:'utf8', timeout:timeoutMs, killSignal:'SIGKILL', maxBuffer:MAX_OUTPUT,
    });
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT) return refuse;
    const files = JSON.parse(stdout);
    if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') || /[\uD800-\uDFFF]/u.test(file))) return refuse;
    const paths = files.map(file => relative(cwd, file));
    // Empty/outside listings cannot establish safe non-selection in this repo.
    if (paths.some(path => !path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))) return refuse;
    const selected = new Set(paths.map(path => Buffer.from(path).toString('hex')));
    return async path => {
      if (typeof path !== 'string' && !Buffer.isBuffer(path)) return true;
      const bytes = Buffer.from(path);
      // Node/Vitest filenames cannot prove non-selection of opaque Git bytes.
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) return true;
      return selected.has(bytes.toString('hex'));
    };
  } catch { return refuse; }
}
