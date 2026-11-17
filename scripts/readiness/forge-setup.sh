#!/bin/bash
# Creates (idempotently; run only on Forge):
# - system user/group forge-exec (legacy) and forge-exec-1..FORGE_EXEC_SLOTS
#   (default 8), each slot user with its own group and no shared membership;
# - /srv/forge-exec ops:ops 0755, legacy .cache root:forge-exec 0700;
# - /srv/forge-exec/slot-K ops:forge-exec-K 0710 (worker traverse only);
#   run containers stay operator-owned, only work/sibling trees are handed over;
# - /srv/forge-receipts ops:ops 0700, /srv/forge-cache root:ops 0770,
#   /srv/forge-base ops:ops 0700 and its anonymous public bare repo.git;
# - /usr/local/libexec root:root 0755 and bundled root:root 0755 wrappers
#   forge-exec-run.mjs, forge-warm-base.mjs, forge-exec-limits.mjs, forge-cache-prune.mjs
#   and forge-exec-sweep.mjs;
# - /etc/forge-exec/limits.json root:root 0644 (created only if absent),
#   persistent parent/slot systemd slices with live resource ceilings;
# - /etc/sudoers.d/forge-exec root:root 0440 with these exact forms:
#   ops ALL=(forge-exec-1,...,forge-exec-N) NOPASSWD: /usr/bin/rsync
#   ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs
#   ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs *
# - root-owned forge-warm-base systemd service/timer (service runs as ops,
#   timer every 30s); the legacy forge-exec-prune cron job is removed;
# - forge-cache-prune.service/timer: root oneshot cache retention, 2min after
#   boot then every 15min, idle IO/low CPU priority;
# - forge-exec-sweep.service/timer: root oneshot run/presync/receipt retention,
#   5min after boot then every 30min, idle IO/low CPU priority;
#   also reclaims reservations older than 7 days under the writer lease, only
#   with writerGuard evidence and proof the worker UID has no processes;
# - R497 egress: slot users forge-exec-1..N get no outbound network except loopback and
#   TCP 443 to registry.npmjs.org (cold npm ci runs as the slot user). Rules come from
#   /usr/local/libexec/forge-egress.sh (nft table inet forge_exec_egress), refreshed every
#   5 min by forge-exec-egress.timer. ssh.service gets a drop-in (ssh.service.d/forge-egress.conf) that
#   Requires= the egress service, so sshd refuses to start when the table could not be applied. Rollback, in
#   this order (drop-in first: with it in place, stopping the egress service can stop sshd):
#   rm -f /etc/systemd/system/ssh.service.d/forge-egress.conf;
#   systemctl daemon-reload;
#   nft delete table inet forge_exec_egress;
#   systemctl disable --now forge-exec-egress.timer forge-exec-egress.service;
# - installs python3, rsync and nftables if missing. Never prunes active slot locks.
set -euo pipefail

FORGE_EXEC_SLOTS=${FORGE_EXEC_SLOTS:-8}
if [[ ! "$FORGE_EXEC_SLOTS" =~ ^[1-9][0-9]*$ ]] || (( FORGE_EXEC_SLOTS > 128 )); then
  echo 'forge-setup: FORGE_EXEC_SLOTS must be 1..128' >&2
  exit 1
fi
export FORGE_EXEC_SLOTS
for existing in /srv/forge-exec/slot-*; do
  if [[ "$existing" =~ /slot-([1-9][0-9]*)$ ]] && (( BASH_REMATCH[1] > FORGE_EXEC_SLOTS )); then
    echo 'forge-setup: cannot shrink an installed pool; retain its slot count and inspect reservations' >&2
    exit 1
  fi
done
if ! id forge-exec >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /srv/forge-exec --shell /bin/bash forge-exec
fi
for ((k=1; k<=FORGE_EXEC_SLOTS; k++)); do
  if ! id "forge-exec-$k" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "/srv/forge-exec/slot-$k" --shell /bin/bash "forge-exec-$k"
  fi
