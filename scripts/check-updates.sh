#!/usr/bin/env bash
# List outdated dependencies for the app, the docs site and the marketing site.
# Usage: pnpm update:check

set -uo pipefail

BOLD='\033[1m'
NC='\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Each project is installed on its own (the repo has no pnpm-workspace.yaml, and CI and
# the Dockerfile run `pnpm install` per directory), so they are checked the same way.
# `pnpm outdated --recursive` would instead treat them as workspace members, which drops
# their local `pnpm.overrides` and warns about it on every run.
for project in "." "docs" "website"; do
  name="$([ "$project" = "." ] && echo "app" || echo "$project")"
  printf "${BOLD}── %s ──${NC}\n" "$name"
  # `pnpm outdated` exits 1 whenever it finds something, the way `diff` does. That is the
  # normal result for this script, so it must not end the run.
  (cd "$ROOT/$project" && pnpm outdated) || true
  echo ""
done
