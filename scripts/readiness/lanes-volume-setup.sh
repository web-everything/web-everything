#!/bin/bash
# lanes-volume-setup.sh - ONE-TIME operator setup (run with sudo, once per host).
#
# Creates a dedicated APFS volume "Lanes" in the Data container so lane clones, daemon clones and vitest temp
# files stop feeding fseventsd and Spotlight on the Data volume (fseventsd RSS grew to GBs from that churn).
# On the new volume it disables FSEvents logging (.fseventsd/no_log) and Spotlight indexing, then prints the
# platform settings to set. Idempotent: re-running after success only re-asserts the flags.
#
#   sudo scripts/readiness/lanes-volume-setup.sh [volume-name]     (default name: Lanes)
#
# It does NOT move existing lanes and does NOT edit settings; it prints what to set.
set -euo pipefail

NAME="${1:-Lanes}"
MOUNT="/Volumes/${NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0 ${NAME}" >&2
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "macOS only" >&2
  exit 1
fi

# The APFS container that holds the Data volume.
CONTAINER="$(diskutil info -plist /System/Volumes/Data | plutil -extract APFSContainerReference raw -o - -)"
if [ -z "${CONTAINER}" ]; then
  echo "could not find the APFS container of /System/Volumes/Data" >&2
  exit 1
fi

if [ -d "${MOUNT}" ] && diskutil info "${MOUNT}" >/dev/null 2>&1; then
  echo "volume ${NAME} already mounted at ${MOUNT}; re-asserting flags"
else
  echo "creating APFS volume ${NAME} in ${CONTAINER}"
  diskutil apfs addVolume "${CONTAINER}" APFS "${NAME}" -mountpoint "${MOUNT}"
fi

# No FSEvents log for this volume, and keep Spotlight off it.
mkdir -p "${MOUNT}/.fseventsd"
touch "${MOUNT}/.fseventsd/no_log"
touch "${MOUNT}/.metadata_never_index"
mdutil -i off "${MOUNT}"

# The operator's account owns the tree so lanes and temp need no further sudo.
OWNER="${SUDO_USER:-$(stat -f %Su /dev/console)}"
mkdir -p "${MOUNT}/lanes" "${MOUNT}/tmp"
chown -R "${OWNER}" "${MOUNT}/lanes" "${MOUNT}/tmp"

cat <<EOF

Done. Set these platform settings (then move/provision lanes under the new root):

  lanes.root     = ${MOUNT}/lanes
  heavy.tmpRoot  = ${MOUNT}/tmp

Optional safety net thresholds (defaults shown):

  health.fseventsd.warnMb     = 1024
  health.fseventsd.throttleMb = 2048

Verify:  mdutil -s ${MOUNT}   (expect: Indexing disabled)   and   ls ${MOUNT}/.fseventsd/no_log
EOF
