#!/bin/sh
# Points the pinned CPA release and dashboard at upstream's latest releases: CPA_VERSION and
# CPA_COMMIT in container/Dockerfile, PANEL_VERSION and PANEL_SHA256 there and in
# free/scripts/fetch-panel.mjs. Run by .github/workflows/bump-upstream.yml, which opens a PR so a
# person reviews every upgrade before it deploys. Set CPA_TAG, CPA_SHA, PANEL_TAG or PANEL_HASH to
# skip looking one up. Prints the new versions as KEY=value lines.
set -eu

CPA_REPO=router-for-me/CLIProxyAPI
PANEL_REPO=router-for-me/Cli-Proxy-API-Management-Center
DOCKERFILE=container/Dockerfile
FETCH_PANEL=free/scripts/fetch-panel.mjs

# GitHub redirects a release's "latest" download to the same path under its tag.
latest_tag() {
  url=$(curl -fsS -o /dev/null -w '%{redirect_url}' "https://github.com/$1/releases/latest/download/$2")
  tag=$(printf '%s' "$url" | sed -n 's|.*/releases/download/\([^/]*\)/.*|\1|p')
  [ -n "$tag" ] || { echo "bump-upstream: no latest release found for $1" >&2; exit 1; }
  printf '%s' "$tag"
}

CPA_TAG=${CPA_TAG:-$(latest_tag "$CPA_REPO" checksums.txt)}
if [ -z "${CPA_SHA:-}" ]; then
  # An annotated tag lists its commit as the peeled ^{} ref; a lightweight tag lists only itself.
  refs=$(git ls-remote "https://github.com/$CPA_REPO.git" "refs/tags/$CPA_TAG" "refs/tags/$CPA_TAG^{}")
  CPA_SHA=$(printf '%s\n' "$refs" | awk '$2 ~ /\^\{\}$/ {print $1}')
  [ -n "$CPA_SHA" ] || CPA_SHA=$(printf '%s\n' "$refs" | awk 'NR == 1 {print $1}')
fi
printf '%s' "$CPA_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "bump-upstream: no commit found for CPA $CPA_TAG" >&2; exit 1; }

PANEL_TAG=${PANEL_TAG:-$(latest_tag "$PANEL_REPO" management.html)}
if [ -z "${PANEL_HASH:-}" ]; then
  PANEL_HASH=$(curl -fsSL --retry 5 --retry-all-errors "https://github.com/$PANEL_REPO/releases/download/$PANEL_TAG/management.html" | sha256sum | cut -d' ' -f1)
fi
printf '%s' "$PANEL_HASH" | grep -Eq '^[0-9a-f]{64}$' || { echo "bump-upstream: bad dashboard checksum" >&2; exit 1; }

for value in "$CPA_TAG" "$PANEL_TAG"; do
  printf '%s' "$value" | grep -Eq '^v[0-9A-Za-z._-]+$' || { echo "bump-upstream: unexpected tag $value" >&2; exit 1; }
done

sed -i \
  -e "s|^ARG CPA_VERSION=.*|ARG CPA_VERSION=$CPA_TAG|" \
  -e "s|^ARG CPA_COMMIT=.*|ARG CPA_COMMIT=$CPA_SHA|" \
  -e "s|^ARG PANEL_VERSION=.*|ARG PANEL_VERSION=$PANEL_TAG|" \
  -e "s|^ARG PANEL_SHA256=.*|ARG PANEL_SHA256=$PANEL_HASH|" \
  "$DOCKERFILE"
sed -i \
  -e "s|^const PINNED_VERSION = .*|const PINNED_VERSION = \"$PANEL_TAG\";|" \
  -e "s|^const PINNED_SHA256 = .*|const PINNED_SHA256 = \"$PANEL_HASH\";|" \
  "$FETCH_PANEL"

for pattern in "ARG CPA_VERSION=$CPA_TAG" "ARG CPA_COMMIT=$CPA_SHA" "ARG PANEL_VERSION=$PANEL_TAG" "ARG PANEL_SHA256=$PANEL_HASH"; do
  grep -qxF "$pattern" "$DOCKERFILE" || { echo "bump-upstream: $DOCKERFILE has no line $pattern" >&2; exit 1; }
done
grep -qF "\"$PANEL_HASH\"" "$FETCH_PANEL" || { echo "bump-upstream: $FETCH_PANEL was not updated" >&2; exit 1; }

echo "CPA_TAG=$CPA_TAG"
echo "CPA_SHA=$CPA_SHA"
echo "PANEL_TAG=$PANEL_TAG"
echo "PANEL_HASH=$PANEL_HASH"
