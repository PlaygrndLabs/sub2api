FROM golang:1.26-bookworm AS builder
# "latest" builds the newest CPA release tag at build time; set a tag such as v8.0.45 to pin one.
ARG CPA_VERSION=latest
ENV GOTOOLCHAIN=auto
WORKDIR /src
RUN set -eu; repo=https://github.com/router-for-me/CLIProxyAPI.git; tag="${CPA_VERSION}"; \
  if [ "$tag" = latest ]; then \
    tag=$(git ls-remote --tags --refs "$repo" | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1); \
  fi; \
  echo "Building CPA $tag"; \
  git init -q . && git remote add origin "$repo" \
  && git fetch -q --depth 1 origin tag "$tag" && git checkout -q "$tag" \
  && printf '%s' "$tag" > /tmp/cpa-version
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false \
  -ldflags="-s -w -X 'main.Version=$(cat /tmp/cpa-version)' -X 'main.Commit=$(git rev-parse HEAD)'" \
  -o /out/CLIProxyAPI ./cmd/server/

FROM debian:bookworm-slim
# The dashboard follows CPA: "latest" takes the newest release. Pin a tag, and optionally its
# PANEL_SHA256, to freeze it.
ARG PANEL_VERSION=latest
ARG PANEL_SHA256=""
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
