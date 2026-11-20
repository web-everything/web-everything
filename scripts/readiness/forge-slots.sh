#!/bin/bash
# Shared launcher: no Node requirement during initial Forge provisioning.
set -euo pipefail
slot_dir=$(cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1; then
  exec node "$slot_dir/forge-slots.mjs"
fi
slot_settings="$slot_dir/forge-slots.json"
if [[ ! -e "$slot_settings" ]]; then slot_settings="$slot_dir/../settings/forge-slots.json"; fi
if ! command -v python3 >/dev/null 2>&1; then
  echo 'forge-slots: install node or python3 to read forge-slots.json' >&2
  exit 1
fi
exec python3 - "$slot_settings" <<'PYTHON'
import json, os, pwd, re, socket, sys
try:
    def checked(value, label):
        if type(value) is not int or not 1 <= value <= 128:
            raise ValueError(label + ' must be 1..128')
        return value
    host = os.environ.get('FORGE_HOST', socket.gethostname()).split('.')[0]
    override = None
    try:
        with open(os.path.join(pwd.getpwuid(os.getuid()).pw_dir, '.claude', 'operator-overrides.json')) as stream:
            store = json.load(stream)
        key = 'forgeSlots.' + host
        if not isinstance(store, dict):
            raise ValueError('not a JSON object')
        nested = store.get('forgeSlots', {})
        raw = store.get(key, nested.get(host) if isinstance(nested, dict) else None)
        if host in ('forge', 'forge-b') and raw is not None:
            if type(raw) is int and 1 <= raw <= 128:
                override = raw
            else:
                print('operator-override: operator-db-invalid ' + key + '; dropping this key', file=sys.stderr)
    except FileNotFoundError:
        pass
    except Exception as error:
        message = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', str(error))
        print('operator-override: operator-db-unreadable store (' + message + '); using lower setting', file=sys.stderr)
    if 'FORGE_EXEC_SLOTS' in os.environ:
        value = os.environ['FORGE_EXEC_SLOTS']
        if not re.fullmatch(r'[1-9][0-9]*', value):
            raise ValueError('FORGE_EXEC_SLOTS must be 1..128')
        count = checked(int(value), 'FORGE_EXEC_SLOTS')
    else:
        with open(sys.argv[1]) as stream:
            config = json.load(stream)['forgeSlots']
        checked(config['default'], 'forgeSlots.default')
        if not isinstance(config['hosts'], dict):
            raise ValueError('Missing forgeSlots hosts settings')
        for name, value in config['hosts'].items():
            checked(value, 'forgeSlots.hosts.' + name)
        host = os.environ.get('FORGE_HOST', socket.gethostname()).split('.')[0]
        count = config['hosts'].get(host, config['default'])
    if override is not None:
        count = override
    print(count)
except Exception as error:
    print('forge-slots: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYTHON
