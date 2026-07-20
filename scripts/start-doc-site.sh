#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=4173
OPEN_BROWSER=1
RUN_BUILD=1
RUN_STANDARDIZE=1

print_help() {
  cat <<'EOF'
Usage: start-doc-site.sh [options]

Options:
  -p, --port PORT      HTTP port (default: 4173)
      --no-open        Skip auto-open browser
      --no-build        Skip index rebuild (still keep existing index)
      --no-standardize  Skip standardization step
  -h, --help         Show help

Starts a static doc viewer by:
1) building web/data/index.json
2) launching a static HTTP server on /web
EOF
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
    --no-build)
      RUN_BUILD=0
      shift
      ;;
    --no-standardize)
      RUN_STANDARDIZE=0
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

if [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
  node scripts/standardize-docs.mjs
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  node scripts/build-static-doc-site.mjs
elif [[ "$RUN_STANDARDIZE" -eq 1 ]]; then
  # Standardized docs are the build source, so we need a fresh index
  node scripts/build-static-doc-site.mjs
fi

SERVER_CMD=""
if command -v python3 >/dev/null 2>&1; then
  SERVER_CMD=(python3 -m http.server "$PORT" --bind 127.0.0.1 -d web)
elif command -v python >/dev/null 2>&1; then
  SERVER_CMD=(python -m http.server "$PORT" --bind 127.0.0.1 -d web)
else
  echo "Need python3 or python installed" >&2
  exit 1
fi

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  URL="http://127.0.0.1:${PORT}/web/"
  if command -v open >/dev/null 2>&1; then
    (sleep 0.6; open "$URL") &
  elif command -v xdg-open >/dev/null 2>&1; then
    (sleep 0.6; xdg-open "$URL") &
  fi
fi

echo "Serving web at http://127.0.0.1:${PORT}/web/"
"${SERVER_CMD[@]}"
