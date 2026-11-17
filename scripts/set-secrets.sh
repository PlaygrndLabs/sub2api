#!/bin/sh
# Stores the Worker secret for a deploy made with wrangler: a new dashboard password unless you
# pass your own. Prints it once. CPA's management key is derived from it on the server
# (src/management-key.ts); pass MANAGEMENT_KEY only to keep one an older install already uses.
# App API keys are made in the dashboard.
set -eu

DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-$(openssl rand -base64 30 | tr '+/' '-_' | tr -d '=')}
MANAGEMENT_KEY=${MANAGEMENT_KEY:-}

for value in "$DASHBOARD_PASSWORD" ${MANAGEMENT_KEY:+"$MANAGEMENT_KEY"}; do
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_-]{32,}$'; then
    echo "set-secrets: each value needs at least 32 characters of A-Z a-z 0-9 _ -" >&2
    exit 64
  fi
done

umask 077
file=$(mktemp)
trap 'rm -f "$file"' EXIT
if [ -n "$MANAGEMENT_KEY" ]; then
  printf '{\n  "DASHBOARD_PASSWORD": "%s",\n  "MANAGEMENT_KEY": "%s"\n}\n' "$DASHBOARD_PASSWORD" "$MANAGEMENT_KEY" > "$file"
else
  printf '{\n  "DASHBOARD_PASSWORD": "%s"\n}\n' "$DASHBOARD_PASSWORD" > "$file"
fi
npx wrangler secret bulk "$file"

cat <<OUT

Keep this somewhere safe; it is not shown again.
DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD
OUT
