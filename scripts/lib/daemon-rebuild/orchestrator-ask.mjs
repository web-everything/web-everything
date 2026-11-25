/**
 * Advisory, once-per-key asks for the orchestrator (a pinned overlay branch moved past its audited pin).
 * The asks file is its own dedupe: a line with the same key means "already asked". Nothing here ever throws
 * into the rebuild or blocks adoption; a failed read or write returns { ok: false } for the caller to alert once.
 */
import { readFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_READ = 4 * 1024 * 1024;

export function orchestratorAsksPath(env = process.env) {
  return env.WE_ORCHESTRATOR_ASKS_PATH
    || join(env.HOME || homedir(), 'workspace/.operations/handoff/state/orchestrator-asks.jsonl');
}

function readBounded(file) {
  const size = statSync(file).size;
  const len = Math.min(size, MAX_READ);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

export function raiseOrchestratorAsk({ key, kind = 'pin-moved', ask, evidence, env = process.env, now = () => new Date().toISOString(), fs = {} }) {
  const { read = readBounded, append = appendFileSync, mkdir = mkdirSync } = fs;
  // Tests never write the operator's real asks file: they must point WE_ORCHESTRATOR_ASKS_PATH somewhere temporary.
  if (!env.WE_ORCHESTRATOR_ASKS_PATH && (process.env.VITEST || env.VITEST)) return { ok: true, asked: false };
  const file = orchestratorAsksPath(env);
  try {
    let text = '';
    try { text = read(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const line of String(text).split('\n')) {
      try { if (JSON.parse(line)?.key === key) return { ok: true, asked: false }; } catch { /* truncated or foreign line */ }
    }
    mkdir(dirname(file), { recursive: true });
    const prefix = text && !text.endsWith('\n') ? '\n' : '';
    append(file, `${prefix}${JSON.stringify({ at: now(), repo: 'web-everything/web-everything', kind, key, ask, evidence })}\n`);
    return { ok: true, asked: true };
  } catch (error) {
    return { ok: false, asked: false, error: String(error?.message || error) };
  }
}

export function askPinMoved({ ref, pr, adopted, newTip, env, ...rest }) {
  const short = (s) => String(s).slice(0, 8);
  return raiseOrchestratorAsk({
    key: `pin-moved:${ref}@${adopted}`,
    ask: `${ref}${pr != null ? ` (PR #${pr})` : ''} moved past its audited pin ${short(adopted)} to ${short(newTip)}; `
      + `the fix daemon keeps building the pin. Audit ${newTip} and re-load, or leave it pinned.`,
    evidence: { ref, pr: pr ?? null, adopted, newTip },
    env,
    ...rest,
  });
}
