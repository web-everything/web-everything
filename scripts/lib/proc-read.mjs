/**
 * @file proc-read.mjs — bounded, fail-closed process reads (#74a).
 * Uses the existing gh throttle; callers must handle errors, never substitute empty data.
 */
import { execFileSyncThrottled } from './gh-throttle.mjs';

export const READ_MAX_BUFFER = 256 * 1024 * 1024;
export const MIN_READ_MAX_BUFFER = 1024 * 1024;

/** A failed read, retaining the original process/parse error and invocation. */
export class ProcReadError extends Error {
  /** @param {'output-too-large'|'exit'|'timeout'|'parse'} code */
  constructor(code, file, args, cause) {
    const stderr = cause?.stderr == null ? '' : String(cause.stderr).trim();
    super(`${file} read failed (${code})${stderr ? `: ${stderr}` : cause?.message ? `: ${cause.message}` : ''}`, { cause });
    this.name = 'ProcReadError';
    this.code = code;
    this.file = file;
    this.args = [...args];
    if (cause?.status != null) this.status = cause.status;
    if (cause?.stdout != null) this.bytes = Buffer.byteLength(cause.stdout);
  }
}

/**
 * Read stdout as text. Sub-minimum limits use the safe default; explicit limits at
 * or above the minimum are preserved, even when larger than READ_MAX_BUFFER.
 * `exec` is an injection seam only and is never forwarded to the process wrapper.
 */
export function execRead(file, args, opts = {}) {
  const { exec = execFileSyncThrottled, ...options } = opts;
  options.encoding ??= 'utf8';
  options.maxBuffer = options.maxBuffer == null || options.maxBuffer < MIN_READ_MAX_BUFFER
    ? READ_MAX_BUFFER : options.maxBuffer;
  try {
    const stdout = exec(file, args, options);
    if (stdout == null) throw new Error('stdout was not captured');
    return typeof stdout === 'string' ? stdout : stdout.toString(options.encoding === 'buffer' ? 'utf8' : options.encoding);
  } catch (cause) {
    const code = cause?.code === 'ENOBUFS' || cause?.errno === 'ENOBUFS' ? 'output-too-large'
      : cause?.code === 'ETIMEDOUT' || (cause?.signal === 'SIGTERM' && options.timeout > 0) ? 'timeout' : 'exit';
    throw new ProcReadError(code, file, args, cause);
  }
}

/** Read git through the shared process reader. */
export const readGit = (args, opts) => execRead('git', args, opts);
/** Read gh through the shared process reader and throttle. */
export const readGh = (args, opts) => execRead('gh', args, opts);

/** Parse a complete gh response; empty or malformed output is a failed read. */
export function readGhJson(args, opts) {
  const stdout = readGh(args, opts);
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    const error = new ProcReadError('parse', 'gh', args, cause);
    error.bytes = Buffer.byteLength(stdout);
    throw error;
  }
}
