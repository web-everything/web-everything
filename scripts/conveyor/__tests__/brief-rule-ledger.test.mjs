// #4070 — the brief-rule ledger: every imperative line in a dispatched brief, mapped to its enforcer or marked
// judgment / prose-only / descriptive. Fixture briefs pin the audit; the real ledger pins the three rules the
// 2026-09-24 incident broke to code enforcers whose own tests exist.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_HOOKS_SETTINGS } from '../../operations/deliver-item-wrapper.mjs';
import {
  REPO_ROOT, auditLedger, extractImperatives, lineKey, listBriefs, loadLedger, missingEnforcerFiles,
  readBriefs, validateLedger, weakestStatus,
} from '../brief-rule-ledger.mjs';

import { pinnedHookScript, pinnedStopHookScript } from '../../lib/pinned-hook-command.mjs';

const BRIEF = 'skills-src/conveyor/x-agent-brief.md';

// Bounded to the registrations used here: an actual node invocation, with its script argument.
// Comments, echo/prose and similarly named scripts cannot supply registration evidence.
// The non-blocking Stop wrapper counts only where it is registered for a Stop event.
function invokes(command, script, event) {
  if (pinnedHookScript(command) === script) return true;
  if (pinnedStopHookScript(command) === script) return event === 'Stop' || event === 'SubagentStop';
  return String(command).split('\n').some((line) => {
    if (line.trimStart().startsWith('#')) return false;
    const groups = [[]];
    for (const token of line.match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[;|]|[^\s;|&]+/g) || []) {
      if (token.startsWith('#')) break;
      if (/^(?:&&|\|\||[;|])$/.test(token)) groups.push([]);
      else groups.at(-1).push(token);
    }
    return groups.some((words) => {
      const unquote = (s) => s?.replace(/^(['"])(.*)\1$/, '$2');
      return /^(?:.*\/)?node$/.test(unquote(words[0]) || '')
        && unquote(words[1])?.replace(/^\.\//, '') === script;
    });
  });
}

function missingRegistrations(ledger, settings, readRegistration) {
  const commands = settings.flatMap((setting) => Object.entries(setting.hooks || {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => (group.hooks || []).filter((hook) => hook.type === 'command').map((hook) => ({ event, command: hook.command })))));
  return Object.entries(ledger.enforcers).flatMap(([id, enforcer]) => {
    if (enforcer.kind !== 'hook') return [];
    const script = enforcer.ref.split('#')[0];
    if (commands.some(({ event, command }) => invokes(command, script, event))) return [];
    if (id === 'guard-git-push' && script === 'scripts/guard-git-push.mjs'
      && enforcer.registeredIn === '.githooks/pre-push') {
      try {
        if (invokes(readRegistration(enforcer.registeredIn), script)) return [];
      } catch { /* A missing registration file must fail with the enforcer diagnostic. */ }
    }
    return [`${id}: no command registration for ${script}`];
  });
}

describe('hook registration evidence (#4416)', () => {
  const registration = (command) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  const fixture = { enforcers: {
    project: { kind: 'hook', ref: 'scripts/project.mjs#symbol' },
    wrapper: { kind: 'hook', ref: 'scripts/wrapper.mjs' },
    'guard-git-push': { kind: 'hook', ref: 'scripts/guard-git-push.mjs', registeredIn: '.githooks/pre-push' },
    other: { kind: 'gate', ref: 'scripts/no-registration.mjs' },
  } };
  const pinned = "sh -c 'launcher=\"$HOME/workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs\"; [ -f \"$launcher\" ] || { echo \"Pinned guard: dedicated clone launcher missing; run scripts/hooks/sync-guard-clone.mjs\" >&2; exit 2; }; node \"$launcher\" scripts/project.mjs; code=$?; [ \"$code\" -eq 0 ] || exit 2'";
  const settings = [registration('node "scripts/project.mjs" --pre'), registration('node scripts/wrapper.mjs')];
  const read = (path) => {
    if (path !== '.githooks/pre-push') throw new Error('missing');
    return '#!/bin/sh\nprintf x | node scripts/guard-git-push.mjs "$@" || exit $?';
  };
  it('accepts project-only, wrapper-only, fragment refs and verified Git; ignores non-hooks', () => {
    expect(missingRegistrations(fixture, settings, read)).toEqual([]);
  });
  it('accepts the script argument after the pinned launcher', () => {
    expect(missingRegistrations(fixture, [registration(pinned), settings[1]], read)).toEqual([]);
  });
  it('accepts the script argument of the non-blocking Stop wrapper', () => {
    const stop = "sh -c 'launcher=\"$HOME/workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs\"; [ -f \"$launcher\" ] || { echo \"Pinned guard: dedicated clone launcher missing; run scripts/hooks/sync-guard-clone.mjs; stop guard skipped\" >&2; exit 1; }; exec node \"$launcher\" --stop-hook scripts/project.mjs'";
    expect(missingRegistrations(fixture, [registration(stop), settings[1]], read)).toEqual([]);
    expect(missingRegistrations(fixture, [registration(stop.replace('scripts/project.mjs', 'scripts/not-project.mjs')), settings[1]], read))
      .toEqual(['project: no command registration for scripts/project.mjs']);
    // Registered under PreToolUse, the non-blocking form is not a deny guard and does not count.
    const preToolUse = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: stop }] }] } };
    expect(missingRegistrations(fixture, [preToolUse, settings[1]], read))
      .toEqual(['project: no command registration for scripts/project.mjs']);
  });
  it.each([
    `echo ${pinned}`,
    pinned.replace('scripts/project.mjs;', 'scripts/not-project.mjs;'),
    pinned.replace('run-pinned-guard.mjs', 'other-launcher.mjs'),
    pinned.replace(' || exit 2', ''),
  ])('rejects incomplete or unrelated pinned registration: %s', (command) => {
    expect(missingRegistrations(fixture, [registration(command), settings[1]], read))
      .toEqual(['project: no command registration for scripts/project.mjs']);
  });
  it.each([0, 1])('detects removal of sole settings registration %i', (index) => {
    const mutated = structuredClone(settings);
    mutated[index].hooks.Stop[0].hooks = [];
    const id = index ? 'wrapper' : 'project';
    expect(missingRegistrations(fixture, mutated, read)).toEqual([`${id}: no command registration for scripts/${id}.mjs`]);
  });
  it.each([
    registration('node scripts/not-project.mjs'),
    registration('echo scripts/project.mjs'),
    registration('echo "example | node scripts/project.mjs"'),
    registration('echo example # node scripts/project.mjs'),
    registration('# node scripts/project.mjs'),
    { description: 'node scripts/project.mjs', hooks: {} },
    { hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'node scripts/project.mjs' }] }] } },
  ])('rejects wrong basename, prose, comments and non-command entries: %j', (bad) => {
    expect(missingRegistrations(fixture, [bad, settings[1]], read)).toEqual(['project: no command registration for scripts/project.mjs']);
  });
  it.each([undefined, '.githooks/missing', 'arbitrary-file'])('rejects missing or unapproved Git metadata %s', (registeredIn) => {
    const mutated = structuredClone(fixture);
    mutated.enforcers['guard-git-push'].registeredIn = registeredIn;
    expect(missingRegistrations(mutated, settings, read)).toEqual(['guard-git-push: no command registration for scripts/guard-git-push.mjs']);
  });
  it.each(['# node scripts/guard-git-push.mjs', 'echo scripts/guard-git-push.mjs', 'node scripts/not-guard-git-push.mjs', ''])('rejects absent Git invocation: %s', (text) => {
    expect(missingRegistrations(fixture, settings, () => text)).toEqual(['guard-git-push: no command registration for scripts/guard-git-push.mjs']);
  });
  it('rejects a nonexistent registration file', () => {
    expect(missingRegistrations(fixture, settings, () => { throw new Error('ENOENT'); })).toEqual(['guard-git-push: no command registration for scripts/guard-git-push.mjs']);
  });
  it('does not permit arbitrary hook enforcers to use the Git exception', () => {
    const mutated = structuredClone(fixture);
    mutated.enforcers.project.registeredIn = '.githooks/pre-push';
    expect(missingRegistrations(mutated, [settings[1]], () => 'node scripts/project.mjs\nnode scripts/guard-git-push.mjs'))
      .toEqual(['project: no command registration for scripts/project.mjs']);
  });
  it('verifies every committed hook against real project, delivery and Git registrations', () => {
    expect(missingRegistrations(loadLedger(), [
      JSON.parse(readFileSync(join(REPO_ROOT, '.claude/settings.json'), 'utf8')), DELIVERY_HOOKS_SETTINGS,
    ], (path) => readFileSync(join(REPO_ROOT, path), 'utf8'))).toEqual([]);
  });
});
const TEXT = [
  '# Fixture brief',
  'Never merge the PR.',
  'Always   reproduce the bug first.',
  'Do not release the lane, and do NOT merge.',
  "Don't rewrite a card through Bash.",
  'Plain guidance with no rule word.',
].join('\n');
const entry = (text) => ({ brief: BRIEF, key: lineKey(text), text });
const LEDGER = {
  enforcers: { merge: { kind: 'hook', ref: 'scripts/guard-bash.mjs' } },
  rules: [
    { id: 'never-merge', status: 'enforced', enforcers: ['merge'], lines: [entry('Never merge the PR.'), entry('Do not release the lane, and do NOT merge.')] },
    { id: 'no-release', status: 'prose-only', proposed: 'deny lane-pool release', lines: [entry('Do not release the lane, and do NOT merge.')] },
    { id: 'repro', status: 'judgment', lines: [entry('Always reproduce the bug first.')] },
  ],
};

