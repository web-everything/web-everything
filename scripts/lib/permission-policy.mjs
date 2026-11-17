/**
 * @file permission-policy.mjs — per-session-kind permission policy (card 0j).
 *
 * `config/permission-policy/<kind>.json` lists, per session kind, the allowed command patterns, path-scoped
 * write/delete rules and the always-ask / deny patterns. `decide(kind, toolName, input, cwd)` is a PURE
 * function that returns `{ decision: 'allow' | 'ask' | 'deny', reason }`.
 *
 * The compound-command logic is a port of the operator's PreToolUse hook (`allow-compound.mjs`): a Bash
 * command is allowed only when EVERY part of it (split on `; && || | &` and newline, with `$(...)` and
 * backtick bodies judged too) matches an allow rule. Anything not allowed is `ask` (the normal prompt);
 * `deny` is reserved for credential stores and permission-bypass flags.
 *
 * Two profiles:
 *   - `profile: 'hook'`   — exact replica of the hook's current decisions (parity-tested).
 *   - `profile: 'policy'` — default. Same engine plus the fixes and proposals from the 2026-11-17 sweep of
 *     2771 commands: tilde expansion mid-rule (B1), `cd ~/...` (B2), repo/handoff scripts by absolute path,
 *     workspace redirects that avoid `.git/`, read-only `sed`, scoped `sed -i`, `timeout N <cmd>`, plus the
 *     strict always-ask rules (hard reset, git clean, bypass flags, credentials, CLAUDE.md writes).
 *
 * Safety contract: the policy never allows what the current setup asks for (settings, hooks, CLAUDE.md,
 * credentials, force push, hard reset, bypass flags). Placeholders in the JSON: `@HOME@` in regexes and a
 * leading `~` in command patterns; both are bound to `home` at load time, so no path is baked in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KINDS = Object.freeze(['fix', 'ci-heal', 'review-job', 'red-team', 'worker', 'babysitter']);
export const POLICY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'permission-policy');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const cache = new Map();

/** Read and validate one kind's policy JSON (no home binding yet). */
export function loadPolicy(kind, { dir = POLICY_DIR } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`permission-policy: unknown session kind "${kind}"`);
  const key = `${dir}\0${kind}`;
  if (cache.has(key)) return cache.get(key);
  const p = JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8'));
  if (p.kind !== kind) throw new Error(`permission-policy: ${kind}.json declares kind "${p.kind}"`);
  for (const f of ['allow', 'always_ask', 'deny']) if (!p[f] || typeof p[f] !== 'object') throw new Error(`permission-policy: ${kind}.json missing "${f}"`);
  if (!Array.isArray(p.allow.bash)) throw new Error(`permission-policy: ${kind}.json allow.bash must be an array`);
  cache.set(key, p);
  return p;
}

/** List the kinds that have a policy file in `dir`. */
export function listKinds({ dir = POLICY_DIR } = {}) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

const bindRe = (src, home, flags = '') => new RegExp(String(src).replaceAll('@HOME@', escapeRe(home)), flags);
const bindAll = (arr, home) => (arr ?? []).map((x) => (typeof x === 'string' ? bindRe(x, home) : { ...x, re: bindRe(x.re, home) }));

