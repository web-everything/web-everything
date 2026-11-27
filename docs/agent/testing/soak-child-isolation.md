## Soak child isolation

Native child processes spawned by a Vitest scenario do not run Vitest's setup.
Before importing policy readers, redirect both `os.userInfo().homedir` and
`os.homedir()` to fixture storage, set an explicit fixture
`WE_PLATFORM_PREFERENCES_FILE`, and use a fixture cwd. Return synthetic account
data rather than calling the real `userInfo()` and replacing only its home.
Keep process listings and live PR reads injected. The reserve-first-tick soak
uses this boundary while exercising the production CLI budget and reconciliation.

When a scenario accepts a source root, pass the test module's repository root
explicitly. Running Vitest from a temporary cwd must not change where the scenario
loads its implementation.
