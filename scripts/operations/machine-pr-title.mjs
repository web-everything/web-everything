/** Titles are display text; item identity and kind remain at the front for machine readers. */
export const MACHINE_TITLE_LIMIT = 70;
export const MACHINE_TITLE_KINDS = Object.freeze(['prepare', 'prepare-stamp', 'review-prep', 'build',
  'doc-fix-build', 'bugfix-build', 'test-fix-build', 'gate-fix', 'fix', 'ci-heal', 'prevention',
  'file', 'findings', 'auto-resolve', 'auto-route', 'release', 'baselines']);

export function cleanTitle(value) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[`$<>\\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Best effort metadata only: failure must not bypass the prepare diff/isolation guard. */
export function readMainCard(item, git) {
  try {
    const paths = git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'])
      .trim().split('\n').filter((p) => p.startsWith(`backlog/${item}-`) && p.endsWith('.md'));
    if (paths.length !== 1) return null;
    const raw = git(['show', `origin/main:${paths[0]}`]);
    const title = /^#\s+(.+)$/m.exec(raw)?.[1];
    return title ? { title, raw } : null;
  } catch { return null; }
}

/** Bound the subject, preserving both the identity prefix and review provenance. */
export function boundedTitle(prefix, subject, suffix = '', limit = MACHINE_TITLE_LIMIT) {
  const cleaned = cleanTitle(subject);
  const room = limit - Array.from(prefix + suffix).length;
  if (room < 4) throw new Error('machine title identity leaves no room for a subject');
  const chars = Array.from(cleaned);
  return prefix + (chars.length > room ? chars.slice(0, room - 1).join('').trimEnd() + '…' : cleaned) + suffix;
}

export function preventionCardTitle({ repo, pr, subject, digest = '' }) {
  const finding = cleanTitle(subject) || firstFinding(digest);
  if (!finding) throw new Error('prevention card requires a finding subject');
  return boundedTitle('Prevention — ', finding, ` (from ${repo}#${pr} review)`, 160);
}

function firstFinding(raw) {
  return cleanTitle(/^\d+\.\s+(?:(?:`[^`]+`|\([^)]*\))\s*—\s*)?(.+)$/m.exec(raw ?? '')?.[1]);
}

export function machinePrTitle({ repo = 'WE', item, kind, card, subject: fallback }) {
  if (!MACHINE_TITLE_KINDS.includes(kind)) throw new Error(`unknown machine title kind: ${kind}`);
  let subject = cleanTitle(card?.title) || cleanTitle(fallback);
  let suffix = '';
  const guarded = /^File the prevention guard\(s\) owed by (\S+)#(\d+)'s/i.exec(subject);
  const descriptive = /^Prevention — (.+) \(from \S+#(\d+) review\)$/i.exec(subject);
  if (guarded || descriptive) {
    // A guard card with no numbered finding still has its own title: reword it, never fall to the placeholder.
    subject = descriptive?.[1] || firstFinding(card?.raw)
      || (guarded ? 'prevention guards owed' : '');
    suffix = ` (from #${(guarded || descriptive)[2]} review)`;
  }
  // Planning may precede the metadata read. Publication rejects this explicit sentinel.
  subject ||= `[subject unavailable for ${item}]`;
  return boundedTitle(`${repo} #${item}: ${kind} — `, subject, suffix);
}

/** Fail closed at publication; neither an empty slot nor a planning sentinel may become a PR. */
export function assertMachineTitle(title) {
  const value = cleanTitle(title);
  if (!value || /subject unavailable|<(?:[^>]*subject|one-line|specific correction|failing check|short card title)|^Merge (?:pull request|branch|remote-tracking)|file the prevention guard\(s\) owed|: (?:delivery build|gate-failure fix)$|Design\/MVP\/Test plan/i.test(String(title))) {
    throw new Error('PR title requires a specific change subject');
  }
  if (/^[A-Z]+ #[a-z0-9]+: [\w-]+ —\s*$/i.test(value)) throw new Error('PR title requires a subject');
  return boundedTitle('', value);
}

/** Normalize legacy commit subjects at the single PR-opening boundary. */
export function publicationTitle({ title, card }) {
  const value = cleanTitle(title);
  const tagged = /^(WE|FUI|PLATEAU) #([a-z0-9]+): (.+)$/i.exec(value);
  if (!tagged) return assertMachineTitle(title);
  const [, repo, item, rest] = tagged;
  if (/^[\w-]+ — /.test(rest)) return assertMachineTitle(title);
  const kind = /^gate-failure fix/i.test(rest) ? 'gate-fix'
    : /^(?:prepare|complete prepare)/i.test(rest) ? 'prepare' : /^CI-heal/i.test(rest) ? 'ci-heal'
    : /^(?:converge|fix|address review:changes)/i.test(rest) ? 'fix'
    : /^(?:health daemon filing|file )/i.test(rest) ? 'file' : 'build';
  const boilerplate = /^(?:delivery build|gate-failure fix|converge round|complete prepare stamp|record standalone worker Findings|.*build on probation|CI-heal PR|prepare item)/i.test(rest);
  return assertMachineTitle(machinePrTitle({ repo, item, kind, card: boilerplate ? card : null,
    subject: boilerplate ? '' : rest }));
}


/** The baseline workflow names actual changed snapshots; an empty diff opens nothing.
 * @test-only-export-ok: imported by the inline Node step in we:.github/workflows/update-visual-baselines.yml. */
export function visualBaselineTitle(paths) {
  const names = [...new Set(paths)].filter(Boolean).sort();
  if (!names.length) return null;
  const subject = names[0].split('/').at(-1).replace(/-chromium-linux\.png$/, '').replace(/-/g, ' ');
  return machinePrTitle({ item: 2238, kind: 'baselines',
    subject: `linux ${subject}${names.length > 1 ? ` (+${names.length - 1})` : ''}` });
}
