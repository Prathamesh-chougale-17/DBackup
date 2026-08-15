import type { ExecutionHost } from "@/lib/transport";
import { withPool } from "./pool";
import sql from "mssql";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { MSSQLConfig } from "@/lib/adapters/definitions";

const log = logger.child({ adapter: "mssql" });

/**
 * `SERVERPROPERTY('EngineEdition')` values.
 *
 * This is the reliable signal, not the edition string. Azure SQL Database answers
 * `SERVERPROPERTY('Edition')` with "SQL Azure", which the name parsing below used
 * to reduce to the meaningless "SQL".
 */
const ENGINE_EDITION = {
    PERSONAL: 1,
    STANDARD: 2,
    ENTERPRISE: 3,
    EXPRESS: 4,
    AZURE_SQL_DATABASE: 5,
    AZURE_SYNAPSE: 6,
    AZURE_SQL_MANAGED_INSTANCE: 8,
    AZURE_SQL_EDGE: 9,
    AZURE_SYNAPSE_SERVERLESS: 11,
} as const;

/**
 * Why this adapter structurally cannot back up an engine, or null when it can.
 *
 * The Azure PaaS editions accept a connection, report a version and list their
 * databases, so nothing before the first BACKUP statement gives them away. What
 * surfaces there is "Statement 'BACKUP DATABASE' is not supported in this version
 * of SQL Server", which names neither the product refusing nor the way forward.
 */
function describeUnsupportedEngine(engineEdition: number): string | null {
    switch (engineEdition) {
        case ENGINE_EDITION.AZURE_SQL_DATABASE:
            return "Azure SQL Database is not supported by this adapter. It has no BACKUP DATABASE statement at all, so a native .bak can never be produced from it.";
        case ENGINE_EDITION.AZURE_SQL_MANAGED_INSTANCE:
            return "Azure SQL Managed Instance is not supported. It accepts BACKUP DATABASE only as TO URL against Azure Blob Storage with COPY_ONLY, never TO DISK, and this adapter reads the .bak back off a filesystem.";
        case ENGINE_EDITION.AZURE_SYNAPSE:
        case ENGINE_EDITION.AZURE_SYNAPSE_SERVERLESS:
            return "Azure Synapse Analytics is not supported. It has no BACKUP DATABASE statement.";
        default:
            return null;
    }
}

/** Human-readable edition, keyed off EngineEdition before falling back to the name. */
function describeEdition(engineEdition: number, editionRaw: string, fullVersion: string): string {
    switch (engineEdition) {
        case ENGINE_EDITION.AZURE_SQL_DATABASE: return "Azure SQL Database";
        case ENGINE_EDITION.AZURE_SQL_MANAGED_INSTANCE: return "Azure SQL Managed Instance";
        case ENGINE_EDITION.AZURE_SYNAPSE: return "Azure Synapse Analytics";
        case ENGINE_EDITION.AZURE_SYNAPSE_SERVERLESS: return "Azure Synapse Analytics (serverless)";
        case ENGINE_EDITION.AZURE_SQL_EDGE: return "Azure SQL Edge";
    }

    if (fullVersion.includes("Azure SQL Edge")) return "Azure SQL Edge";

    const lower = editionRaw.toLowerCase();
    if (lower.includes("express")) return "Express";
    if (lower.includes("standard")) return "Standard";
    if (lower.includes("enterprise")) return "Enterprise";
    if (lower.includes("developer")) return "Developer";
    if (lower.includes("web")) return "Web";

    return editionRaw.split(" ")[0] || "Unknown";
}

/** Product name for the connection-test message. */
function describeProduct(engineEdition: number, fullVersion: string): string {
    switch (engineEdition) {
        case ENGINE_EDITION.AZURE_SQL_DATABASE: return "Azure SQL Database";
        case ENGINE_EDITION.AZURE_SQL_MANAGED_INSTANCE: return "Azure SQL Managed Instance";
        case ENGINE_EDITION.AZURE_SYNAPSE:
        case ENGINE_EDITION.AZURE_SYNAPSE_SERVERLESS: return "Azure Synapse Analytics";
    }

    if (fullVersion.includes("Azure SQL Edge")) return "Azure SQL Edge";
    if (fullVersion.includes("2022")) return "SQL Server 2022";
    if (fullVersion.includes("2019")) return "SQL Server 2019";
    if (fullVersion.includes("2017")) return "SQL Server 2017";

    return "SQL Server";
}

