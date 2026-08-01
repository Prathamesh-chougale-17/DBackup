
# Integration Testing Strategy

This folder contains integration tests that run against real database instances.
Because these tests require Docker containers (Postgres, MySQL, Mongo), they are **not** run by default with `npm test`.

## Prerequisites

1.  Docker must be running.
2.  Install dependencies: `npm install`

## How to Run

Ideally, use a specialized runner or variable:

```bash
# Run all integration tests (WARNING: Heavy)
npm run test:integration
```

## SSH mode

`ssh-mode.test.ts` runs the same operations against the `ssh-host` container,
which is a Debian image with sshd and the database client tools installed.

What makes it a real check rather than a mock: each source names its database
by **compose service name** (`postgres-12`, `mariadb-11`), which resolves only
from inside that container. If the transport ever silently fell back to direct
mode, the hostname would not resolve and the test would fail. It also means
these tests pass on a machine with no database client installed locally - the
tools live on the target.

The key pair is generated into `.ssh-test/` by `scripts/ensure-ssh-test-key.sh`,
which both `pnpm test:integration` and `pnpm test:env:up` call. It is gitignored,
so no private key ever enters the repository.

The whole file skips cleanly when port 22022 is not reachable, so running the
suite without the container is not an error.

Two engines are covered by an older version than the direct tests use, in both
cases because a client cannot read a server newer than itself:

| Engine | Covered | Why not the newest |
| :--- | :--- | :--- |
| MySQL | 5.7 | MySQL 9 removed `mysql_native_password`, Debian's MariaDB client cannot authenticate against what replaced it |
| PostgreSQL | 12 | `pg_dump` refuses a server newer than itself, Debian 12 ships client 15 |

MongoDB and Firebird are not covered: their tools are not in Debian's default
repositories. The Multipass VM (`pnpm test:vm:up`) remains the way to exercise
those and to test against a real distribution's package set.

## Structure

We verify:
1.  **Connectivity** (test method)
2.  **Backup** (dump)
3.  **Restore** (restore)

For the following versions:
*   PostgreSQL: 12, 16
*   MySQL: 5.7, 8
*   MariaDB: 10
*   MongoDB: 6

(Note: We test a subset of versions to keep CI time reasonable, assuming intermediate versions work if edges work).
