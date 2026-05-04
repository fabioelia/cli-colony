#!/usr/bin/env bash
# Colony CLI — wraps the Colony REST API for terminal/CI/SSH use.
# Dependencies: curl, jq (optional — falls back to raw JSON)
set -euo pipefail

PORT="${COLONY_PORT:-7474}"
TOKEN="${COLONY_API_TOKEN:-}"
JSON=0
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --port)  PORT="$2";  shift 2 ;;
    --json)  JSON=1; shift ;;
    *)       POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

BASE="http://127.0.0.1:${PORT}"
HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1

die() { echo "Error: $*" >&2; exit 1; }

auth() { [[ -n "$TOKEN" ]] && echo "-H" && echo "Authorization: Bearer $TOKEN" || true; }

get() {
  local h=(); [[ -n "$TOKEN" ]] && h=(-H "Authorization: Bearer $TOKEN")
  curl -sf "${h[@]+"${h[@]}"}" "${BASE}${1}" || die "Colony unreachable on port ${PORT}. Is the app running?"
}

post() {
  local h=(); [[ -n "$TOKEN" ]] && h=(-H "Authorization: Bearer $TOKEN")
  curl -sf -X POST "${h[@]+"${h[@]}"}" -H "Content-Type: application/json" -d "${2:-{}}" "${BASE}${1}" \
    || die "Request failed: POST ${1}"
}

chkauth() { echo "$1" | grep -qE '"error".*[Uu]nauth|"401"' && die "Authentication failed. Set COLONY_API_TOKEN or use --token." || true; }

tbl() { [[ $HAS_JQ -eq 1 ]] && jq -r "$@" | column -t || jq -r "$@"; }

case "${1:-help}" in

status)
  h=$(get /api/health); chkauth "$h"
  s=$(get /api/status)
  if [[ $JSON -eq 1 ]]; then printf '{"health":%s,"status":%s}\n' "$h" "$s"; exit 0; fi
  [[ $HAS_JQ -eq 0 ]] && echo "$h" && echo "$s" && exit 0
  ver=$(echo "$s" | jq -r '.version // "?"')
  up=$(echo "$s"  | jq -r '.uptime // 0')
  overall=$(echo "$h" | jq -r '.status // "unknown"')
  running=$(echo "$h" | jq -r '.sessions.running // 0')
  stopped=$(echo "$h" | jq -r '.sessions.stopped // 0')
  np=$(echo "$h" | jq -r '.pipelines | length')
  na=$(echo "$h" | jq -r '.personas  | length')
  mins=$(( up / 60 )); secs=$(( up % 60 ))
  printf "Colony %s  [%s]  up %dm%ds\n" "$ver" "$overall" "$mins" "$secs"
  printf "  Sessions:  %s running, %s stopped\n" "$running" "$stopped"
  printf "  Pipelines: %s  Personas: %s\n" "$np" "$na"
  ;;

