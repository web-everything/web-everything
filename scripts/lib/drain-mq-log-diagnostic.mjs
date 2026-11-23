/** Display-only terminal-log handling. Sanitized text must never become evidence. */
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const MAX_SCAN = 256 * 1024;

export function mqLogDiagnosticExcerpt(text) {
  // Never start scanning a tail inside a control-string payload. Oversized injected input has
  // an explicit operator fallback rather than an excerpt that might expose a partial payload.
  if (text.length > MAX_SCAN) return 'job log exceeds diagnostic scan bound; operator must inspect the full log';
  const lines = [];
  for (const line of text.split('\n')) {
    let plain = '';
    for (let i = 0; i < line.length;) {
      const code = line.charCodeAt(i);
      const escape = code === 0x1b;
      const next = escape ? line[i + 1] : '';
      const string = escape && ']PX^_'.includes(next) && next !== ''
        || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code);
      if (string) {
        const osc = next === ']' || code === 0x9d;
        i += escape ? 2 : 1;
        // All strings end at this line's boundary, even without BEL/ST.
        while (i < line.length) {
          if (line.charCodeAt(i) === 0x9c || osc && line.charCodeAt(i) === 7) { i++; break; }
          if (line[i] === '\x1b' && line[i + 1] === '\\') { i += 2; break; }
          i++;
        }
      } else if (escape && next === '[' || code === 0x9b) {
        i += escape ? 2 : 1;
        while (i < line.length && !/[\x40-\x7e]/.test(line[i])) i++;
        if (i < line.length) i++;
      } else if (escape) {
        i++;
        while (i < line.length && /[\x20-\x2f]/.test(line[i])) i++;
        if (i < line.length && /[\x30-\x7e]/.test(line[i])) i++;
      } else {
        if (!/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(line[i])) plain += line[i];
        i++;
      }
    }
    if (plain.trim()) lines.push(plain.trim());
  }
  return lines.join(' ').slice(-600) || 'terminal control content only; operator must inspect the full log';
}

/** Preserve the old unreadable-log path, retaining only a bounded display side channel. */
export function readMqDiagnosticLog(exec, file, args, opts, onDiagnostic = () => {}) {
  const raw = exec(file, args.includes('--allow-escape-sequences') ? args : [...args, '--allow-escape-sequences'], opts);
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof text === 'string' && controls.test(text)) {
    onDiagnostic(mqLogDiagnosticExcerpt(text));
    throw new Error('unreadable log');
  }
  return raw;
}
