import { describe, it, expect } from 'vitest';
import { canonicalRemote, classifyPushFailure } from '../verdict-ledger-git.mjs';

describe('remote identity + push verdict', () => {
  it('only git\'s per-ref status line classifies a failed push; incidental text proves nothing (round 4)', () => {
    const REF = 'refs/heads/ops/review-requests';
    const err = (stdout, stderr = '') => Object.assign(new Error(`git push failed: ${stderr}`), { stdout, stderr });
    expect(classifyPushFailure(err(`To o\n!\tabc:${REF}\t[rejected] (fetch first)\nDone\n`), REF)).toBe('race');
    expect(classifyPushFailure(err(`To o\n!\tabc:${REF}\t[remote rejected] (pre-receive hook declined)\nDone\n`), REF)).toBe('refused');
    // Status-SHAPED prose on stderr, or a record for ANOTHER ref, proves nothing about ours.
    expect(classifyPushFailure(err('', 'remote: notice: ! [remote rejected] diagnostic -> another-ref (hook declined)\nfatal: the remote end hung up unexpectedly\n'), REF)).toBe('unknown');
    expect(classifyPushFailure(err(`!\tabc:refs/heads/other\t[rejected] (fetch first)\n`), REF)).toBe('unknown');
    expect(classifyPushFailure(err('', 'fatal: unable to access remote\n'), REF)).toBe('unknown');
    // `[remote failure]` = the remote never confirmed: UNKNOWN, never a refusal (round 6).
    expect(classifyPushFailure(err(`!\tabc:${REF}\t[remote failure] (remote failed to report status)\n`), REF)).toBe('unknown');
    // One identity per remote endpoint, however it is spelled...
    expect(canonicalRemote('https://GitHub.com/web-everything/web-everything.git')).toBe(canonicalRemote('git@github.com:web-everything/web-everything'));
    expect(canonicalRemote('ssh://git@github.com:22/web-everything/web-everything/')).toBe(canonicalRemote('https://github.com/web-everything/web-everything'));
    // ...and never two different endpoints as one (round 6).
    expect(canonicalRemote('ssh://git@host:2222/team/repo.git')).not.toBe(canonicalRemote('ssh://git@host:3333/team/repo.git'));
    expect(canonicalRemote('ssh://git@host/team/Repo.git')).not.toBe(canonicalRemote('ssh://git@host/team/repo.git'));
    expect(canonicalRemote('/srv/repos/example')).not.toBe(canonicalRemote('/srv/repos/example.git'));
    expect(canonicalRemote('../origin.git', '/a/board')).toBe(canonicalRemote('/a/origin.git'));
    // Round 7: on a generic host, home-relative and absolute SSH paths are DIFFERENT repositories...
    expect(canonicalRemote('host:repo.git')).not.toBe(canonicalRemote('ssh://host/repo.git'));
    expect(canonicalRemote('host:/repo.git')).toBe(canonicalRemote('ssh://host/repo.git'));
    expect(canonicalRemote('host:/repo.git').startsWith('file:')).toBe(false);
    // ...while a flat-namespace provider folds them.
    expect(canonicalRemote('git@github.com:o/r.git')).toBe(canonicalRemote('ssh://git@github.com/o/r'));
    // Round 8: on a generic host, different users' homes and `repo` vs `repo.git` stay distinct.
    expect(canonicalRemote('alice@host:repo.git')).not.toBe(canonicalRemote('bob@host:repo.git'));
    expect(canonicalRemote('ssh://host/srv/repo')).not.toBe(canonicalRemote('ssh://host/srv/repo.git'));
    // Round 9: git's `ssh://user@host/~/path` is home-relative too, and the same repo as its scp spelling.
    expect(canonicalRemote('ssh://alice@gitbox/~/repo.git')).not.toBe(canonicalRemote('ssh://bob@gitbox/~/repo.git'));
    expect(canonicalRemote('ssh://alice@gitbox/~/repo.git')).toBe(canonicalRemote('alice@gitbox:repo.git'));
    expect(canonicalRemote('https://gitbox/srv/repo')).not.toBe(canonicalRemote('ssh://gitbox/srv/repo'));
    // Round 10: explicit tildes are kept as written: `~/x` and `~/~/x` differ; scp and URI spellings agree.
    expect(canonicalRemote('alice@gitbox:~/repo.git')).not.toBe(canonicalRemote('ssh://alice@gitbox/~/~/repo.git'));
    expect(canonicalRemote('alice@gitbox:~/repo.git')).toBe(canonicalRemote('ssh://alice@gitbox/~/repo.git'));
    expect(canonicalRemote('alice@gitbox:repo.git')).toBe(canonicalRemote('alice@gitbox:~/repo.git'));
    expect(canonicalRemote('alice@gitbox:~bob/repo.git')).toBe(canonicalRemote('ssh://alice@gitbox/~bob/repo.git'));
    expect(canonicalRemote('alice@gitbox:~bob/repo.git')).not.toBe(canonicalRemote('alice@gitbox:~/repo.git'));
    // Round 11: http and https are different endpoints; a named home is the same whoever logs in.
    expect(canonicalRemote('http://gitbox/srv/repo')).not.toBe(canonicalRemote('https://gitbox/srv/repo'));
    expect(canonicalRemote('alice@gitbox:~shared/repo.git')).toBe(canonicalRemote('bob@gitbox:~shared/repo.git'));
    // Several push destinations: one rejected, one accepted -> never a verdict.
    expect(classifyPushFailure(err(`!\tabc:${REF}\t[rejected] (fetch first)\n*\tabc:${REF}\t[new branch]\n`), REF)).toBe('unknown');
    expect(classifyPushFailure(err(`!\tabc:${REF}\t[rejected] (fetch first)\n!\tabc:${REF}\t[remote rejected] (hook declined)\n`), REF)).toBe('refused');
  });
});
