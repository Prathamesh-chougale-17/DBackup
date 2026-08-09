import type { ExecutionHost } from "@/lib/transport";
import type { AzureSQLConfig } from "@/lib/adapters/definitions";
import type { DatabaseInfo } from "@/lib/core/interfaces";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { mapWithConcurrency } from "@/lib/concurrency";
import { withPool } from "./pool";
import { getDatabases } from "./connection";

const log = logger.child({ adapter: "azure-sql" });

/**
 * One TDS connection per database, so the explorer must not open dozens at once.
 * Azure counts concurrent sessions against the service tier, and a Basic database
 * allows very few.
 */
const STATS_CONCURRENCY = 8;

/**
 * Size and table count per database.
 *
 * The MSSQL adapter answers this with one query against `sys.master_files` plus
 * cross-database `[db].sys.tables` lookups. Neither works here: `sys.master_files`
 * is server scoped and does not exist on Azure SQL Database, and three-part names
 * are rejected outright. Every database therefore needs its own connection, which
 * is why the fan-out is bounded.
 *
 * A database that cannot be read degrades to a name with no size rather than
 * failing the call. Letting one throw would reproduce exactly the bug this adapter
 * exists downstream of, where a single missing catalog view took out the whole
 * Database Explorer page.
 */
export async function getDatabasesWithStats(
    config: AzureSQLConfig,
    host: ExecutionHost,
): Promise<DatabaseInfo[]> {
    const names = await getDatabases(config, host);
    if (names.length === 0) return [];

    return mapWithConcurrency(names, STATS_CONCURRENCY, async (name): Promise<DatabaseInfo> => {
        try {
            return await withPool(
                config,
                host,
                async (pool) => {
                    const [sizeResult, tableResult] = await Promise.all([
                        // type = 0 is the data files. The log is excluded deliberately: a
                        // BACPAC never contains it, so counting it would overstate what a
                        // backup of this database is going to cost.
                        pool.request().query(`
                            SELECT SUM(CAST(size AS BIGINT)) * 8 * 1024 AS size_bytes
                            FROM sys.database_files
                            WHERE type = 0
                        `),
                        pool.request().query(`SELECT COUNT(*) AS cnt FROM sys.tables`),
                    ]);

                    const sizeBytes = sizeResult.recordset[0]?.size_bytes;

                    return {
                        name,
                        sizeInBytes: sizeBytes != null ? Number(sizeBytes) : undefined,
                        tableCount: Number(tableResult.recordset[0]?.cnt) || 0,
                    };
                },
                { database: name },
            );
        } catch (error: unknown) {
            log.warn("Could not read database details", { database: name }, wrapError(error));
            return { name, tableCount: 0 };
        }
    });
}
