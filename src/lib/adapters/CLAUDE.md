# Adapter System

Plugin architecture for databases, storage destinations, and notification channels. Contracts in `src/lib/core/interfaces.ts`, registration in `src/lib/core/registry.ts`.

```typescript
DatabaseAdapter      -> dump(), restore(), test(), ping(), getDatabases()
StorageAdapter       -> upload(), download(), list(), delete(), ping()
NotificationAdapter  -> send()

registry.register(MySQLAdapter);
registry.get("mysql");
```

Run `ls src/lib/adapters/{database,storage,notification}/` for the current adapter list. Never rely on a list written in a doc.

## Adding an adapter - the full checklist

A complete adapter touches 8 to 11 files. Missing one produces a "half-registered adapter" that looks fine in code review and breaks at runtime or renders with a fallback icon. Work through every line:

1. **`{database|storage|notification}/<name>.ts`** - implement the interface. Use `<name>/index.ts` if the adapter needs sub-modules.
2. **`definitions/{database|storage|notification}.ts`** - the Zod config schema (`NewAdapterSchema`).
3. **`definitions/index.ts`** - an entry in `ADAPTER_DEFINITIONS` with `id`, `type`, `name`, `configSchema`, and `group` for storage.
4. **`index.ts`** - import the class and call `registry.register(...)` inside `registerAdapters()`.
5. **`src/lib/core/credential-requirements.ts`** - an entry in `ADAPTER_CREDENTIAL_REQUIREMENTS[id]` if the adapter supports credential profiles.
6. **`src/components/adapter/utils.ts`** - add to `ADAPTER_ICON_MAP` (and `ADAPTER_COLOR_MAP` where applicable). Skipping this leaves a generic fallback icon in the UI.
7. **`src/components/adapter/form-constants.ts`** - field keys in the relevant `*_CONNECTION_KEYS` / `*_CONFIG_KEYS`, plus `PLACEHOLDERS`, if the adapter needs custom form grouping.
8. **`src/lib/backup-extensions.ts`** - database adapters only: dump file extension and description.
9. **Tests**, if the adapter is testable in CI: a service in `docker-compose.test.yml` and entries in `tests/integration/test-configs.ts` (`testDatabases`, `CLI_REQUIREMENTS`).
10. **Docs**: a page under `docs/user-guide/{sources|destinations|notifications}/<name>.md` following the template in [docs/CLAUDE.md](../../../docs/CLAUDE.md), plus a row in the matching `docs/developer-guide/adapters/*.md` table.
11. **Changelog**: one `### ✨ Features` entry, component prefix is the adapter name.

## Connectivity methods

| Method | Behavior | Used by |
| :--- | :--- | :--- |
| `test()` | Full write and delete verification, roughly 15 s timeout | Manual "Test connection" in the UI |
| `ping()` | Lightweight reachability check, writes nothing | Health check system (every minute) |

`ping()` is optional. The health check falls back to `test()` when it is missing - but a `test()` running every minute against every adapter is expensive, so implement `ping()` for anything that can answer cheaply.

## Multi-database TAR format

All database adapters share one archive format for multi-database backups:

- Utilities: `database/common/tar-utils.ts`
- Types: `database/common/types.ts` (`TarManifest`, `DatabaseEntry`)
- The TAR contains `manifest.json` plus one dump file per database.
- **Single-database backups stay direct dump files** with no TAR wrapper. Do not wrap them.

## Security

Adapters handle decrypted credentials and build shell commands for external CLI tools (`mysqldump`, `pg_dump`, `mongodump`).

- Never interpolate user-controlled values into a shell string. Pass arguments as an array to `spawn`, not a concatenated command to `exec`.
- Never log a config object - it holds decrypted secrets. Log specific non-secret fields only.
- Sanitize file paths from user input in storage adapters. Backup and restore paths are a path-traversal surface.
- Adapter errors throw `AdapterError` from `@/lib/logging/errors` so the runner can attribute the failure.

## Config decryption

Adapter configs are stored encrypted. `decryptConfig(obj)` from `@/lib/crypto` recursively decrypts before the adapter receives them. Adapters receive plaintext config and must never write it back or forward it anywhere.
