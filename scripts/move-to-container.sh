#!/bin/sh
# Moves the Workers-only install to the Container install on the same Cloudflare account and keeps
# its logins, API keys and config. Needs the Workers Paid plan, Docker, and `npx wrangler login`
# (or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID). Run from a clone after `npm ci`:
#
#   sh scripts/move-to-container.sh            copy everything into the sub2api R2 bucket, change nothing else
#   sh scripts/move-to-container.sh --replace  copy again, then delete the Workers-only Worker and deploy the Container install
#
# The copy goes to backup/workers-only-<time>/ in the bucket, and to the places the Container install
# reads on its first start (see scripts/move-to-container/export.ts). It prints counts, never keys.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
wrangler="$root/node_modules/.bin/wrangler"
replace=false
case "${1:-}" in
  "") ;;
  --replace) replace=true ;;
  *) echo "usage: sh scripts/move-to-container.sh [--replace]" >&2; exit 64 ;;
esac

# An empty directory, so wrangler ignores the repo's own config.
work=$(mktemp -d)
cleanup() {
  (cd "$work" && "$wrangler" delete --name sub2api-move --force >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT
cd "$work"

if ! "$wrangler" r2 bucket info sub2api >/dev/null 2>&1; then
  "$wrangler" r2 bucket create sub2api
fi

# A short-lived Worker bound to the Workers-only install's Durable Object and to the bucket.
cat > wrangler.jsonc <<EOF
{
  "name": "sub2api-move",
  "main": "$root/scripts/move-to-container/export.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": true,
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "Store", "script_name": "sub2api" }] },
  "r2_buckets": [{ "binding": "STATE", "bucket_name": "sub2api" }]
}
EOF
if ! "$wrangler" deploy > deploy.log 2>&1; then
  cat deploy.log >&2
  echo "Could not deploy the export Worker. Is the Workers-only install deployed as the Worker sub2api?" >&2
  exit 1
fi
url=$(grep -o 'https://sub2api-move\.[A-Za-z0-9-]*\.workers\.dev' deploy.log | head -1)
[ -n "$url" ] || { cat deploy.log >&2; echo "No workers.dev address in the deploy output." >&2; exit 1; }

# A one-time token, kept out of logs and process lists.
token=$(openssl rand -hex 32)
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$token"
printf '%s' "$token" | "$wrangler" secret put MOVE_TOKEN >/dev/null
umask 077
printf 'authorization: Bearer %s\n' "$token" > header

# A new workers.dev address and secret can take a minute to reach every location.
code=000
for _ in $(seq 1 24); do
  code=$(curl -s -o result.json -w '%{http_code}' -X POST -H @header "$url/export" || echo 000)
  [ "$code" = 200 ] || [ "$code" = 500 ] && break
  sleep 5
done
cat result.json 2>/dev/null || true
echo
[ "$code" = 200 ] || { echo "Export failed (HTTP $code). Nothing was deleted." >&2; exit 1; }
echo "Export done."

if [ "$replace" = false ]; then
  echo "Nothing else changed. Run again with --replace to switch to the Container install."
  exit 0
fi

"$wrangler" delete --name sub2api-move --force >/dev/null
"$wrangler" delete --name sub2api --force
cd "$root"
"$wrangler" deploy
cat <<'EOF'
The Container install is deployed. Set its two secrets now (each at least 32 characters of
A-Z a-z 0-9 _ -, for example from `openssl rand -hex 32`), in the Cloudflare dashboard under
Workers > sub2api > Settings, or with:
  npx wrangler secret put DASHBOARD_PASSWORD
  npx wrangler secret put MANAGEMENT_KEY
On its first start CPA takes the moved config and logins.
EOF
