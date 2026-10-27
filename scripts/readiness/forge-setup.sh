#!/bin/bash
set -euo pipefail

if ! id forge-exec >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /srv/forge-exec --shell /bin/bash forge-exec
fi
if ! command -v python3 >/dev/null 2>&1; then
  apt-get install -y python3
fi
# Keep the parent and cache root-owned. The sticky parent permits run creation,
# but forge-exec cannot rename the cache to redirect a later privileged rerun.
# Pin each directory with a no-follow descriptor; never chown/chmod user paths.
python3 - <<'DIRECTORIES'
import grp
import os
import stat

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
gid = grp.getgrnam("forge-exec").gr_gid
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
            os.fchmod(cache, 0o2770)
        finally:
            os.close(cache)
        os.fchmod(root, stat.S_ISVTX | 0o770)
    finally:
        os.close(root)
finally:
    os.close(with_parent)
DIRECTORIES
# ops uses passwordless sudo -u forge-exec; no additional group privileges are needed.
if ! command -v rsync >/dev/null 2>&1; then
  apt-get install -y rsync
fi

cat > /etc/cron.daily/forge-exec-prune <<'PRUNE'
#!/bin/bash
set -euo pipefail
find /srv/forge-exec -mindepth 1 -maxdepth 1 -type d ! -name '.cache' -mmin +1440 -exec rm -rf -- {} +
find /srv/forge-exec/.cache -mindepth 1 -maxdepth 1 -type d -mmin +20160 -exec rm -rf -- {} +
PRUNE
chown root:root /etc/cron.daily/forge-exec-prune
chmod 755 /etc/cron.daily/forge-exec-prune
printf 'forge-setup: ok\n'
