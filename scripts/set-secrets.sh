#!/bin/sh
# Stores the Worker secret for a deploy made with wrangler: a new dashboard password unless you
# pass your own. Prints it once. CPA's management key is derived from it on the server
# (src/management-key.ts); pass MANAGEMENT_KEY only to keep one an older install already uses.
# App API keys are made in the dashboard.
set -eu

DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-$(openssl rand -base64 30 | tr '+/' '-_' | tr -d '=')}
MANAGEMENT_KEY=${MANAGEMENT_KEY:-}

if [ -z "$DASHBOARD_PASSWORD" ]; then
  echo "set-secrets: DASHBOARD_PASSWORD can't be empty" >&2
  exit 64
fi
# CPA itself needs a management key of 32+ characters; the password can be anything.
if [ -n "$MANAGEMENT_KEY" ] && ! printf '%s' "$MANAGEMENT_KEY" | grep -Eq '^[A-Za-z0-9_-]{32,}$'; then
  echo "set-secrets: MANAGEMENT_KEY needs at least 32 characters of A-Z a-z 0-9 _ -" >&2
  exit 64
fi

# Piped through stdin, so any character works and nothing lands in a file or the process list.
printf '%s' "$DASHBOARD_PASSWORD" | npx wrangler secret put DASHBOARD_PASSWORD
if [ -n "$MANAGEMENT_KEY" ]; then
  printf '%s' "$MANAGEMENT_KEY" | npx wrangler secret put MANAGEMENT_KEY
fi

cat <<OUT

Keep this somewhere safe; it is not shown again.
DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD
OUT
