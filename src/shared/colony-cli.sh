#!/bin/bash
# colony-cli — control Colony environments from the command line.
# Usage:
#   colony start <env-id>          Start all services
#   colony stop <env-id>           Stop all services
#   colony status                  List all environments and their status
#   colony status <env-id>         Show one environment's status
#
# This talks directly to the Colony env daemon via Unix socket.

SOCKET="${HOME}/.claude-colony/envd.sock"

send_request() {
  local req="$1"
  echo "$req" | nc -U "$SOCKET" -w 5 2>/dev/null | head -1
}

case "${1:-}" in
  start)
    [ -z "$2" ] && echo "Usage: colony start <env-id>" && exit 1
    resp=$(send_request "{\"type\":\"start\",\"reqId\":\"cli-$$\",\"envId\":\"$2\"}")
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); print('Started' if r.get('type')=='ok' else f'Error: {r.get(\"message\",\"unknown\")}')" 2>/dev/null || echo "$resp"
    ;;
  stop)
    [ -z "$2" ] && echo "Usage: colony stop <env-id>" && exit 1
    resp=$(send_request "{\"type\":\"stop\",\"reqId\":\"cli-$$\",\"envId\":\"$2\"}")
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); print('Stopped' if r.get('type')=='ok' else f'Error: {r.get(\"message\",\"unknown\")}')" 2>/dev/null || echo "$resp"
    ;;
  status)
    if [ -n "$2" ]; then
      resp=$(send_request "{\"type\":\"status-one\",\"reqId\":\"cli-$$\",\"envId\":\"$2\"}")
    else
      resp=$(send_request "{\"type\":\"status\",\"reqId\":\"cli-$$\"}")
    fi
    echo "$resp" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if r.get('type') == 'error':
    print(f'Error: {r.get(\"message\")}')
    sys.exit(1)
data = r.get('data')
if data is None:
    print('No data')
    sys.exit(0)
envs = data if isinstance(data, list) else [data]
for e in envs:
    svcs = ', '.join(f'{s[\"name\"]}={s[\"status\"]}' for s in e.get('services', []))
    print(f'{e[\"name\"]} [{e[\"status\"]}] — {svcs}')
" 2>/dev/null || echo "$resp"
    ;;
  *)
    echo "Usage: colony {start|stop|status} [env-id]"
    exit 1
    ;;
esac