done
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
        identities = set()
        groups = set()
        for k in range(1, int(os.environ["FORGE_EXEC_SLOTS"]) + 1):
            worker = pwd.getpwnam("forge-exec-" + str(k))
            group = grp.getgrnam("forge-exec-" + str(k))
            if worker.pw_uid in {0, ops.pw_uid, pwd.getpwnam("forge-exec").pw_uid} or worker.pw_gid != group.gr_gid or worker.pw_uid in identities or group.gr_gid in groups:
                raise RuntimeError("invalid or shared worker identity")
            if group.gr_mem or worker.pw_gid in os.getgrouplist("ops", ops.pw_gid):
                raise RuntimeError("slot groups must be private")
            if set(os.getgrouplist("forge-exec-" + str(k), worker.pw_gid)) != {worker.pw_gid}:
                raise RuntimeError("slot users must not have supplementary groups")
            identities.add(worker.pw_uid)
            groups.add(group.gr_gid)
            name = "slot-" + str(k)
            try:
                os.mkdir(name, 0o700, dir_fd=root)
            except FileExistsError:
                pass
            slot = os.open(name, flags, dir_fd=root)
            try:
                # Revoke the worker's ability to replace metadata entries.
                # Pinning this inode also upgrades an old worker-owned slot.
                os.fchown(slot, ops.pw_uid, worker.pw_gid)
                os.fchmod(slot, 0o710)
            finally:
                os.close(slot)
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
# Explicit Runas list: never grant a wildcard worker identity or arbitrary commands.
sudoers_pending=$(mktemp /etc/sudoers.d/.forge-exec.XXXXXXXX)
trap 'rm -f -- "$sudoers_pending"' EXIT
{
  printf 'ops ALL=('
  for ((k=1; k<=FORGE_EXEC_SLOTS; k++)); do
    ((k == 1)) || printf ','
    printf 'forge-exec-%s' "$k"
  done
  printf ') NOPASSWD: /usr/bin/rsync\n'
  printf 'ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs\n'
  printf 'ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs *\n'
} > "$sudoers_pending"
visudo -cf "$sudoers_pending"
chown root:root "$sudoers_pending"
chmod 440 "$sudoers_pending"
mv -f -- "$sudoers_pending" /etc/sudoers.d/forge-exec
trap - EXIT
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
        allowed = {"forge-exec-run.mjs", "forge-exec-siblings.mjs", "forge-exec-manifest.mjs", "forge-exec-bases.mjs", "forge-warm-base.mjs", "forge-exec-limits.mjs", "forge-cache-prune.mjs", "forge-exec-sweep.mjs"}
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
        installed = ["forge-exec-run.mjs", "forge-warm-base.mjs", "forge-exec-limits.mjs", "forge-cache-prune.mjs", "forge-exec-sweep.mjs"]
        for filename in installed:
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
        # S0: record the source graph and actual installed bytes, without automation.
        import hashlib, subprocess
        from datetime import datetime
        from zoneinfo import ZoneInfo
        set_sha = None
        try:
            checkout = os.path.abspath(os.path.join(source_dir, "../.."))
            result = subprocess.run(["git", "-C", checkout, "log", "-1", "--format=%H", "HEAD", "--"] +
                                    ["scripts/readiness/" + name for name in sorted(allowed)],
                                    check=True, capture_output=True, text=True, timeout=10)
            candidate = result.stdout.strip()
            if not re.fullmatch(r"[a-f0-9]{40}", candidate):
                raise ValueError("invalid set sha")
            set_sha = candidate
        except (OSError, subprocess.SubprocessError, ValueError):
            print("forge-setup: installed set git SHA unavailable; recording null", file=sys.stderr)
        digest = hashlib.sha256()
        for filename in sorted(installed):
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dest)
            with os.fdopen(fd, "rb") as stream:
                file_hash = hashlib.sha256(stream.read()).hexdigest()
            digest.update((filename + "\0" + file_hash + "\n").encode())
        state = {"schema": 1, "forgeSetSha": set_sha, "setDigest": digest.hexdigest(), "hostTier": 1,
                 "installedAtET": datetime.now(ZoneInfo("America/New_York")).isoformat(timespec="milliseconds")}
        state_parent = os.open("/var/lib", flags)
        try:
            st = os.fstat(state_parent)
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise RuntimeError("untrusted /var/lib")
            try:
                os.mkdir("forge-deploy", 0o755, dir_fd=state_parent)
            except FileExistsError:
                pass
            state_dir = os.open("forge-deploy", flags, dir_fd=state_parent)
            try:
                st = os.fstat(state_dir)
                if st.st_uid != 0 or st.st_mode & 0o022:
                    raise RuntimeError("untrusted forge-deploy directory")
                os.fchown(state_dir, 0, 0)
                os.fchmod(state_dir, 0o755)
                pending = ".state-" + secrets.token_hex(16)
                try:
                    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state_dir)
                    with os.fdopen(fd, "w") as stream:
                        json.dump(state, stream)
                        stream.write("\n")
                        stream.flush()
                        os.fchown(stream.fileno(), 0, 0)
                        os.fchmod(stream.fileno(), 0o644)
                        os.fsync(stream.fileno())
                    os.rename(pending, "state.json", src_dir_fd=state_dir, dst_dir_fd=state_dir)
                    os.fsync(state_dir)
                finally:
                    try:
                        os.unlink(pending, dir_fd=state_dir)
                    except FileNotFoundError:
                        pass
            finally:
                os.close(state_dir)
        finally:
            os.close(state_parent)
    finally:
        os.close(dest)
