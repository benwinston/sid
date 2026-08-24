#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if git ls-files --error-unmatch cache.db cache.db-wal cache.db-shm >/dev/null 2>&1; then
  echo "ERROR: a private cache database is tracked by Git" >&2
  exit 1
fi

if git ls-files -z | grep -zv '^scripts/privacy-check\.sh$' | xargs -0 grep -InE '/Users/[^/]+/|/home/[^/]+/|[[:alnum:]._%+-]+@(gmail|icloud|outlook|yahoo)\.com|/clawd(/|$)' -- 2>/dev/null; then
  echo "ERROR: personal email address or filesystem path found in tracked files" >&2
  exit 1
fi

if grep -nE "app\.listen\([^\n]*'127\.0\.0\.1'" server.js >/dev/null; then
  :
else
  echo "ERROR: server is not explicitly bound to 127.0.0.1" >&2
  exit 1
fi

echo "Privacy check passed"
