#!/bin/bash
set -euo pipefail

if ! id forge-exec >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /srv/forge-exec --shell /bin/bash forge-exec
fi
if ! command -v python3 >/dev/null 2>&1; then
  apt-get install -y python3
fi
# Only ops may create run containers. The legacy task-writable cache is inert.
# Pin each directory with a no-follow descriptor; never chown/chmod user paths.
python3 - <<'DIRECTORIES'
import grp
import pwd
import os
import stat

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
gid = grp.getgrnam("forge-exec").gr_gid
ops = pwd.getpwnam("ops")
with_parent = os.open("/srv", flags)
try:
    parent = os.fstat(with_parent)
    if parent.st_uid != 0 or parent.st_mode & 0o022:
        raise RuntimeError("forge-setup: /srv must be root-owned and not writable by others")
    try:
        os.mkdir("forge-exec", 0o700, dir_fd=with_parent)
    except FileExistsError:
        pass
    root = os.open("forge-exec", flags, dir_fd=with_parent)
    try:
        # Revoke the old owner's ability to chmod, then stop all entry replacement
        # before inspecting the cache. Both changes act on the pinned inode.
        os.fchown(root, 0, gid)
        os.fchmod(root, 0o700)
        try:
            os.mkdir(".cache", 0o700, dir_fd=root)
        except FileExistsError:
            pass
        cache = os.open(".cache", flags, dir_fd=root)
        try:
            os.fchown(cache, 0, gid)
            os.fchmod(cache, 0o700)
        finally:
            os.close(cache)
        os.fchown(root, ops.pw_uid, ops.pw_gid)
        os.fchmod(root, 0o755)
    finally:
        os.close(root)
    for name, uid, group, mode in [("forge-receipts", ops.pw_uid, ops.pw_gid, 0o700),
                                    ("forge-cache", 0, ops.pw_gid, 0o770)]:
        try:
            os.mkdir(name, 0o700, dir_fd=with_parent)
        except FileExistsError:
            pass
        fd = os.open(name, flags, dir_fd=with_parent)
        try:
            os.fchown(fd, uid, group)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)
finally:
    os.close(with_parent)
DIRECTORIES
# ops uses passwordless sudo -u forge-exec; no additional group privileges are needed.
if ! command -v rsync >/dev/null 2>&1; then
  apt-get install -y rsync
fi

# Sibling manifests require redeploying this wrapper with forge-setup.sh on Forge.
# Clients require prepare.capabilities.siblings=1 before sending any sibling bytes.
# Publish the fixed wrapper through a root-owned pinned directory. Never follow
# a pre-existing destination symlink or mutate task-controlled paths.
python3 - "$(dirname -- "$0")/forge-exec-run.mjs" <<'WRAPPER'
import os, sys, secrets
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
parent = os.open("/usr/local", flags)
try:
    st = os.fstat(parent)
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError("untrusted /usr/local")
    try:
        os.mkdir("libexec", 0o755, dir_fd=parent)
    except FileExistsError:
        pass
    dest = os.open("libexec", flags, dir_fd=parent)
    try:
        st = os.fstat(dest)
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError("untrusted libexec")
        source = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
        try:
            name = ".forge-exec-run-" + secrets.token_hex(16)
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700, dir_fd=dest)
            try:
                with os.fdopen(source, "rb", closefd=False) as src:
                    with os.fdopen(fd, "wb", closefd=False) as out:
                        # Keep the installed runner standalone (including Node 22.1).
                        # The same data-only constant is imported by vitest.shared.ts.
                        module = os.open(os.path.join(os.path.dirname(sys.argv[1]), "forge-exec-siblings.mjs"), os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(module, "rb") as data:
                            constants = data.read()
                        code = src.read()
                        binding = b"import {SIBLING_PATHS} from './forge-exec-siblings.mjs';\nexport {SIBLING_PATHS};"
                        if code.count(binding) != 1:
                            raise RuntimeError("missing sibling allowlist binding")
                        out.write(code.replace(binding, constants))
                        out.flush()
                os.fchown(fd, 0, 0)
                os.fchmod(fd, 0o755)
                os.fsync(fd)
            finally:
                os.close(fd)
            # Preserve explicit ESM resolution on Node 22.1 outside a package.
            os.rename(name, "forge-exec-run.mjs", src_dir_fd=dest, dst_dir_fd=dest)
        finally:
            os.close(source)
    finally:
        os.close(dest)
finally:
    os.close(parent)
WRAPPER
cat > /etc/cron.daily/forge-exec-prune <<'PRUNE'
#!/bin/bash
set -euo pipefail
# Trusted roots cannot be replaced by the task. find does not follow symlinks.
# worker-active is a protected directory, deliberately excluded from receipt
# pruning. After interrupted execution, stop ALL forge-exec processes before
# manually removing /srv/forge-receipts/worker-active; never expire it by age.
find /srv/forge-exec -mindepth 1 -maxdepth 1 -type d -name 'r-*' -mmin +1440 -exec rm -rf -- {} +
find /srv/forge-receipts -mindepth 1 -maxdepth 1 -type f -mmin +1440 -delete
find /srv/forge-cache -mindepth 1 -maxdepth 1 -type d -mmin +20160 -exec rm -rf -- {} +
PRUNE
chown root:root /etc/cron.daily/forge-exec-prune
chmod 755 /etc/cron.daily/forge-exec-prune
printf 'forge-setup: ok\n'