finally:
    os.close(parent)
WRAPPER
# Operator tuning (live, no code deploy):
# edit /etc/forge-exec/limits.json, then:
#   sudo /usr/local/libexec/forge-exec-limits.mjs apply
# Direct persistent tuning is also possible:
#   sudo systemctl set-property forge-exec-3.slice CPUQuota=1600%
# A subsequent apply projects limits.json again, replacing direct property edits.
python3 - <<'LIMITS'
import os, stat
try:
    os.mkdir('/etc/forge-exec', 0o755)
except FileExistsError:
    pass
directory = os.open('/etc/forge-exec', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    st = os.fstat(directory)
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('untrusted limits directory')
    os.fchown(directory, 0, 0)
    os.fchmod(directory, 0o755)
    try:
        fd = os.open('limits.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    except FileExistsError:
        pass  # Operator edits are never overwritten.
    else:
        with os.fdopen(fd, 'w') as stream:
            stream.write('{"parent":{"cpuQuota":"2800%","memoryMax":"56G"},"slot":{"cpuQuota":"800%","memoryMax":"12G","tasksMax":2048,"ioWeight":100},"slots":{}}\n')
            stream.flush()
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o644)
finally:
    os.close(directory)
LIMITS
/usr/local/libexec/forge-exec-limits.mjs apply
systemctl daemon-reload
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
# Required cache settings (explicit service environment, logged with provenance):
# FORGE_CACHE_MAX_AGE_HOURS=12 (clamped 6..24), FORGE_CACHE_MAX_BYTES=214748364800,
# FORGE_CACHE_HIGH_WATER_PCT=80 (0..100; reclaim to five percentage points below).
# Minimum age is always at least one hour. Edit the Environment= values below
# (or override in a service drop-in), then daemon-reload. Missing/invalid settings
# refuse all pruning; restore valid values before retrying. Incomplete evidence refuses
# deletion: inspect/repair reservations and records before retrying the service.
# The pruner uses the existing /usr/bin/flock utility to hold all numbered and
# legacy reservation writer leases through evidence reads and anchored deletion.
cat > /etc/systemd/system/forge-cache-prune.service <<'CACHE_SERVICE'
[Unit]
Description=Prune expired Forge dependency cache profiles
After=local-fs.target
[Service]
Type=oneshot
User=root
Environment=FORGE_CACHE_MAX_AGE_HOURS=12
Environment=FORGE_CACHE_MAX_BYTES=214748364800
Environment=FORGE_CACHE_HIGH_WATER_PCT=80
ExecStart=/usr/bin/env node /usr/local/libexec/forge-cache-prune.mjs --apply
Nice=19
IOSchedulingClass=idle
CACHE_SERVICE
cat > /etc/systemd/system/forge-cache-prune.timer <<'CACHE_TIMER'
[Unit]
Description=Check Forge cache retention every 15 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
AccuracySec=1min
Persistent=false
Unit=forge-cache-prune.service
[Install]
WantedBy=timers.target
CACHE_TIMER
systemctl daemon-reload
systemctl enable --now forge-cache-prune.timer
rm -f /etc/cron.daily/forge-exec-prune
cat > /etc/systemd/system/forge-exec-sweep.service <<'SWEEP_SERVICE'
[Unit]
Description=Prune expired Forge runs, presync keys and receipts
After=local-fs.target
[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/env node /usr/local/libexec/forge-exec-sweep.mjs --apply
Nice=19
IOSchedulingClass=idle
SWEEP_SERVICE
cat > /etc/systemd/system/forge-exec-sweep.timer <<'SWEEP_TIMER'
[Unit]
Description=Check Forge execution retention every 30 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
AccuracySec=1min
Persistent=false
Unit=forge-exec-sweep.service
[Install]
WantedBy=timers.target
SWEEP_TIMER
systemctl daemon-reload
systemctl enable --now forge-exec-sweep.timer
# R497: no egress for slot users. Root-owned script, installed via temp + atomic rename.
if ! command -v nft >/dev/null 2>&1; then
  apt-get install -y nftables
fi
egress_pending=$(mktemp /usr/local/libexec/.forge-egress.XXXXXX)
install -o root -g root -m 0755 "$(dirname -- "$0")/forge-egress.sh" "$egress_pending"
mv -f -- "$egress_pending" /usr/local/libexec/forge-egress.sh
cat > /etc/systemd/system/forge-exec-egress.service <<EGRESS
[Unit]
Description=Drop outbound network for Forge slot users (registry allowlist only)
# Before sshd so no run can start on a rebooted Forge before the table exists. At boot the registry usually
# does not resolve yet: the table installs CLOSED (no registry) and the timer opens the allowlist after 1 min.
Before=ssh.socket ssh.service sshd.service
DefaultDependencies=no
# Only local-fs.target: any After= on a unit behind sockets.target (systemd-user-sessions, network-online) would
# loop with Before=ssh.socket. Slot users are local accounts, so nothing later is needed to look them up.
After=local-fs.target
[Service]
Type=oneshot
Environment=FORGE_EXEC_SLOTS=$FORGE_EXEC_SLOTS
ExecStart=/usr/local/libexec/forge-egress.sh apply
[Install]
WantedBy=multi-user.target
EGRESS
# Fail closed: Before= only orders startup. Requires= makes ssh refuse to start when the egress apply failed,
# so a Forge whose table is missing accepts no slot commands. Ubuntu starts sshd through ssh.socket, which is
# why the unit above is also ordered Before=ssh.socket. The drop-in is read once at start; the 5-minute timer
# re-running the oneshot does not stop or restart an sshd that is already up. Rollback (see the header) removes this
# drop-in and reloads BEFORE stopping the egress service; otherwise Requires= would stop sshd with it.
mkdir -p /etc/systemd/system/ssh.service.d
cat > /etc/systemd/system/ssh.service.d/forge-egress.conf <<'SSHDROPIN'
[Unit]
Requires=forge-exec-egress.service
After=forge-exec-egress.service
SSHDROPIN
cat > /etc/systemd/system/forge-exec-egress.timer <<'EGRESST'
[Unit]
Description=Refresh the Forge slot egress registry allowlist
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Unit=forge-exec-egress.service
[Install]
WantedBy=timers.target
EGRESST
systemctl daemon-reload
systemctl enable forge-exec-egress.service
systemctl start forge-exec-egress.service
systemctl enable --now forge-exec-egress.timer
printf 'forge-setup: ok\n'
