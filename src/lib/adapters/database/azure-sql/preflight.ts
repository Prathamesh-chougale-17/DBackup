import type { ExecutionHost } from "@/lib/transport";
import type { AzureSQLConfig } from "@/lib/adapters/definitions";
import { logger } from "@/lib/logging/logger";
import { withPool } from "./pool";
import { assertValidDatabaseName } from "./identifiers";

const log = logger.child({ adapter: "azure-sql" });

/**
 * Check that a restore can actually land, before an Execution row exists.
 *
 * An existing target is not an error here. Every other adapter replaces what it
 * restores over - MSSQL uses `WITH REPLACE`, PostgreSQL `--clean`, MongoDB
 * `--drop` - and the restore dialog already makes the user pick between overwrite
 * and rename, showing which databases it would replace. Refusing here would break
 * a choice the user has already made deliberately.
 *
 * A BACPAC import still cannot overwrite in place, so `restore()` drops the target
 * first. That is destructive in the same way the other adapters are, with a better
 * safety net than most: Azure keeps deleted databases restorable for the retention
 * window of its own automated backups.
 */
export async function prepareRestore(
    config: AzureSQLConfig,
    databases: string[],
    host: ExecutionHost,
): Promise<void> {
    for (const name of databases) {
        assertValidDatabaseName(name);
    }

    await withPool(config, host, async (pool) => {
        await warnIfCannotCreateDatabases(pool);
    });
}

/**
 * Warn when the login looks unable to create databases.
 *
 * A warning and not a refusal, deliberately. Creating a database on Azure SQL
 * Database needs membership in `dbmanager` in master, but the server administrator
 * login holds the same power without being a member, so `IS_ROLEMEMBER` reports 0
 * for an account that will succeed. Refusing on that signal would lock out the most
 * common setup of all, which is worse than a restore that fails later with Azure's
 * own error.
 */
async function warnIfCannotCreateDatabases(pool: {
    request: () => { query: (q: string) => Promise<{ recordset: Record<string, unknown>[] }> };
}): Promise<void> {
    try {
        const result = await pool.request().query(`
            SELECT
                IS_ROLEMEMBER('dbmanager') AS is_dbmanager,
                IS_MEMBER('db_owner') AS is_db_owner
        `);

        const row = result.recordset[0] ?? {};
        if (Number(row.is_dbmanager) !== 1 && Number(row.is_db_owner) !== 1) {
            log.warn("Restore target login is not a member of dbmanager", { user: "redacted" });
        }
    } catch {
        // Not answerable on every tier or for every login. Silence is correct here:
        // the question was only ever advisory.
    }
}
