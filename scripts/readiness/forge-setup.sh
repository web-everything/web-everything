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
                                    ("forge-cache", 0, ops.pw_gid, 0o770),
                                    ("forge-base", ops.pw_uid, ops.pw_gid, 0o700)]:
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
        # Bundle only this fixed, explicitly allowlisted source graph. All
        # installed imports resolve to node builtins, including on Node 22.1.
        import re, json
        source_dir = os.path.dirname(sys.argv[1])
        allowed = {"forge-exec-run.mjs", "forge-exec-siblings.mjs", "forge-exec-manifest.mjs", "forge-exec-bases.mjs", "forge-warm-base.mjs"}
        def bundle(filename, nested=False):
            if filename not in allowed:
                raise RuntimeError("unexpected wrapper dependency")
            srcfd = os.open(os.path.join(source_dir, filename), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(srcfd, "r") as src:
                code = src.read()
            code = re.sub(r"^#![^\n]*\n", "", code)
            if nested:
                code = code.split("\nif(process.argv[1]", 1)[0]
            exports = re.findall(r"export (?:async )?function (\w+)|export const (\w+)", code)
            names = [a or b for a, b in exports]
            for group in re.findall(r"export \{([^}]+)\};", code):
                names.extend(n.strip() for n in group.split(","))
            code = re.sub(r"export \{[^}]+\};", "", code)
            code = re.sub(r"\bexport (?=(?:async )?function |const )", "", code)
            def dependency(match):
                binding, spec = match.groups()
                if spec.startswith("node:"):
                    value = "await import(" + json.dumps(spec) + ")"
                elif spec.startswith("./"):
                    value = bundle(spec[2:], True)
                else:
                    raise RuntimeError("non-builtin external dependency")
                binding = binding.strip()
                if binding.startswith("* as "):
                    binding = binding[5:]
                return "const " + binding + " = " + value + ";"
            code = re.sub(r"import\s+([^;]+?)\s+from\s+['\"]([^'\"]+)['\"];", dependency, code)
            if nested:
                return "(await (async () => {\n" + code + "\nreturn {" + ",".join(dict.fromkeys(names)) + "};\n})())"
            return "#!/usr/bin/env node\n" + code
        for filename in ["forge-exec-run.mjs", "forge-warm-base.mjs"]:
            name = ".forge-exec-run-" + secrets.token_hex(16)
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700, dir_fd=dest)
            try:
                with os.fdopen(fd, "w", closefd=False) as out:
                    out.write(bundle(filename))
                    out.flush()
                os.fchown(fd, 0, 0)
                os.fchmod(fd, 0o755)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(name, filename, src_dir_fd=dest, dst_dir_fd=dest)
    finally:
        os.close(dest)
finally:
    os.close(parent)
WRAPPER
# Ops owns the public bare repository. No remote configuration or credentials
# are copied from the Mac; each tick supplies the public HTTPS URL explicitly.
sudo -n -u ops env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c credential.helper= init --bare /srv/forge-base/repo.git
# git init under ops' umask 002 makes group-writable dirs; bases refuse those.
chmod -R go-w /srv/forge-base
cat > /etc/systemd/system/forge-warm-base.service <<'SERVICE'
[Unit]
Description=Prepare anonymous public Web Everything bases
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=ops
UMask=0022
ExecStart=/usr/bin/flock -n /srv/forge-base/.tick.lock /usr/local/libexec/forge-warm-base.mjs
TimeoutStartSec=20min
SERVICE
cat > /etc/systemd/system/forge-warm-base.timer <<'TIMER'
[Unit]
Description=Refresh public Forge bases every 30 seconds
[Timer]
OnCalendar=*-*-* *:*:00,30
Persistent=true
AccuracySec=1s
Unit=forge-warm-base.service
[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now forge-warm-base.timer
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
