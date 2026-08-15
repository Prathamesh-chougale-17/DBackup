import type { ExecutionHost } from "@/lib/transport";
import type { AzureSQLConfig } from "@/lib/adapters/definitions";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { withPool } from "./pool";
import { resolveExporter } from "./exporter";

const log = logger.child({ adapter: "azure-sql" });

/** Azure SQL Database. Every other value belongs to a different product. */
const ENGINE_EDITION_AZURE_SQL_DATABASE = 5;

/**
 * What to tell someone who pointed this adapter at something else.
 *
 * Worth being specific about. The three engines below all answer on port 1433 with
 * a TDS handshake and look identical until the first catalog query, so "connection
 * failed" would send people looking at firewalls.
 */
function describeWrongEngine(engineEdition: number): string {
    switch (engineEdition) {
        case 8:
            return "This server is Azure SQL Managed Instance, not Azure SQL Database. Managed Instance is not supported by DBackup: it only accepts BACKUP DATABASE as TO URL against Azure Blob Storage, which neither adapter implements.";
        case 6:
        case 11:
            return "This server is Azure Synapse Analytics, which is not supported.";
        case 9:
            return "This server is Azure SQL Edge. Use the Microsoft SQL Server source type, which backs it up natively.";
        default:
            return "This server is a regular SQL Server instance, not Azure SQL Database. Use the Microsoft SQL Server source type, which produces a native .bak and is the better backup for it.";
    }
}

/**
 * Verify the connection, the engine, and that a BACPAC can actually be produced.
 *
 * The exporter probe is part of the connection test on purpose. A missing
 * SqlPackage is not a connection problem, but discovering it here costs one click
 * and discovering it later costs a failed scheduled run.
 */
export async function test(
    config: AzureSQLConfig,
    host?: ExecutionHost,
): Promise<{ success: boolean; message: string; version?: string; edition?: string }> {
    try {
        const result = await withPool(config, host!, (pool) => pool.request().query(`
            SELECT
                SERVERPROPERTY('ProductVersion') AS ProductVersion,
                SERVERPROPERTY('EngineEdition') AS EngineEdition,
                DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective') AS ServiceObjective
        `));

        const row = result.recordset[0] ?? {};
        const engineEdition = Number(row.EngineEdition) || 0;

        if (engineEdition !== ENGINE_EDITION_AZURE_SQL_DATABASE) {
            return { success: false, message: describeWrongEngine(engineEdition) };
        }

        // Azure SQL Database has reported 12.0.2000 for years regardless of the
        // engine actually running. Surfaced because the version history column
        // expects something, never used to pick behaviour.
        const productVersion = String(row.ProductVersion || "");
        const version = /^(\d+\.\d+\.\d+)/.exec(productVersion)?.[1] || productVersion;
        const tier = row.ServiceObjective ? ` ${row.ServiceObjective}` : "";

        const probe = await resolveExporter().probe(config, host!);
        if (!probe.ok) {
            return {
                success: false,
                message: `Connected to Azure SQL Database, but backups cannot run: ${probe.detail}`,
                version,
                edition: "Azure SQL Database",
            };
        }

        return {
            success: true,
            message: `Connection successful (Azure SQL Database${tier})`,
            version,
            edition: "Azure SQL Database",
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("Login failed")) {
            return { success: false, message: "Login failed. Check the user name and password." };
        }
        if (message.includes("ETIMEOUT") || message.includes("ECONNREFUSED")) {
            return {
                success: false,
                message: "Could not reach the server. Check the server name, and that a firewall rule allows this machine's IP address.",
            };
        }
        if (message.includes("not allowed to access")) {
            return {
                success: false,
                message: "The server rejected this client. Add a firewall rule for this machine's IP address in the Azure portal.",
            };
        }

        return { success: false, message: `Connection failed: ${message}` };
    }
}

/**
 * User databases on the logical server.
 *
 * The MSSQL adapter filters on `database_id > 4` to skip the four system
 * databases. Azure SQL Database has only `master`, and its user databases get ids
 * assigned per server with no guarantee about the range, so the filter is by name.
 */
export async function getDatabases(config: AzureSQLConfig, host: ExecutionHost): Promise<string[]> {
    try {
        const result = await withPool(config, host, (pool) => pool.request().query(`
            SELECT name
            FROM sys.databases
            WHERE name <> 'master' AND state = 0
            ORDER BY name
        `));

        return result.recordset.map((row: { name: string }) => row.name);
    } catch (error: unknown) {
        log.error("Failed to list databases", {}, wrapError(error));
        return [];
    }
}
