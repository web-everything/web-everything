/** Shared gh argv parsers and their standalone source for generated shims.
 * Keep these functions in one module with local dependencies: Function#toString on an imported
 * dependency can otherwise retain a bundler's rewritten import name in the generated script.
 */

// gh parses argv with cobra/pflag, so command words are not at fixed indices: flags may precede them
// (`gh --repo o/r run watch`). Cobra's walk (stripFlags) skips a flag without `=` together with the
// next argument unless the flag is a known boolean, and `--` ends it. Above the leaf only help/version
// are boolean (`-R/--repo` takes a value).
/** The first two command words with their argv indices (`[{ word: 'pr', at: 2 }, …]`). */
export function ghCommandWords(args) {
  const groupBools = { long: new Set(['help', 'version']), short: new Set(['h']) };
  const words = [];
  for (let i = 0; Array.isArray(args) && i < args.length && words.length < 2; i++) {
    const s = String(args[i]); // as spawn stringifies it, so every classifier sees the argv gh receives
    if (s === '--') break;
    const long = s.startsWith('--') && !groupBools.long.has(s.slice(2));
    if (!s.includes('=') && (long || (s.length === 2 && s[0] === '-' && !groupBools.short.has(s[1])))) i++;
    else if (s !== '' && !s.startsWith('-')) words.push({ word: s, at: i });
  }
  return words;
}

/** Parse gh api's flags, fields (`key=value`, in order), input and positionals. */
export function parseGhApiArgs(args) {
  // `gh api`'s own short flags (pflag): the ones that take a value, and the one boolean. Any OTHER short letter
  // is unknown to this scanner and is treated as unsafe (see {@link scanGhApiFlags}).
  const GH_API_SHORT_VALUE_FLAGS = new Set(['X', 'f', 'F', 'H', 'p', 'q', 't']);
  const GH_API_SHORT_BOOL_FLAGS = new Set(['i']);
  // A bare `--jq X` consumes X even when X looks like a flag (`-XPOST`).
  const GH_API_LONG_VALUE_FLAGS = new Set(['cache', 'field', 'header', 'hostname', 'input', 'jq', 'method', 'preview', 'raw-field', 'template']);
  const a = Array.isArray(args) ? args.map(String) : [];
  const out = { methods: [], payload: false, unknown: false, input: false, fields: [], positionals: [] };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    // No early stop at `--`: pflag takes it as the VALUE of a preceding long flag (`--preview -- -XPOST` still
    // sends a POST), and `gh api` takes one endpoint anyway — scanning to the end can only add false negatives.
    if (t === '--') continue;
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0];
      const value = !GH_API_LONG_VALUE_FLAGS.has(name) ? '' : t.includes('=') ? t.slice(t.indexOf('=') + 1) : String(a[++i] ?? '');
      if (name === 'method') out.methods.push(value.toUpperCase());
      else if (name === 'input') { out.payload = true; out.input = true; }
      else if (name === 'field' || name === 'raw-field') { out.payload = true; out.fields.push(value); }
      continue;
    }
    if (!t.startsWith('-') || t.length < 2) { out.positionals.push(t); continue; } // a positional (or a bare `-`)
    for (let j = 1; j < t.length; j++) {
      const c = t[j];
      if (GH_API_SHORT_BOOL_FLAGS.has(c)) continue;
      if (!GH_API_SHORT_VALUE_FLAGS.has(c)) { out.unknown = true; break; }
      const rest = t.slice(j + 1);
      const value = rest.length ? rest : String(a[++i] ?? '');
      if (c === 'X') out.methods.push(value.toUpperCase());
      if (c === 'f' || c === 'F') { out.payload = true; out.fields.push(value); }
      break; // a value-taking flag consumes the rest of the token (or the next arg)
    }
  }
  return out;
}

/**
 * Which GitHub rate-limit RESOURCE a `gh` argv spends — `graphql` (every `gh pr …`/`gh issue …`/`gh repo …`/
 * `gh project …` subcommand and `gh api graphql`) or `core` (REST: `gh api <path>`, `gh run …`, `gh label …`,
 * `gh workflow …`, …). PURE. The two are separate buckets, so exhausting one must never block the other.
 * @param {string[]} args
 * @returns {'graphql'|'core'}
 */
export function classifyGhResource(args) {
  const a = Array.isArray(args) ? args.map(String) : [];
  // Not led by 'pr': multi-repo-scan reads any `['pr', …]` literal as gh argv and would flag it as repo-less.
  const [first] = ghCommandWords(a);
  const cmd = first?.word;
  if (['issue', 'pr', 'repo', 'project', 'search'].includes(cmd)) return 'graphql';
  if (cmd === 'api') {
    // The endpoint is the first positional of the pflag parse without the `api` word, so neither leading flags
    // (`-R o/r api graphql`) nor clustered short flags (`-iq .x graphql`, `-iH graphql r`) can shift it.
    return parseGhApiArgs(a.filter((_, i) => i !== first.at)).positionals[0] === 'graphql' ? 'graphql' : 'core';
  }
  return 'core';
}

/** Embed the classifier's complete dependency graph without runtime checkout imports. */
export function renderGhResourceClassifier() {
  return [ghCommandWords, parseGhApiArgs, classifyGhResource].map(fn => fn.toString()).join('\n');
}
