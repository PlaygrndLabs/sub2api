#!/bin/sh
# Writes the first-boot config, then runs CPA with its config and logins kept in object storage.
# CPA only uses this file when the bucket has no config yet; after that the bucket copy wins.
set -eu

for name in OBJECTSTORE_ENDPOINT OBJECTSTORE_BUCKET OBJECTSTORE_ACCESS_KEY OBJECTSTORE_SECRET_KEY CPA_MANAGEMENT_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "entrypoint: $name is not set" >&2
    exit 64
  fi
done

if ! printf '%s' "$CPA_MANAGEMENT_KEY" | grep -Eq '^[A-Za-z0-9_-]{32,}$'; then
  echo "entrypoint: CPA_MANAGEMENT_KEY must be at least 32 characters of A-Z a-z 0-9 _ -" >&2
  exit 64
fi

# This script always writes the server and management sections. A config moved over from the
# Workers-only install arrives in CPA_IMPORT_CONFIG without them (src/import-config.ts) and
# takes the place of the defaults.
cat > /CLIProxyAPI/config.example.yaml <<EOF
config-version: 8
server:
  host: ""
  port: 8317
management:
  allow-remote: true
  secret-key: "${CPA_MANAGEMENT_KEY}"
  disable-control-panel: false
  disable-auto-update-panel: true
EOF
if [ -n "${CPA_IMPORT_CONFIG:-}" ]; then
  printf '%s\n' "$CPA_IMPORT_CONFIG" >> /CLIProxyAPI/config.example.yaml
else
  cat >> /CLIProxyAPI/config.example.yaml <<'EOF'
access:
  api-keys: []
routing:
  retry:
    request-retry: 1
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: true
EOF
fi
chmod 600 /CLIProxyAPI/config.example.yaml

unset CPA_MANAGEMENT_KEY CPA_IMPORT_CONFIG
exec /CLIProxyAPI/CLIProxyAPI
