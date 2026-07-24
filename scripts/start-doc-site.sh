#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=4173
OPEN_BROWSER=1
RUN_BUILD=1
RUN_STANDARDIZE=1
MODE="browse"
MERGE_BACKSTORY="default"

print_help() {
  cat <<'EOF'
Usage: start-doc-site.sh [options]

Options:
  -p, --port PORT      HTTP port (default: 4173)
  -m, --mode MODE      运行模式：browse（只读）/ edit（可编辑） default: browse
      --merge-backstory      合并背景故事到英雄（默认关闭）
      --no-merge-backstory   保持背景故事独立文件（默认）
      --no-open        Skip auto-open browser
      --no-build        Skip index rebuild (still keep existing index)
      --no-standardize  Skip standardization step
  -h, --help         Show help

Starts the doc site in one of two modes:
- browse: static website only (read-only)
- edit: API server for create/edit/rebuild

Both modes can run optional steps:
1) node scripts/standardize-docs.mjs (unless --no-standardize)
2) node scripts/build-static-doc-site.mjs (unless --no-build)
EOF
}

format_backstory_mode() {
  if [[ "$MERGE_BACKSTORY" == "on" ]]; then
    echo "enabled (merged into hero docs)"
  elif [[ "$MERGE_BACKSTORY" == "off" ]]; then
    echo "disabled (backstory standalone)"
  else
    echo "disabled (default)"
  fi
}

build_standardize_args() {
  STANDARDIZE_ARGS=()
  if [[ "$MERGE_BACKSTORY" == "on" ]]; then
    STANDARDIZE_ARGS+=(--merge-backstory)
  elif [[ "$MERGE_BACKSTORY" == "off" ]]; then
    STANDARDIZE_ARGS+=(--no-merge-backstory)
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      PORT="${2:-}"
      if [[ -z "${PORT}" ]]; then
        echo "Missing value for --port" >&2
        exit 1
      fi
      shift 2
      ;;
    --no-open)
      OPEN_BROWSER=0
      shift
      ;;
    -m|--mode)
      MODE="${2:-}"
      if [[ -z "${MODE}" ]]; then
        echo "Missing value for --mode" >&2
        exit 1
      fi
      MODE="$(printf '%s' "$MODE" | tr '[:upper:]' '[:lower:]')"
      if [[ "$MODE" != "browse" && "$MODE" != "edit" ]]; then
        echo "Invalid --mode value: ${MODE} (expected browse|edit)" >&2
        exit 1
      fi
      shift 2
      ;;
    --no-build)
      RUN_BUILD=0
      shift
      ;;
    --no-standardize)
      RUN_STANDARDIZE=0
      shift
      ;;
    --merge-backstory)
      MERGE_BACKSTORY="on"
      shift
      ;;
    --no-merge-backstory)
      MERGE_BACKSTORY="off"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown arg: ${1}" >&2
      print_help
      exit 1
      ;;
esac
done

cd "$PROJECT_ROOT"
BACKSTORY_MODE="$(format_backstory_mode)"

if [[ "$MODE" == "edit" ]]; then
  if [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
    build_standardize_args
    echo "[1/3] Run standardize... (backstory: ${BACKSTORY_MODE})"
    node scripts/standardize-docs.mjs "${STANDARDIZE_ARGS[@]}"
  fi

  if [[ "$RUN_BUILD" -eq 1 ]]; then
    echo "[2/3] Build web index..."
    node scripts/build-static-doc-site.mjs
  elif [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
    echo "[2/3] Build web index..."
    # Standardized docs changed, rebuild index to keep in sync
    node scripts/build-static-doc-site.mjs
  fi

  if [[ "$OPEN_BROWSER" -eq 1 ]]; then
    URL="http://127.0.0.1:${PORT}/web/?mode=edit"
    if command -v open >/dev/null 2>&1; then
      (sleep 0.6; open "$URL") &
    elif command -v xdg-open >/dev/null 2>&1; then
      (sleep 0.6; xdg-open "$URL") &
    fi
  fi

  echo "[3/3] [编辑模式] Start API+web server..."
  DOCS_BACKSTORY_MODE="$MERGE_BACKSTORY" node scripts/doc-site-server.mjs --port "$PORT"
  exit 0
fi

if [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
  build_standardize_args
  echo "[1/3] Run standardize... (backstory: ${BACKSTORY_MODE})"
  node scripts/standardize-docs.mjs "${STANDARDIZE_ARGS[@]}"
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  node scripts/build-static-doc-site.mjs
elif [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
  # Standardized docs changed, rebuild index to keep in sync
  node scripts/build-static-doc-site.mjs
fi

SERVER_CMD=""
if command -v python3 >/dev/null 2>&1; then
  SERVER_CMD=(python3 -m http.server "$PORT" --bind 127.0.0.1)
elif command -v python >/dev/null 2>&1; then
  SERVER_CMD=(python -m http.server "$PORT" --bind 127.0.0.1)
else
  echo "Need python3 or python installed" >&2
  exit 1
fi

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  URL="http://127.0.0.1:${PORT}/web/?mode=browse"
  if command -v open >/dev/null 2>&1; then
    (sleep 0.6; open "$URL") &
  elif command -v xdg-open >/dev/null 2>&1; then
    (sleep 0.6; xdg-open "$URL") &
  fi
fi

echo "[浏览模式] Serving web at http://127.0.0.1:${PORT}/web/"
"${SERVER_CMD[@]}"