/** Bind a policy to a home directory and profile. */
export function compilePolicy(policy, { home = homedir(), profile = 'policy' } = {}) {
  const a = policy.allow;
  const isHook = profile === 'hook';
  return {
    kind: policy.kind,
    isHook,
    home,
    rules: a.bash.map((p) => (isHook ? p.replace(/^~/, home) : p.replace(/(^|\s)~(?=\/)/g, `$1${home}`))),
    builtins: new Set(a.builtins ?? []),
    writeOk: bindAll(a.redirect_targets, home),
    relCwd: a.relative_redirect_cwd ? bindRe(a.relative_redirect_cwd, home) : null,
    laneMsgRm: a.lane_message_rm ? bindRe(a.lane_message_rm, home) : null,
    laneRmCwd: (a.lane_scratch_rm_cwd ?? []).map((s) => bindRe(s, home)),
    laneRmName: (isHook ? a.lane_scratch_rm_name : (a.lane_scratch_rm_name_strict ?? a.lane_scratch_rm_name)) ? bindRe(isHook ? a.lane_scratch_rm_name : (a.lane_scratch_rm_name_strict ?? a.lane_scratch_rm_name), home) : null,
    editOk: bindAll(a.edit, home),
    proposed: bindAll(a.proposed, home).map((r) => ({ ...r, cwd: r.cwd ? bindRe(r.cwd, home) : null, forbid: r.forbid ? bindRe(r.forbid, home) : null })),
    wsNever: bindAll(a.workspace_write_never, home),
    laneGitMsg: a.lane_git_message_ok ? bindRe(a.lane_git_message_ok, home) : null,
    askBash: bindAll(policy.always_ask.bash, home).filter((r) => !(isHook && r.strict)),
    askEdit: bindAll(policy.always_ask.edit, home).filter((r) => !(isHook && r.strict)),
    rmRecursiveAsk: policy.always_ask.rm_recursive !== false,
    denyBash: bindAll(policy.deny.bash, home),
    denyEdit: bindAll(policy.deny.edit, home),
    workspace: `${home}/workspace/`,
  };
}

function matchesRule(seg, rs, home) {
  const s = seg.replace(/(^|\s)~(?=\/)/g, `$1${home}`);
  return rs.some((p) => {
    if (p.endsWith(' *')) { const b = p.slice(0, -2); return s === b || s.startsWith(`${b} `); }
    if (p.endsWith('*')) return s.startsWith(p.slice(0, -1));
    return s === p;
  });
}

// Split on unquoted ; && || | & newline, pulling out $(...) and `...` bodies into `inner`.
function split(cmd, inner) {
  const out = []; let cur = ''; let q = null;
  const grab = (i) => {
    let depth = 1; let j = i + 2;
    while (j < cmd.length && depth) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; j++; }
    inner.push(cmd.slice(i + 2, j - 1));
    return j - 1;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === '"' && c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') { cur += 'X'; i = grab(i); continue; }
    if (q === '"' && c === '`') { const j = cmd.indexOf('`', i + 1); if (j < 0) return null; inner.push(cmd.slice(i + 1, j)); cur += 'X'; i = j; continue; }
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') { cur += 'X'; i = grab(i); continue; }
    if (c === '`') { const j = cmd.indexOf('`', i + 1); if (j < 0) return null; inner.push(cmd.slice(i + 1, j)); cur += 'X'; i = j; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) {
      out.push(cur); cur = ''; if (cmd[i + 1] === c) i++; continue;
    }
    cur += c;
  }
  if (q) return null;
  out.push(cur);
  return out;
}

const KEYWORDS = /^(do|then|else|elif|if|while|until|!)\s+/;
const BARE = new Set(['done', 'fi', '{', '}', '(', ')', 'do', 'then', 'else', '']);
const REDIR = /\d*>>?\s*("[^"]*"|'[^']*'|[^\s]+)/g;

function redirectOk(t, c, cwd) {
  const abs = c.writeOk.some((r) => r.test(t));
  if (c.isHook) {
    const relOk = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(t) && !t.includes('..') && c.relCwd?.test(cwd ?? '');
    return Boolean(relOk || abs);
  }
  if (/^(\/dev\/null|&\d)$/.test(t)) return true;
  const expanded = t.replace(/^(~|\$HOME)(?=\/)/, c.home);
  // Workspace writes never reach `.git/` or `..`, except a worker's own message file at a lane path.
  const guarded = (p, rel) => (c.wsNever.some((r) => r.test(rel ? `/${p}` : p)) ? Boolean(c.laneGitMsg?.test(p)) : true);
  if (/^\//.test(expanded)) {
    if (!(abs || c.writeOk.some((r) => r.test(expanded)))) return false;
    return expanded.startsWith(c.workspace) ? guarded(expanded, false) : true;
  }
  if (/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(t) && !t.includes('..') && c.relCwd?.test(cwd ?? '')) return guarded(t, true);
  return false;
}

