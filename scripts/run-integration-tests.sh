#!/bin/bash
set -e

# The ssh-host container needs its authorized_keys before compose starts it.
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensure-ssh-test-key.sh"

# Check if containers are already running appropriately
if [ "$(docker compose -f docker-compose.test.yml ps -q)" ]; then
    echo "ℹ️  Containers are already running. Will keep them running after tests."
    KEEP_RUNNING=true
else
    echo "🐳 Starting Test Database Containers..."
    docker compose -f docker-compose.test.yml up -d
    KEEP_RUNNING=false
fi

echo "⏳ Waiting for databases to be healthy..."
# A simple wait loop or just wait for specific healthchecks
# Since we defined healthchecks in docker-compose, we can wait for them.

# Docker Compose V2
docker compose -f docker-compose.test.yml ps

if [ "$KEEP_RUNNING" = false ]; then
    echo "⚠️  Note: If this is the first run, databases might take a few seconds to initialize even after container start."
    echo "⏳ Waiting 30s for DB initialization... (Press any key to skip wait)"
    read -t 30 -n 1 -s -r || true
    echo "" # New line after skip/timeout
fi

# Setup MSSQL testdb (MSSQL doesn't auto-create databases like MySQL/PostgreSQL)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/setup-mssql-testdb.sh" || echo "⚠️ MSSQL setup had issues (non-fatal)"

echo "🧪 Running Integration Tests..."
npm run test:integration:run

if [ "$KEEP_RUNNING" = false ]; then
    echo "🧹 Teardown..."
    docker compose -f docker-compose.test.yml down
else
    echo "🛑 Skipping teardown (containers were already running)."
fi