/**
 * Refuse an engine this adapter cannot back up, before any work starts.
 *
 * test() reports the same thing, but a scheduled job never calls test(), and the
 * runner swallows its result anyway. Without this the first sign of trouble is a
 * failed run at 03:00 quoting a T-SQL error.
 */
export async function assertBackupSupported(config: MSSQLConfig, host: ExecutionHost): Promise<void> {
    let engineEdition: number;
    try {
        const result = await executeQuery(config, host, "SELECT SERVERPROPERTY('EngineEdition') AS EngineEdition");
        engineEdition = Number(result.recordset[0]?.EngineEdition) || 0;
    } catch {
        // A server that will not answer this cannot be classified, and refusing on
        // that basis would break setups this adapter has always handled. Let the
        // operation continue and fail on its own terms.
        return;
    }

    const reason = describeUnsupportedEngine(engineEdition);
    if (reason) throw new Error(reason);
}

/**
 * Test connection and retrieve version
 */
export async function test(config: MSSQLConfig, host?: ExecutionHost): Promise<{ success: boolean; message: string; version?: string; edition?: string }> {
    try {
        const result = await withPool(config, host!, (pool) => pool.request().query(`
            SELECT
                @@VERSION AS Version,
                SERVERPROPERTY('ProductVersion') AS ProductVersion,
                SERVERPROPERTY('Edition') AS Edition,
                SERVERPROPERTY('EngineEdition') AS EngineEdition
        `));

        const fullVersion = result.recordset[0]?.Version || "";
        const productVersion = result.recordset[0]?.ProductVersion || "";
        const editionRaw = result.recordset[0]?.Edition || "";
        const engineEdition = result.recordset[0]?.EngineEdition || 0;

        // Parse version: "16.0.1000.6" -> major.minor.build
        const versionMatch = productVersion.match(/^(\d+\.\d+\.\d+)/);
        const version = versionMatch ? versionMatch[1] : productVersion;

        const edition = describeEdition(engineEdition, editionRaw, fullVersion);
        const friendlyName = describeProduct(engineEdition, fullVersion);

        // Reported as a failed test rather than a warning, because a source this
        // adapter cannot back up is not a working source. The health check turning
        // it offline is what tells the user to switch adapters. Version and edition
        // still come back so the run log and version history stay accurate.
        const unsupported = describeUnsupportedEngine(engineEdition);
        if (unsupported) {
            return { success: false, message: unsupported, version, edition };
        }

        return {
            success: true,
            message: `Connection successful (${friendlyName} ${edition})`,
            version,
            edition,
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // Provide helpful error messages
        if (message.includes("ECONNREFUSED")) {
            return { success: false, message: "Connection refused. Check host/port." };
        }
        if (message.includes("Login failed")) {
            return { success: false, message: "Login failed. Check username/password." };
        }
        if (message.includes("certificate")) {
            return { success: false, message: "Certificate error. Try enabling 'Trust Server Certificate'." };
        }

        return { success: false, message: `Connection failed: ${message}` };
    }
}

/**
 * Get list of user databases (exclude system databases)
 */
export async function getDatabases(config: MSSQLConfig, host: ExecutionHost): Promise<string[]> {
    try {
        // Exclude system databases (database_id <= 4: master, tempdb, model, msdb)
        const result = await withPool(config, host, (pool) => pool.request().query(`
            SELECT name
            FROM sys.databases
            WHERE database_id > 4
              AND state = 0
            ORDER BY name
        `));

        return result.recordset.map((row: any) => row.name);
    } catch (error: unknown) {
        log.error("Failed to get databases", {}, wrapError(error));
        return [];
    }
}

import { DatabaseInfo } from "@/lib/core/interfaces";

/**
 * Get user databases with size and table count information
 */
export async function getDatabasesWithStats(config: MSSQLConfig, host: ExecutionHost): Promise<DatabaseInfo[]> {
    try {
        return await withPool(config, host, async (pool) => {
        const { rows, sizesAvailable } = await readDatabaseCatalog(pool);

        // Get table counts per database via cross-database sys.tables queries.
        // INFORMATION_SCHEMA.TABLES only returns tables for the current DB context,
        // so we query each database individually.
        const databases: DatabaseInfo[] = [];

        for (const row of rows) {
            let tableCount = 0;
            try {
                const safeName = row.name.replace(/\]/g, "]]");
                const tableResult = await pool.request().query(
                    `SELECT COUNT(*) AS cnt FROM [${safeName}].sys.tables`
                );
                tableCount = tableResult.recordset[0]?.cnt ?? 0;
            } catch {
                // Database may be inaccessible (permission, offline) - default to 0
            }

            databases.push({
                name: row.name,
                // Undefined rather than 0 when sizes could not be read at all. The
                // explorer drops the whole column when no database reports one,
                // which beats a table full of confident zeroes.
                sizeInBytes: sizesAvailable ? (row.size_bytes != null ? Number(row.size_bytes) : 0) : undefined,
                tableCount,
            });
        }

        return databases;
        });
    } catch (error: unknown) {
        log.error("Failed to get databases with stats", {}, wrapError(error));
        throw wrapError(error);
    }
}