function pathsUnderWorkspace(args, c, cwd) {
  const files = args.trim().split(/\s+/).filter(Boolean);
  return files.length > 0 && files.every((f) => {
    let e = f.replace(/^["']|["']$/g, '').replace(/^(~|\$HOME)(?=\/)/, c.home);
    if (!e.startsWith('/')) e = `${String(cwd ?? '').replace(/\/$/, '')}/${e}`;
    return e.startsWith(c.workspace) && !e.includes('..') && !c.wsNever.some((r) => r.test(e)) && !/[*?[{]/.test(e);
  });
}

function okSegment(raw, c, cwd, depth = 0) {
  let s = raw.trim();
  while (KEYWORDS.test(s)) s = s.replace(KEYWORDS, '');
  s = s.replace(/^[{(]\s*/, '').replace(/\s*[})]$/, '');
  if (BARE.has(s)) return true;
  if (/^for\s+\w+\s+in\b/.test(s)) return true;
  const whole = s;
  for (const m of s.matchAll(REDIR)) {
    const t = m[1].replace(/^["']|["']$/g, '');
    if (!redirectOk(t, c, cwd)) return false;
  }
  s = s.replace(REDIR, '').replace(/\d*<\s*[^\s]+/g, '').trim();
  while (/^[A-Za-z_]\w*=("[^"]*"|'[^']*'|[^\s]*)(\s+|$)/.test(s)) s = s.replace(/^[A-Za-z_]\w*=("[^"]*"|'[^']*'|[^\s]*)\s*/, '');
  if (s === '') return true;
  if (/^\(\(.*\)\)$/.test(s)) return true;
  const head = s.split(/\s+/)[0];
  if (c.builtins.has(head)) return true;
  if (!c.isHook) {
    const tm = /^timeout\s+\d+[smh]?\s+(.+)$/s.exec(s);
    if (tm && depth < 2) return okSegment(tm[1], c, cwd, depth + 1);
    for (const r of c.proposed) {
      if (r.cwd && !r.cwd.test(cwd ?? '')) continue;
      const m = r.re.exec(s);
      if (!m) continue;
      if (r.noDotDot && s.includes('..')) continue;
      if (r.forbid && r.forbid.test(s)) continue;
      if (r.pathsGroup && !pathsUnderWorkspace(m[r.pathsGroup], c, cwd)) continue;
      return true;
    }
    // A script path that climbs out with `..` can leave the directory a `node <dir>/*` rule meant to allow.
    if (/^(node|bash)\s/.test(s) && /(^|[\s/"'])\.\.(\/|$|\s)/.test(s)) return false;
  }
  void whole;
  return matchesRule(s, c.rules, c.home);
}

// Heredoc bodies are data: drop them before splitting. A heredoc fed to a shell or interpreter is code.
export function stripHeredocs(cmd, { strictSubst = false } = {}) {
  const re = /(\S+)?[^\n]*?<<-?\s*(['"]?)(\w+)\2[^\n]*\n/g;
  let out = cmd; let m;
  while ((m = re.exec(out))) {
    const line = out.slice(out.lastIndexOf('\n', m.index) + 1, m.index + m[0].length);
    if (/(^|[;&|\s])(ba|z)?sh\b|\b(node|python3?|perl|ruby|osascript)\b(?!\s+-e)/.test(line.split('<<')[0].replace(/\bnode\s+(sample|report)\.mjs\b/, ''))
        && !/^\s*(cat|tee)\b/.test(line)) return null;
    // An unquoted delimiter lets the shell expand $(...) and backticks in the body: that is code.
    if (strictSubst && m[2] === '' && /\$\(|`/.test(out.slice(m.index + m[0].length, out.indexOf(`\n${m[3]}`, m.index + m[0].length - 1) < 0 ? undefined : out.indexOf(`\n${m[3]}`, m.index + m[0].length - 1)))) return null;
    const end = out.indexOf(`\n${m[3]}`, m.index + m[0].length - 1);
    if (end < 0) return null;
    const after = out.indexOf('\n', end + 1);
    out = out.slice(0, m.index + m[0].length - 1) + (after < 0 ? '' : out.slice(after));
    re.lastIndex = 0;
  }
  return out;
}

function okCompound(cmd, c, cwd, depth = 0) {
  if (depth > 4) return false;
  const inner = [];
  const segs = split(cmd, inner);
  if (!segs) return false;
  if (!segs.every((x) => okSegment(x, c, cwd))) return false;
  return inner.every((x) => okCompound(x, c, cwd, depth + 1));
}

const result = (decision, reason) => ({ decision, reason });

function decideEdit(c, input) {
  const p = String(input?.file_path ?? input?.notebook_path ?? '');
  if (!p) return result('ask', 'no file path');
  const denied = c.denyEdit.find((r) => r.re.test(p));
  if (denied) return result('deny', `deny: ${denied.why}`);
  const asked = c.askEdit.find((r) => r.re.test(p));
  if (asked) return result('ask', `always-ask: ${asked.why}`);
  if (!c.isHook && c.wsNever.some((r) => r.test(p)) && p.startsWith(c.workspace)) return result('ask', 'always-ask: write inside .git');
  if (c.editOk.some((r) => r.test(p))) return result('allow', 'edit in an area this session kind may write');
  return result('ask', 'edit outside the areas this session kind may write');
}

function decideBash(c, input, cwdIn) {
  const raw = String(input?.command ?? '');
  let cmd = raw ? stripHeredocs(raw, { strictSubst: !c.isHook }) : null;
  let cwd = String(cwdIn ?? input?.cwd ?? '');
  if (cmd) {
    const lead = /^\s*cd\s+(\/[^\s;&|]+|~\/[^\s;&|]*)\s*(?:\n|&&|;)/.exec(cmd);
    if (lead && !lead[1].includes('..') && (c.isHook ? lead[1].startsWith('/') : true)) cwd = lead[1].replace(/^~(?=\/)/, c.home);
  }
  if (cmd) {
    const dn = c.denyBash.find((r) => r.re.test(cmd));
    if (dn) return result('deny', `deny: ${dn.why}`);
  }
  if (cmd && c.laneMsgRm) {
    cmd = cmd.replace(/(^|[;&|]\s*)rm\s+-f\s+([^;&|\n]+?)(?=\s*(?:[;&|]|$))/gm, (m, pre, args) =>
      args.trim().split(/\s+/).every((a) => c.laneMsgRm.test(a)) ? `${pre}true` : m);
  }
  if (cmd && c.laneRmName && c.laneRmCwd.some((r) => r.test(cwd))) {
    cmd = cmd.replace(/(^|[;&|]\s*)rm\s+-(?:rf|fr|r|f)\s+([^;&|\n]+?)(?=\s*(?:[;&|]|$))/gm, (m, pre, args) =>
      args.trim().split(/\s+/).every((a) => c.laneRmName.test(a)) ? `${pre}true` : m);
  }
  if (cmd && c.rmRecursiveAsk && /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/.test(cmd)) return result('ask', 'always-ask: rm -r/-f outside lane scratch');
  if (!cmd) return result('ask', 'empty or unjudgeable command (heredoc fed to a shell)');
  const asked = c.askBash.find((r) => r.re.test(cmd));
  if (asked) return result('ask', `always-ask: ${asked.why}`);
  if (!okCompound(cmd, c, cwd)) return result('ask', 'a part of the command matches no allow rule');
  return result('allow', 'every part matches an allow rule');
}

/**
 * Pure decision. `input` is the tool input (`{command}` for Bash, `{file_path}` for Edit/Write).
 * Never throws on bad input: an unknown tool or malformed input is `ask`.
 * @returns {{decision: 'allow'|'ask'|'deny', reason: string}}
 */
export function decide(kind, toolName, input, cwd, opts = {}) {
  const { home = homedir(), profile = 'policy', dir = POLICY_DIR } = opts;
  const policy = loadPolicy(kind, { dir });
  const c = compilePolicy(policy, { home, profile });
  try {
    if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) return decideEdit(c, input);
    if (toolName === 'Bash') return decideBash(c, input, cwd);
    return result('ask', `tool ${toolName} is not covered by the policy`);
  } catch (err) {
    return result('ask', `policy error: ${err?.message ?? err}`);
  }
}
