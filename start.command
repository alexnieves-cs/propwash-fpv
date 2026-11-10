#!/bin/bash
# Double-click to launch Propwash in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Propwash needs Node.js (https://nodejs.org). Install it, then run this again."
  read -r -p "Press Return to close."
  exit 1
fi
[ -d node_modules ] || npm install
npm start
