#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${RENNET_RELEASE_ENV_FILE:-"$repo_root/.env.release.local"}

if [ ! -f "$env_file" ]; then
  echo "release-env: missing $env_file" >&2
  exit 1
fi

set -a
. "$env_file"
set +a

missing=""
for name in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    missing="$missing $name"
  fi
done
unset value

if [ -n "$missing" ]; then
  echo "release-env: missing required values:$missing" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: pnpm release:env -- <command> [args...]" >&2
  exit 2
fi

exec "$@"
