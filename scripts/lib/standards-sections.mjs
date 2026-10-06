/**
 * standards-sections.mjs — #70d: which check:standards sections a SCOPED run (`--local --files=…`) may skip.
 *
 * A scoped run blocks only on findings attributed to the lane's own files (partitionLocal in
 * we:scripts/readiness/claimScope.mjs). Some sections still walk the whole repo to reach that verdict, and they
 * dominate the scoped run's time and memory (#4130's profile: 14 enum-totality, 9a-rules, the 6d-ter tree scans).
 *
 * Each section listed here declares its INPUTS: path globs for the data it reads, plus `impl` entry modules
 * whose static import closure (importClosure, standards-cache.mjs) is also an input. A section runs when ANY
 * touched file matches ANY input. When none does, its output equals the base tree's output, and the base tree is
 * green (CI runs the full unscoped check on every PR), so skipping it cannot hide a new finding.
 *
 * Fail-safe rules, all toward RUNNING:
 *   - unscoped runs (no `--local --files=`) never skip anything — the gate returns true without looking;
 *   - a section not listed here always runs (the default for every section whose inputs are not declared);
 *   - a touched file in ALWAYS_TRIGGERS (the checker itself, this registry, the dependency manifests) runs all;
 *   - an `impl` closure that cannot be resolved, or a dynamic-input reader that throws, runs the section.
 *
 * A section with an input OUTSIDE this repo (8c reads ../frontierui, 9a″ reads the user's home memory dir) or an
 * input set nobody can enumerate is deliberately NOT listed: it stays "always".
 */
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure } from './standards-cache.mjs';

export const SKIP_REASON = 'skipped (scoped: no input touched)';

/** Touching any of these runs every section: they define what every section does. */
export const ALWAYS_TRIGGERS = [
  'scripts/check-standards.mjs',
  'scripts/lib/standards-sections.mjs',
  'scripts/lib/standards-cache.mjs',
  'package.json',
  'package-lock.json',
];

/**
 * Section id → declared inputs. `globs` are repo-relative (`**` crosses directories, `*` does not).
 * `impl` are repo-relative entry modules; their import closure is an input too.
 */
export const SECTION_INPUTS = {
  // The three whole-tree scans inside 6d-ter: utc-day-slice (scripts/), invisible-source (scripts/, docs/),
  // stdout-flush (scripts/, skills-src/, via the optional Rust port under scripts/rust-scan/).
  '6d-ter-tree-scans': {
    globs: ['scripts/**', 'docs/**', 'skills-src/**'],
    impl: ['scripts/lib/utc-day-slice-scan.mjs', 'scripts/lib/invisible-source-scan.mjs',
      'scripts/lib/stdout-flush-scan.mjs', 'scripts/lib/rust-scan-bridge.mjs'],
  },
  // Every package.json outside node_modules/dot-dirs, plus the serve() form catalog.
  '9c': {
    globs: ['**/package.json', 'blocks/renderers/module-service/moduleService.ts'],
    impl: ['scripts/check-standards-rules.mjs'],
  },
  // codifiedIn cites + statuses + anchor references (backlog/, docs/agent/), the invariant catalogue, and every
  // enforcer path the catalogue names (resolved by `dynamicInputs` in check-standards.mjs, since `exists()` on
  // those paths is an input too).
  '9a-rules': {
    globs: ['backlog/**', 'docs/agent/**', 'scripts/lib/invariant-catalogue.json'],
    impl: ['scripts/lib/validate-rules-anchors.cjs'],
  },
  // .claude/agent-memory is a symlink to agent-memory-src; both spellings are listed.
  '9a-prime': {
    globs: ['agent-memory-src/**', '.claude/agent-memory/**', 'backlog/**', 'docs/agent/**'],
    impl: ['scripts/lib/memory-freshness.cjs'],
  },
  '9a-prime-ii': {
    globs: ['agent-memory-src/**', '.claude/agent-memory/**', 'backlog/**', 'docs/agent/**'],
    impl: ['scripts/lib/memory-freshness.cjs'],
  },
  // Non-test .mjs/.js under scripts/ and skills-src/, plus the two enum homes (jury-core is under scripts/).
  '14': {
    globs: ['scripts/**/*.mjs', 'scripts/**/*.js', 'skills-src/**/*.mjs', 'skills-src/**/*.js'],
    impl: ['scripts/lib/verdict-totality.mjs', 'scripts/lib/jury-core.mjs'],
  },
  '15b': {
    globs: ['scripts/**/*.mjs', 'scripts/**/*.cjs'],
    impl: ['scripts/lib/review-skill-guard.mjs'],
  },
  '18': {
    globs: ['scripts/**/*.mjs', 'skills-src/**/*.mjs', 'package.json'],
    impl: ['scripts/check-standards-rules.mjs'],
  },
  // MANDATE_BUILDER_DIR = scripts/lib.
  '19': {
    globs: ['scripts/lib/**'],
    impl: ['scripts/lib/mandate-fence-scan.mjs'],
  },
};

/** Glob → anchored RegExp. `**` (and `**\/`) crosses `/`; `*` and `?` do not. Pure. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
/** True when repo-relative `path` matches any glob. Pure. */
export function matchesAny(path, globs) {
  return globs.some((g) => {
    let re = globCache.get(g);
    if (!re) { re = globToRegExp(g); globCache.set(g, re); }
    return re.test(path);
  });
}

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toRel = (root, abs) => relative(root, abs).split(sep).join('/');

/**
 * The scoped-run section gate. `scoped` false → `shouldRun` is always true and nothing is recorded (unscoped
 * output stays byte-identical). `touched` is the lane's file set (changed ∪ linked).
 * @param {{scoped:boolean, touched?:Iterable<string>|null, root?:string, inputs?:object, closure?:(abs:string)=>Map}} opts
 */
export function createSectionGate({ scoped, touched = null, root = DEFAULT_ROOT, inputs = SECTION_INPUTS, closure = importClosure } = {}) {
  const files = [...(touched || [])];
  const skipped = [];
  const allTriggered = files.some((f) => ALWAYS_TRIGGERS.includes(f));
  const closureFiles = (impl) => {
    const out = new Set();
    for (const entry of impl || []) for (const abs of closure(resolve(root, entry)).keys()) out.add(toRel(root, abs));
    return out;
  };
  /**
   * @param {string} id section id (a key of `inputs`)
   * @param {{dynamicInputs?: () => string[]}} [opts] extra exact repo-relative paths read at gate time
   * @returns {boolean} true = run the section
   */
  const shouldRun = (id, { dynamicInputs } = {}) => {
    if (!scoped) return true;
    const decl = inputs[id];
    if (!decl || allTriggered) return true;
    try {
      if (files.some((f) => matchesAny(f, decl.globs || []))) return true;
      const impl = closureFiles(decl.impl);
      if (files.some((f) => impl.has(f))) return true;
      if (dynamicInputs) {
        const extra = new Set(dynamicInputs());
        if (files.some((f) => extra.has(f))) return true;
      }
    } catch {
      return true; // inputs not resolvable with confidence → run
    }
    skipped.push(id);
    return false;
  };
  return { shouldRun, skipped };
}
