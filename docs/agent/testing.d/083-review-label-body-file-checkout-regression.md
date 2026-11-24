## Review label body-file checkout regression

Keep staging `root` separate from the label child's `cwd`: `--cwd` reaches the sinks through
`resolveOperation`. Test checkout A staging against checkout B's `bodyFileRoots`, with a separate
temp root so a host-temp fixture cannot hide the mismatch. The `review-label-body-child-cwd`
soak break probes the real sink to decide fix presence and checks private-copy cleanup. Its replay
and the unit regression inject hermetic IO via `resolveOperation`'s `sinkFactory`; only the
operation builder supplies `cwd`, so removing that forwarding must fail their existing assertions.