describe('extractImperatives (#4070)', () => {
  it('finds every rule-word line, with 1-based line numbers and whitespace-normalised text', () => {
    const found = extractImperatives(TEXT);
    expect(found.map((l) => l.line)).toEqual([2, 3, 4, 5]);
    expect(found[1].text).toBe('Always reproduce the bug first.');
  });

  it('keys on normalised text, so re-wrapping whitespace keeps the key and a wording change does not', () => {
    expect(lineKey('Never  merge the PR. ')).toBe(lineKey('Never merge the PR.'));
    expect(lineKey('Never merge a PR.')).not.toBe(lineKey('Never merge the PR.'));
  });

  it('matches the curly-apostrophe prohibition and "before you"', () => {
    expect(extractImperatives('Don’t do it\nRead it before you build')).toHaveLength(2);
  });
});

describe('auditLedger (#4070)', () => {
  const result = auditLedger([{ brief: BRIEF, text: TEXT }], LEDGER);

  it('names the unlisted imperative line', () => {
    expect(result.unlisted.map((l) => l.line)).toEqual([5]);
    expect(result.unlisted[0].text).toMatch(/rewrite a card/);
  });

  it('counts a multi-rule line under its weakest rule', () => {
    const row = result.lines.find((l) => l.line === 4);
    expect(row.rules).toEqual(['never-merge', 'no-release']);
    expect(row.status).toBe('prose-only');
    expect(result.counts).toMatchObject({ enforced: 1, judgment: 1, 'prose-only': 1, unlisted: 1 });
  });

  it('reports a ledger line whose text is no longer in the brief as stale', () => {
    const edited = TEXT.replace('Never merge the PR.', 'Never merge any PR.');
    const r = auditLedger([{ brief: BRIEF, text: edited }], LEDGER);
    expect(r.stale.map((s) => s.rule)).toEqual(['never-merge']);
    expect(r.unlisted.map((l) => l.text)).toContain('Never merge any PR.');
  });

  it('orders statuses weakest first', () => {
    expect(weakestStatus(['enforced', 'judgment'])).toBe('judgment');
    expect(weakestStatus(['descriptive', 'enforced'])).toBe('enforced');
    expect(weakestStatus([])).toBe('unlisted');
  });
});

