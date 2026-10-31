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
#   forge-exec-run.mjs, forge-warm-base.mjs and forge-exec-limits.mjs;
# - /etc/forge-exec/limits.json root:root 0644 (created only if absent),
#   persistent parent/slot systemd slices with live resource ceilings;
# - /etc/sudoers.d/forge-exec root:root 0440 with these exact forms:
#   ops ALL=(forge-exec-1,...,forge-exec-N) NOPASSWD: /usr/bin/rsync
#   ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs
#   ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs *
# - root-owned forge-warm-base systemd service/timer (service runs as ops,
#   timer every 30s) and /etc/cron.daily/forge-exec-prune root:root 0755;
# - installs python3 and rsync if missing. Never prunes active slot locks.
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
        allowed = {"forge-exec-run.mjs", "forge-exec-siblings.mjs", "forge-exec-manifest.mjs", "forge-exec-bases.mjs", "forge-warm-base.mjs", "forge-exec-limits.mjs"}
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
        for filename in ["forge-exec-run.mjs", "forge-warm-base.mjs", "forge-exec-limits.mjs"]:
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
cat > /etc/cron.daily/forge-exec-prune <<'PRUNE'
#!/bin/bash
set -euo pipefail
# Active reservations protect their slot and identifiable run/cache evidence.
# Unrelated expired state is pruned when reservation evidence identifies what
# to protect; incomplete evidence preserves expired receipts/caches. Reclaim only after
# excluding reservation writers and launches, then proving its UID has no live
# processes. Historical reservations require operator cleanup after stopping the UID.
python3 - <<'PRUNE_PY'
import os, re, stat, shutil, time, json, pwd, sys, fcntl
root, receipts = '/srv/forge-exec', '/srv/forge-receipts'
now = time.time()
active, runs, caches = set(), set(), set()
unknown_receipts = unknown_caches = False
def metadata(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 4*1024*1024: return {}
        with os.fdopen(os.dup(fd)) as stream: value = json.load(stream)
        return value if isinstance(value, dict) else {}
    finally: os.close(fd)
def uid_processes(uid):
    present = False
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            if os.stat('/proc/' + pid).st_uid != uid: continue
            present = True
            with open('/proc/' + pid + '/stat') as stream:
                if stream.read().rsplit(')', 1)[1].split()[0] != 'Z': return True, True
        except FileNotFoundError: continue
        except (OSError, ValueError, IndexError): return True, True
    return False, present
# Take exclusive leases before observing reservations and keep them throughout
# pruning. A blocked slot stays protected even if its writer has not published
# reservation.json yet. Runner SH leases allow different slots to run in parallel.
writer_fds, blocked = [], set()
names = {'worker-active'} | {'worker-active-' + name[5:] for name in os.listdir(root) if re.fullmatch(r'slot-[1-9][0-9]*', name)}
names |= {name for name in os.listdir(receipts) if re.fullmatch(r'worker-active(?:-[1-9][0-9]*)?', name)}
for name in sorted(names):
    fd = os.open(os.path.join(receipts, '.' + name + '.writer'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & 0o077 or st.st_uid not in {0, os.stat(receipts).st_uid}:
        raise RuntimeError('unsafe worker writer guard; use local fallback and inspect slot setup')
    # Cron runs as root, while controllers may run as ops. Normalize only a
    # validated root-owned inode, including guards left by an older prune.
    # Keep mode 0600 and the same inode: replacing it would split flock users.
    owner = os.stat(receipts)
    if st.st_uid == 0 and owner.st_uid != 0:
        os.fchown(fd, owner.st_uid, owner.st_gid)
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        blocked.add(name)
        active.add(name)
        os.close(fd)
    else: writer_fds.append(fd)
for name in sorted(names):
    path = os.path.join(receipts, name)
    try: st = os.lstat(path)
    except FileNotFoundError:
        if name in blocked: unknown_receipts = unknown_caches = True
        continue
    if not stat.S_ISDIR(st.st_mode): raise RuntimeError('unsafe reservation')
    try: record = metadata(os.path.join(path, 'reservation.json'))
    except (OSError, ValueError): record = {}
    # Missing protocol evidence may belong to an older, uncooperative wrapper.
    # Only the operator can exclude its future launches.
    if name not in blocked and record.get('writerGuard') == 1 and now - st.st_mtime > 604800:
        user = 'forge-exec' + name[len('worker-active'):]
        try: running, present = uid_processes(pwd.getpwnam(user).pw_uid)
        except (KeyError, OSError): running, present = True, True
        if not running:
            print('forge-exec-prune: abandoned reservation ' + name + '; UID has no live processes', file=sys.stderr)
            if not present: shutil.rmtree(path)
            continue
    active.add(name)
    run = record.get('run')
    if not isinstance(run, str) or not re.fullmatch(r'(r-|warm-)[a-f0-9]{32}', run):
        unknown_receipts = unknown_caches = True
        continue
    runs.add(run)
    identified_cache = False
    for phase in ('prepared', 'running', 'receipt'):
        try:
            lock = metadata(os.path.join(receipts, run + '.' + phase)).get('lock')
            if isinstance(lock, str) and re.fullmatch(r'[a-f0-9]{64}', lock):
                caches.add(lock)
                identified_cache = True
        except (OSError, ValueError): pass
    if not identified_cache: unknown_caches = True

def prune(parent, age, pattern, files=False, protected=()):
    st = os.lstat(parent)
    if not stat.S_ISDIR(st.st_mode): raise RuntimeError('unsafe prune root')
    for name in os.listdir(parent):
        if not re.fullmatch(pattern, name) or name in protected: continue
        if re.fullmatch(r'\.worker-active(?:-[1-9][0-9]*)?\.writer', name): continue
        if files and name.split('.', 1)[0] in runs: continue
        path = os.path.join(parent, name)
        st = os.lstat(path)
        if now - st.st_mtime <= age: continue
        if files and stat.S_ISREG(st.st_mode): os.unlink(path)
        elif not files and stat.S_ISDIR(st.st_mode): shutil.rmtree(path)
if 'worker-active' not in active:
    prune(root, 86400, r'r-.*')
for slot in os.listdir(root):
    if re.fullmatch(r'slot-[1-9][0-9]*', slot) and 'worker-active-' + slot[5:] not in active:
        prune(os.path.join(root, slot), 86400, r'(r-|warm-)[a-f0-9]{32}')
if unknown_receipts:
    print('forge-exec-prune: incomplete reservation evidence; preserving expired receipts until operator repair or confirmed UID shutdown', file=sys.stderr)
else: prune(receipts, 86400, r'.*', files=True)
if unknown_caches:
    print('forge-exec-prune: incomplete reservation evidence; preserving expired cache entries until operator repair or confirmed UID shutdown', file=sys.stderr)
else: prune('/srv/forge-cache', 1209600, r'.*', protected=caches)
PRUNE_PY
PRUNE
chown root:root /etc/cron.daily/forge-exec-prune
chmod 755 /etc/cron.daily/forge-exec-prune
printf 'forge-setup: ok\n'