/**
 * User databases with their allocated size, falling back to names alone.
 *
 * `sys.master_files` is server-scoped and does not exist on Azure SQL Database,
 * where the join fails with "Invalid object name 'sys.master_files'". Letting that
 * escape took out the entire Database Explorer with a "Connection Failed" card,
 * even though the connection was fine and the names were perfectly readable. A
 * list without sizes beats no list.
 *
 * All user databases are included regardless of state, so offline and restoring
 * ones stay visible.
 */
async function readDatabaseCatalog(
    pool: sql.ConnectionPool,
): Promise<{ rows: { name: string; size_bytes?: unknown }[]; sizesAvailable: boolean }> {
    try {
        const result = await pool.request().query(`
            SELECT
                d.name,
                d.state_desc,
                SUM(CAST(mf.size AS BIGINT)) * 8 * 1024 AS size_bytes
            FROM sys.databases d
            LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
            WHERE d.database_id > 4
            GROUP BY d.name, d.state_desc
            ORDER BY d.name
        `);
        return { rows: result.recordset, sizesAvailable: true };
    } catch (error: unknown) {
        log.warn("Database sizes unavailable, listing names only", {
            reason: error instanceof Error ? error.message : String(error),
        });

        const result = await pool.request().query(`
            SELECT name, state_desc
            FROM sys.databases
            WHERE database_id > 4
            ORDER BY name
        `);
        return { rows: result.recordset, sizesAvailable: false };
    }
}

/**
 * SQL Server message captured during query execution
 */
export interface SqlServerMessage {
    message: string;
    number: number;
    state: number;
    class: number;
    serverName?: string;
    procName?: string;
}

/**
 * Result from executeQueryWithMessages including captured SQL Server messages
 */
export interface QueryResultWithMessages {
    result: sql.IResult<any>;
    messages: SqlServerMessage[];
}

/**
 * Execute a SQL query and return raw results
 * Used internally by dump/restore operations
 */
export async function executeQuery(
    config: MSSQLConfig,
    host: ExecutionHost,
    query: string,
    database?: string,
): Promise<sql.IResult<any>> {
    return withPool(config, host, (pool) => pool.request().query(query), { database });
}

/**
 * Execute a SQL query while capturing all SQL Server info/error messages.
 * Essential for BACKUP/RESTORE operations where the actual error details
 * are sent as informational messages before the final error is thrown.
 *
 * @param requestTimeout Override request timeout (0 = no timeout). Defaults to config value.
 * @param onMessage Optional callback invoked for each SQL Server info message in real-time.
 */