describe('validateLedger (#4070)', () => {
  it('accepts the fixture', () => {
    expect(validateLedger(LEDGER)).toEqual([]);
  });

  it('refuses an enforced rule with no enforcer, an unknown enforcer, and a prose-only rule with no proposal', () => {
    const errors = validateLedger({ enforcers: {}, rules: [
      { id: 'a', status: 'enforced', lines: [] },
      { id: 'b', status: 'enforced', enforcers: ['ghost'], lines: [] },
      { id: 'c', status: 'prose-only', lines: [] },
      { id: 'd', status: 'maybe', lines: [] },
    ] });
    expect(errors.join('\n')).toMatch(/a: enforced but names no enforcer/);
    expect(errors.join('\n')).toMatch(/b: unknown enforcer ghost/);
    expect(errors.join('\n')).toMatch(/c: prose-only but names no proposed enforcer/);
    expect(errors.join('\n')).toMatch(/d: status must be one of/);
  });
});

describe('the committed ledger (#4070)', () => {
  const ledger = loadLedger();

  it('is structurally valid and every enforcer file it cites exists', () => {
    expect(validateLedger(ledger)).toEqual([]);
    expect(missingEnforcerFiles(ledger)).toEqual([]);
  });

  it('covers the dispatched briefs under both skill directories', () => {
    const briefs = listBriefs();
    expect(briefs).toContain('skills-src/conveyor/delivery-agent-brief.md');
    expect(briefs).toContain('skills-src/review/review-agent-brief.md');
    expect(briefs.some((b) => b.endsWith('SKILL.md'))).toBe(false);
    expect(auditLedger(readBriefs(), ledger).lines.length).toBeGreaterThan(0);
  });

  // The three rules the 2026-09-24 incident broke. Each must stay enforced by a code enforcer that has a test.
  it.each([
    ['completion-record', 'guard-stop-completion-record'],
    ['card-edit-via-tools', 'guard-bash-card-shell-write'],
    ['no-wait-poll', 'guard-stop-passive-wait'],
  ])('%s is enforced by %s, which has a test on disk', (ruleId, enforcerId) => {
    const rule = ledger.rules.find((r) => r.id === ruleId);
    expect(rule.status).toBe('enforced');
    expect(rule.enforcers).toContain(enforcerId);
    expect(rule.lines.length).toBeGreaterThan(0);
    const enforcer = ledger.enforcers[enforcerId];
    expect(['hook', 'wrapper', 'gate']).toContain(enforcer.kind);
    expect(existsSync(join(REPO_ROOT, enforcer.test))).toBe(true);
  });
});
