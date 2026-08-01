#!/bin/bash
#
# Ephemeral SSH key pair for the ssh-host test container.
#
# Generated rather than committed, so the repository holds no private key and
# every checkout gets its own. Must run before `docker compose up`: the public
# key is bind-mounted into the container, and Docker would otherwise create
# .ssh-test as an empty root-owned directory and sshd would have no key to
# authorize against.
#
# Safe to run repeatedly. Called by both `pnpm test:integration` and
# `pnpm test:env:up`.
set -e

KEY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.ssh-test"

if [ ! -f "$KEY_DIR/id_ed25519" ]; then
    echo "🔑 Generating an ephemeral SSH key pair for the SSH-mode tests..."
    mkdir -p "$KEY_DIR"
    ssh-keygen -t ed25519 -N "" -C "dbackup-integration-test" -f "$KEY_DIR/id_ed25519" -q
fi

# The container installs this with root ownership, since sshd's StrictModes
# rejects an authorized_keys file that a bind mount left owned by the host user.
cp "$KEY_DIR/id_ed25519.pub" "$KEY_DIR/authorized_keys"
