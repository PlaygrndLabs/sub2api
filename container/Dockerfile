FROM golang:1.26-bookworm AS builder
# The CPA release this image builds, pinned and bumped by a reviewed PR from
# .github/workflows/bump-upstream.yml. CPA_COMMIT, when set, must be the commit the tag points to,
# so a moved tag fails the build. "latest" builds the newest release tag instead.
ARG CPA_VERSION=v8.0.45
ARG CPA_COMMIT=""
ENV GOTOOLCHAIN=auto
WORKDIR /src
RUN set -eu; repo=https://github.com/router-for-me/CLIProxyAPI.git; tag="${CPA_VERSION}"; \
  if [ "$tag" = latest ]; then \
    tag=$(git ls-remote --tags --refs "$repo" | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1); \
  fi; \
  echo "Building CPA $tag"; \
  git init -q . && git remote add origin "$repo" \
  && git fetch -q --depth 1 origin tag "$tag" && git checkout -q "$tag" \
  && if [ -n "${CPA_COMMIT}" ] && [ "$(git rev-parse HEAD)" != "${CPA_COMMIT}" ]; then \
    echo "CPA $tag is commit $(git rev-parse HEAD), not the pinned ${CPA_COMMIT}" >&2; exit 1; \
  fi \
  && echo "CPA $tag is commit $(git rev-parse HEAD)" \
  && printf '%s' "$tag" > /tmp/cpa-version
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false \
  -ldflags="-s -w -X 'main.Version=$(cat /tmp/cpa-version)' -X 'main.Commit=$(git rev-parse HEAD)'" \
  -o /out/CLIProxyAPI ./cmd/server/

FROM debian:bookworm-slim
# CPA's dashboard, pinned with its checksum the same way. Keep it in step with
# free/scripts/fetch-panel.mjs; the bump workflow updates both.
ARG PANEL_VERSION=v1.26.7
ARG PANEL_SHA256=8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; base=https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases; \
  if [ "${PANEL_VERSION}" = latest ]; then url="$base/latest/download/management.html"; \
  else url="$base/download/${PANEL_VERSION}/management.html"; fi; \
  mkdir -p /panel && curl -fsSL --retry 5 --retry-all-errors -o /panel/management.html "$url"; \
  if [ -n "${PANEL_SHA256}" ]; then echo "${PANEL_SHA256}  /panel/management.html" | sha256sum -c -; fi
WORKDIR /CLIProxyAPI
COPY --from=builder /out/CLIProxyAPI ./CLIProxyAPI
COPY entrypoint.sh /entrypoint.sh
ENV MANAGEMENT_STATIC_PATH=/panel/management.html
EXPOSE 8317
ENTRYPOINT ["/entrypoint.sh"]
