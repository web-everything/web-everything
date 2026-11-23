# Historical change-evidence principals

The #7289 cases in `scripts/lib/__tests__/change-evidence-writer.test.mjs` and
`scripts/lib/__tests__/change-evidence-sendbacks.test.mjs` pin automation and operator
logins with `vi.hoisted` before importing the writer. Shared marker authorship captures
its roster at import time, while the global test setup sets
`WE_DELIVERY_IDENTITY=none` to disable configured production App roles.

Keep the real trust helper and the explicit environment-override negative case.
Historical fixtures must declare their principals independently of the current
production App configuration; mocking the author check would hide trust regressions.