export async function executeQueryWithMessages(
    config: MSSQLConfig,
    host: ExecutionHost,
    query: string,
    database?: string,
    requestTimeout?: number,
    onMessage?: (msg: SqlServerMessage) => void
): Promise<QueryResultWithMessages> {
    const messages: SqlServerMessage[] = [];

    try {
        return await withPool(config, host, async (pool) => {
            const request = pool.request();

            // Capture all SQL Server info messages (progress reports, warnings, errors)
            request.on("info", (info: SqlServerMessage) => {
                messages.push(info);
                if (onMessage) onMessage(info);
            });

            const result = await request.query(query);
            return { result, messages };
        }, { database, requestTimeout });
    } catch (error: unknown) {
        // Enhance the error with captured SQL Server messages
        const serverMessages = messages
            .filter((m) => m.class > 0)
            .map((m) => m.message)
            .filter(Boolean);

        // Extract preceding errors from mssql RequestError.
        // SQL Server sends the actual cause (e.g. "Cannot open backup device..."
        // or "Operating system error 5") as a preceding error BEFORE the generic
        // "BACKUP DATABASE is terminating abnormally" message.
        if (error && typeof error === "object" && "precedingErrors" in error) {
            const precedingErrors = (error as { precedingErrors?: unknown[] }).precedingErrors;
            if (Array.isArray(precedingErrors)) {
                for (const pe of precedingErrors) {
                    const msg = pe && typeof pe === "object" && "message" in pe
                        ? (pe as { message: string }).message
                        : undefined;
                    if (msg) {
                        serverMessages.unshift(msg);
                    }
                }
            }
        }

        if (serverMessages.length > 0 && error instanceof Error) {
            // Prepend detail messages so the actual cause is visible
            const details = serverMessages.join(" | ");
            error.message = `${error.message} - Details: ${details}`;
        }

        throw error;
    }
}

/**
 * Execute a parameterized SQL query (safe from SQL injection)
 * Used for queries with user-provided values
 */
export async function executeParameterizedQuery(
    config: MSSQLConfig,
    host: ExecutionHost,
    query: string,
    params: Record<string, string | number | boolean>,
    database?: string
): Promise<sql.IResult<any>> {
    return withPool(config, host, (pool) => {
        const request = pool.request();
        for (const [key, value] of Object.entries(params)) {
            request.input(key, value);
        }
        return request.query(query);
    }, { database });
}

/**
 * Check if the SQL Server edition supports backup compression
 * Supported in: Enterprise, Standard (SQL 2008 R2+), Business Intelligence, Developer
 * NOT supported in: Express, Web
 */
export async function supportsCompression(config: MSSQLConfig, host: ExecutionHost): Promise<boolean> {
    try {
        const result = await executeQuery(
            config,
            host,
            "SELECT SERVERPROPERTY('Edition') AS Edition, SERVERPROPERTY('EngineEdition') AS EngineEdition"
        );

        const edition = result.recordset[0]?.Edition || "";
        const engineEdition = result.recordset[0]?.EngineEdition || 0;

        // EngineEdition values:
        // 1 = Express (no compression)
        // 2 = Standard (compression supported)
        // 3 = Enterprise (compression supported)
        // 4 = Express (no compression)
        // 5 = Azure SQL Database (depends on service tier)
        // 6 = Azure Synapse Analytics
        // 8 = Azure SQL Managed Instance (compression supported)
        // 9 = Azure SQL Edge (no compression by default)

        // Express editions don't support compression
        if (edition.toLowerCase().includes("express")) {
            return false;
        }

        // Web edition doesn't support compression
        if (edition.toLowerCase().includes("web")) {
            return false;
        }

        // Azure SQL Edge uses EngineEdition 9, limited compression support
        if (engineEdition === 9) {
            return false;
        }

        // All other editions (Enterprise, Standard, Developer) support compression
        return engineEdition >= 2 && engineEdition <= 3 || engineEdition === 8;
    } catch {
        // If we can't determine, don't use compression to be safe
        return false;
    }
}
