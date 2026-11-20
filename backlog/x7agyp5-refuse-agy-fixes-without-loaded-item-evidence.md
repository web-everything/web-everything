---
kind: story
status: open
size: 2
dateOpened: "2026-11-20"
scope: ['we:scripts/operations/fix-run.mjs', 'we:scripts/operations/__tests__/fix-run.test.mjs', 'we:scripts/lib/agy-fix-admission.mjs', 'we:scripts/lib/__tests__/agy-fix-admission.test.mjs']
tags: [security, agent-infrastructure]
---

# Refuse agy repair admission without loaded item evidence

PR #7134's 2026-11-20 security advisory found that manual Antigravity repair invocations without an item number substitute an empty object, allowing launch argv to stand in for missing item-level criticality and scope. Require a declared item and successfully loaded evidence before deriving repair admission. The dispatcher normally supplies the item; direct CLI callers must fail closed too.

## Acceptance

- [A1] Planned `refuses antigravity without num before admission` in `we:scripts/operations/__tests__/fix-run.test.mjs`: supply doc-fix, size 1 and docs scope but omit `--num`; assert missing-item refusal and zero worker launches. Use an injected prototype provider so the unrelated production-unavailable guard cannot mask the missing-item branch.
- [A2] Planned `refuses antigravity with unreadable or empty item evidence` in the same file parameterizes thrown reads, null, empty and malformed item records; assert no successful admission or worker launch. A valid loaded item remains subject to scope intersection, item criticality, tags, human-required status and risk. Include a narrower item scope and a critical item with benign launch argv.
- [A3] Planned `retains non-antigravity no-item repair behavior` in the same file verifies other provider branches retain their documented no-item semantics. Run `npm run test:unit -- <test-files>` using the repository-relative paths after the `we:` prefix of that file and `we:scripts/lib/__tests__/agy-fix-admission.test.mjs`.

Cases are planned, not implemented. Preserve the production unavailable gate and existing routing fallback. Validate manual and dispatched calls, explicit/default provider selection and item-loader error paths; do not treat a broad launch scope as evidence that an item was loaded.
