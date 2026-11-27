## Credential-cutover evidence races

The Homebrew-pinned credential-cutover writer uses Darwin `O_NOFOLLOW_ANY`
(`0x20000000`) to reject symlinks in all path components at the actual open.
Do not combine it with `O_NOFOLLOW`: Darwin returns `EINVAL`. Other platforms
refuse persistence; rerun on a supported macOS host rather than falling back to
ancestor checks before a pathname open. The inventory suite swaps each ancestor
inside the injected open for both evidence sinks and checks that no outside
evidence file is created. Its skipped-ruleset-page case exercises live admission;
next links must advance exactly one page, even when omitted pages contain bypasses.
