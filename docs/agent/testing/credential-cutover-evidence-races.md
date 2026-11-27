## Credential-cutover evidence races

The Homebrew-pinned credential-cutover writer uses Darwin `O_NOFOLLOW_ANY`
(`0x20000000`) to reject symlinks in all path components at the actual open.
Do not combine it with `O_NOFOLLOW`: Darwin returns `EINVAL`. Other platforms
refuse persistence; rerun on a supported macOS host rather than falling back to
ancestor checks before a pathname open. The inventory suite swaps each ancestor
inside the injected open for both evidence sinks and checks that no outside
evidence file is created. Its skipped-ruleset-page case exercises live admission;
next links must advance exactly one page, even when omitted pages contain bypasses.

The unit suite mocks `node:os` platform detection and injects a filesystem open
adapter so the supported-writer cases run on Ubuntu CI too. Every create asserts
the exact Darwin flags and mode. On macOS the adapter delegates to the real kernel;
on other hosts it models symlink rejection after the injected ancestor swap.
That test-only walk is not proof of kernel atomicity and is never a production
fallback. Separate unsupported-platform cases assert `COHORT` and no evidence
open. Fixture directories use `os.tmpdir()` so an unset `TMPDIR` is supported.