sessions)
  r=$(get /api/sessions); chkauth "$r"
  [[ $JSON -eq 1 ]] && echo "$r" && exit 0
  tbl '["ID","NAME","STATUS","COST","IDLE"],
    (.sessions[] | [(.id|.[0:8]), (.name|.[0:28]), .status,
    ("$"+( (.cost//0)|tostring|.[0:6])),
    (((.uptime//0)/1000|floor|tostring)+"s")]) | @tsv' <<< "$r"
  ;;

session)
  [[ -z "${2:-}" ]] && { echo "Usage: colony session <id|name>"; exit 1; }
  id="$2"
  r=$(get "/api/sessions/${id}"); chkauth "$r"
  o=$(get "/api/sessions/${id}/output" 2>/dev/null) || o="{}"
  if [[ $JSON -eq 1 ]]; then printf '{"session":%s,"output":%s}\n' "$r" "$o"; exit 0; fi
  [[ $HAS_JQ -eq 0 ]] && echo "$r" && echo "--- output ---" && echo "$o" && exit 0
  echo "$r" | jq -r '.session | "Session: \(.name)\nID:      \(.id)\nStatus:  \(.status)\nCost:    $\(.tokenUsage.cost//0)"'
  echo "--- Last 20 lines ---"
  echo "$o" | jq -r '.output//""' | tail -20 | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'
  ;;

pipelines)
  r=$(get /api/pipelines); chkauth "$r"
  [[ $JSON -eq 1 ]] && echo "$r" && exit 0
  tbl '["NAME","ENABLED","FIRES","LAST FIRED"],
    (.pipelines[] | [(.name|.[0:32]),
    (if .enabled then "yes" else "no" end),
    ((.fireCount//0)|tostring),
    (.lastFiredAt//"never"|if . != "never" then .[0:16] else . end)]) | @tsv' <<< "$r"
  ;;

trigger)
  [[ -z "${2:-}" ]] && { echo "Usage: colony trigger <name> [--prompt TEXT] [--model MODEL] [--budget N]"; exit 1; }
  name="$2"; shift 2
  prompt=""; model=""; budget=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --prompt) prompt="$2"; shift 2 ;; --model) model="$2"; shift 2 ;; --budget) budget="$2"; shift 2 ;; *) shift ;; esac
  done
  if [[ $HAS_JQ -eq 1 ]]; then
    body=$(jq -n --arg p "$prompt" --arg m "$model" --arg b "$budget" \
      '{prompt:(if $p!="" then $p else null end),model:(if $m!="" then $m else null end),
        maxBudget:(if $b!="" then ($b|tonumber) else null end)} | with_entries(select(.value!=null))')
  else body="{}"; fi
  r=$(post "/api/pipelines/${name}/trigger" "$body"); chkauth "$r"
  [[ $JSON -eq 1 ]] && echo "$r" && exit 0
  [[ $HAS_JQ -eq 1 ]] && echo "$r" | jq -r '"Triggered: \(.pipeline)"' || echo "Triggered: $name"
  ;;

whisper)
  [[ -z "${2:-}" || -z "${3:-}" ]] && { echo "Usage: colony whisper <id|name> \"<message>\""; exit 1; }
  id="$2"; msg="$3"
  if [[ $HAS_JQ -eq 1 ]]; then
    body=$(jq -n --arg m "$msg" '{"prompt":$m}')
  else
    body="{\"prompt\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$msg")}"
  fi
  r=$(post "/api/sessions/${id}/whisper" "$body"); chkauth "$r"
  [[ $JSON -eq 1 ]] && echo "$r" && exit 0
  echo "Whisper sent."
  ;;

personas)
  r=$(get /api/personas); chkauth "$r"
  [[ $JSON -eq 1 ]] && echo "$r" && exit 0
  tbl '["NAME","ENABLED","RUNS","LAST RUN","ACTIVE"],
    (.personas[] | [(.name|.[0:28]),
    (if .enabled then "yes" else "no" end),
    ((.runCount//0)|tostring),
    (.lastRun//"never"|if . != "never" then .[0:16] else . end),
    (if .active then "yes" else "no" end)]) | @tsv' <<< "$r"
  ;;

dashboard)
  printf "Dashboard: %s/api/dashboard\n" "$BASE"
  ;;

help|--help|-h|"")
  cat <<EOF
Colony CLI — terminal interface to the Colony REST API

Usage: $(basename "$0") [--token TOKEN] [--port PORT] [--json] <command> [args]

Commands:
  status                    Colony health, uptime, session/pipeline counts
  sessions                  List all sessions (name, status, cost, idle)
  session <id|name>         Show one session's detail + last 20 lines of output
  pipelines                 List pipelines with enabled status and fire counts
  trigger <name> [opts]     Trigger a pipeline (--prompt, --model, --budget)
  whisper <id> "<msg>"      Send a message to a running session
  personas                  List personas with run count and enabled status
  dashboard                 Print the dashboard URL

Options:
  --token TOKEN   API token (or set COLONY_API_TOKEN env var)
  --port PORT     Colony port (or set COLONY_PORT env var; default: 7474)
  --json          Output raw JSON instead of formatted tables

Examples:
  colony status
  colony sessions --json
  colony trigger "Automated PR Review" --prompt "Review PR #42" --model sonnet
  colony whisper my-session "What is the current status?"
EOF
  ;;

*)
  echo "Unknown command: ${1:-}"; echo "Run '$(basename "$0") help' for usage."; exit 1
  ;;
esac
