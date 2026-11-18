---
bornAs: xdambes
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-api-reads.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-11-18"
tags: []
---

# Origin slug parser accepts spoofed https hosts via the login part

we:scripts/lib/drain-api-reads.mjs#readOriginSlug accepts any https login part matching [^@/]+@, so an origin like https://evil.example#@github.com/o/r (also ?@ and backslash-@, or whitespace inside the login part) parses as a github.com owner/repo although URL parsers end the real host at #, ? or backslash. Found by the PR 7012 self-review; the same parser in we:scripts/operations/review-job.mjs was fixed there by limiting the login part to RFC 3986 userinfo characters. Apply the same restriction here and pin each spoof form as refused (origin-unparseable).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- scripts/lib/__tests__/drain-api-reads*.test.mjs` with new cases asserting `readOriginSlug` throws `origin-unparseable` for `https://evil.example#@github.com/o/r`, `?@`, backslash-`@` and a login part with a space or newline; fails before (they parse as `o/r`), passes after.
- [A2] **Must** — an https origin whose login part is an access-token user name plus token (RFC 3986 userinfo characters only) still parses as `o/r`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not widen the accepted URL forms (no `git+ssh://`, no ssh-config host aliases).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the origin URL is lane-controlled text: restrict the login part to RFC 3986 userinfo characters so `#`, `?`, backslash and whitespace cannot end the host early.
2. **Truncated reads** — n/a: one `git remote get-url` line, already bounded.
3. **Shared state files** — the slug cache keys on cwd and remote; a refused origin must not be cached.
4. **Fail closed** — any non-matching origin throws `origin-unparseable`, as today.
5. **Identity scoping** — the parsed slug must name the real host's repository, never a lookalike.
6. **State over time** — n/a: no persisted state changes.
7. **Who wrote it** — n/a: the origin is evidence, not a trusted marker.
