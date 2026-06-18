#!/usr/bin/env bash
echo "============================================"
echo "  色块暴走派对"
echo "============================================"
echo

PORT=8091
URL="http://localhost:$PORT"

# Open the browser shortly after the server starts (macOS: open, Linux: xdg-open)
open_browser() {
  sleep 1
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
}

# Serve from the directory this script lives in
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  echo "Starting server at $URL"
  echo "Press Ctrl+C to stop."
  echo
  open_browser &
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  echo "Starting server at $URL"
  echo "Press Ctrl+C to stop."
  echo
  open_browser &
  exec python -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  echo "Starting server at $URL"
  echo "Press Ctrl+C to stop."
  echo
  open_browser &
  exec npx serve -l "$PORT"
else
  echo "ERROR: No Python or Node.js found."
  exit 1
fi
