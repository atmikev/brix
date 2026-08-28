#!/bin/bash
# Helper for Claude to communicate with the Brix VS Code extension.
# Usage:
#   brix.sh plan <json_file>      Send walkthrough plan from file
#   brix.sh send <json_string>    Send raw JSON message
#   brix.sh state                 Get current walkthrough state
#   brix.sh wait-action [timeout] Wait for user action (default 30s)
#   brix.sh stop                  Stop the walkthrough
#   brix.sh save [name]           Save current walkthrough
#   brix.sh load <name>           Load a saved walkthrough
#   brix.sh list                  List saved walkthroughs
#   brix.sh decision <json>       Raise a decision card (json string or @file)
#   brix.sh decisions             List current decisions
#   brix.sh validate              Check whether the loaded walkthrough still matches the code
#   brix.sh resolve-decision <id> [answer]  Mark answered (or withdraw if no answer)
#   brix.sh post <json>           Post a distilled update to the sidebar feed
#                                 {"kind":"finding|answer|status|progress|info","title":...,"body":...,"source":...}
#   brix.sh watch-task <id> <title> [interval_sec]  Start interval status requests for a long task
#   brix.sh end-task <id> [summary]                 Stop watching; post completion to feed

PORT_FILE="$HOME/.claude-brix-port"
TOKEN_FILE="$HOME/.claude-brix-token"

if [ ! -f "$PORT_FILE" ]; then
    echo '{"error": "Brix extension not running (no port file)"}' >&2
    exit 1
fi

PORT=$(cat "$PORT_FILE")
BASE="http://127.0.0.1:$PORT"

if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    AUTH_HEADER="Authorization: Bearer $TOKEN"
else
    echo '{"error": "No auth token found"}' >&2
    exit 1
fi

case "$1" in
    plan)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh plan <json_file>" >&2
            exit 1
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d @"$2"
        ;;
    send)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh send '<json>'" >&2
            exit 1
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "$2"
        ;;
    state)
        curl -s -H "$AUTH_HEADER" "$BASE/api/state"
        ;;
    wait-action)
        TIMEOUT="${2:-30}"
        # Numeric only — never let a non-numeric value reach bash arithmetic,
        # where array-subscript syntax can trigger command substitution.
        case "$TIMEOUT" in
            ''|*[!0-9]*) echo '{"error": "timeout must be a positive integer"}' >&2; exit 1 ;;
        esac
        curl -s --max-time "$((TIMEOUT + 5))" -H "$AUTH_HEADER" "$BASE/api/actions?timeout=$TIMEOUT"
        ;;
    stop)
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d '{"type": "stop"}'
        ;;
    save)
        NAME="${2:-}"
        if [ -n "$NAME" ]; then
            curl -s -X POST "$BASE/api/save" \
                -H 'Content-Type: application/json' \
                -H "$AUTH_HEADER" \
                -d "{\"name\": \"$NAME\"}"
        else
            curl -s -X POST "$BASE/api/save" \
                -H 'Content-Type: application/json' \
                -H "$AUTH_HEADER" \
                -d '{}'
        fi
        ;;
    load)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh load <name>" >&2
            exit 1
        fi
        curl -s -X POST "$BASE/api/load" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "{\"name\": \"$2\"}"
        ;;
    list)
        curl -s -H "$AUTH_HEADER" "$BASE/api/walkthroughs"
        ;;
    decision)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh decision '<decision_json>' (or @path/to/file.json)" >&2
            exit 1
        fi
        if [ "${2:0:1}" = "@" ]; then
            DECISION_JSON=$(cat "${2:1}")
        else
            DECISION_JSON="$2"
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "{\"type\": \"raise_decision\", \"decision\": $DECISION_JSON}"
        ;;
    decisions)
        curl -s -H "$AUTH_HEADER" "$BASE/api/decisions"
        ;;
    validate)
        curl -s -H "$AUTH_HEADER" "$BASE/api/validity"
        ;;
    resolve-decision)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh resolve-decision <id> [answer]" >&2
            exit 1
        fi
        if [ -n "$3" ]; then
            PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"type":"resolve_decision","id":sys.argv[1],"answer":sys.argv[2]}))' "$2" "$3")
        else
            PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"type":"resolve_decision","id":sys.argv[1]}))' "$2")
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "$PAYLOAD"
        ;;
    post)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh post '<feed_item_json>' (or @path/to/file.json)" >&2
            exit 1
        fi
        if [ "${2:0:1}" = "@" ]; then
            ITEM_JSON=$(cat "${2:1}")
        else
            ITEM_JSON="$2"
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "{\"type\": \"post_update\", \"item\": $ITEM_JSON}"
        ;;
    watch-task)
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo "Usage: brix.sh watch-task <id> <title> [interval_sec]" >&2
            exit 1
        fi
        PAYLOAD=$(python3 -c 'import json, sys
d = {"type": "watch_task", "id": sys.argv[1], "title": sys.argv[2]}
if len(sys.argv) > 3:
    d["intervalSec"] = int(sys.argv[3])
print(json.dumps(d))' "$2" "$3" ${4:+"$4"})
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "$PAYLOAD"
        ;;
    end-task)
        if [ -z "$2" ]; then
            echo "Usage: brix.sh end-task <id> [summary]" >&2
            exit 1
        fi
        if [ -n "$3" ]; then
            PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"type":"end_task","id":sys.argv[1],"summary":sys.argv[2]}))' "$2" "$3")
        else
            PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"type":"end_task","id":sys.argv[1]}))' "$2")
        fi
        curl -s -X POST "$BASE/api/message" \
            -H 'Content-Type: application/json' \
            -H "$AUTH_HEADER" \
            -d "$PAYLOAD"
        ;;
    *)
        echo "Usage: brix.sh {plan|send|state|wait-action|stop|save|load|list|decision|decisions|resolve-decision|post|watch-task|end-task}" >&2
        exit 1
        ;;
esac
