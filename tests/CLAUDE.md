# Testing

Vitest. Unit tests in `tests/unit/`, integration tests in `tests/integration/`, audit tests in `tests/audit/`.

```bash
pnpm test                    # Unit tests (watch mode)
pnpm test:coverage           # Unit tests with coverage
pnpm test:integration        # Integration tests, manages containers (scripts/run-integration-tests.sh)
pnpm test:integration:run    # Integration tests against already-running containers
pnpm test:env:up             # Start test DB containers
pnpm test:env:down           # Stop them
pnpm test:ui                 # Containers + seeded local DB for manual UI testing
```

Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration).

## Unit tests

- Mock every external call - network, filesystem, child processes, Prisma.
- When mocking `fetch`, the mocked response must match the API convention (`{ success: true, data: ... }`). A mock returning a bare object passes the test and lies about production behavior.
- `describe` and `it` blocks name the business case, not the function. `it("rejects a restore onto an older server version")` beats `it("returns false")`.

## Integration tests

- Run against real services. Container definitions live in [docker-compose.test.yml](../docker-compose.test.yml).
- Connection configs and CLI requirements live in `tests/integration/test-configs.ts` (`testDatabases`, `CLI_REQUIREMENTS`). A new testable adapter adds a service there and an entry here.
- Tests must leave no persistent data in the local dev database. Use transactions or transient containers.
- Skip cleanly when a required container or CLI tool is unavailable rather than failing the suite.

## What needs a test

- New adapters that can run in CI - at minimum `test()`, `dump()`, and `restore()` round-trip.
- Services with branching business logic - retention (GFS), integrity checks, restore preflight.
- Permission guards on new Server Actions and API routes.
- Bug fixes - a regression test that fails against the old code.

Pure UI rendering and thin Server Action wrappers do not need dedicated tests.

## Conventions

- Test files sit next to their category in `tests/`, not beside the source file.
- No real credentials or production endpoints, ever. Not even commented out.
- Do not assert on log output. Assert on returned values and persisted state.
