#!/bin/sh
set -e

# The public key arrives through a read-only bind mount, so it carries the
# host user's ownership. sshd's StrictModes rejects an authorized_keys file
# that root does not own, so it gets installed rather than mounted in place.
if [ -f /keys/authorized_keys ]; then
    install -m 600 -o root -g root /keys/authorized_keys /root/.ssh/authorized_keys
else
    echo "No /keys/authorized_keys mounted - run pnpm test:integration, which generates the key pair." >&2
    exit 1
fi

# Host keys are generated per container, never baked into the image or the
# repository. A test client accepts whatever key it is offered anyway.
ssh-keygen -A

# SQLite has no server to connect to: a source names a file on the target host.
# Seed one so the SSH path has something real to dump and restore.
SQLITE_DB=/data/testdb.sqlite
if [ ! -f "$SQLITE_DB" ]; then
    mkdir -p /data
    sqlite3 "$SQLITE_DB" \
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         INSERT INTO items (name) VALUES ('alpha'), ('beta'), ('gamma');"
fi

exec /usr/sbin/sshd -D -e
