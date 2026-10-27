#!/bin/bash
set -euo pipefail

if ! id forge-exec >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /srv/forge-exec --shell /bin/bash forge-exec
fi
mkdir -p /srv/forge-exec /srv/forge-exec/.cache
chown forge-exec:forge-exec /srv/forge-exec /srv/forge-exec/.cache
chmod 750 /srv/forge-exec /srv/forge-exec/.cache
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
