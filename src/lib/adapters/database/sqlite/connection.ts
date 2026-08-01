import { transportSuffix } from "@/lib/transport";
import { DatabaseAdapter } from "@/lib/core/interfaces";

const NO_HOST_MESSAGE = "SQLite adapter requires an execution host. Call it through withHost().";

/** The sqlite3 binary, honouring an explicitly configured path. */
function binaryOf(config: Record<string, unknown>): string {
    return (config.sqliteBinaryPath as string) || "sqlite3";
}

const TABLE_COUNT_QUERY =
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";

export const test: NonNullable<DatabaseAdapter["test"]> = async (config, host) => {
    if (!host) {
        return { success: false, message: NO_HOST_MESSAGE };
    }

    const dbPath = config.path as string;
    const via = transportSuffix(host);

    try {
        const binary = await host.which(binaryOf(config));

        const versionResult = await host.exec([binary, "--version"]);
        if (versionResult.code !== 0) {
            return { success: false, message: versionResult.stderr.trim() || "sqlite3 is not available" };
        }
        // "3.37.0 2021-11-27 ..." -> "3.37.0"
        const version = versionResult.stdout.split(" ")[0].trim();

        // The transport reports file metadata the same way on both sides, so
        // this replaces the fs.access / `test -f` pair.
        const stats = await host.stat(dbPath);
        if (!stats) {
            return { success: false, message: `Database file at '${dbPath}' not found.` };
        }

        return { success: true, message: `SQLite connection successful${via}.`, version };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${message}` };
    }
};

export const getDatabases: NonNullable<DatabaseAdapter["getDatabases"]> = async (config) => {
    // For SQLite the path itself is the database, so its filename is the name.
    const path = config.path as string;
    return [path.split(/[\\/]/).pop() || "database.sqlite"];
};

export const getDatabasesWithStats: NonNullable<DatabaseAdapter["getDatabasesWithStats"]> = async (config, host) => {
    const dbPath = config.path as string;
    const name = dbPath.split(/[\\/]/).pop() || "database.sqlite";

    if (!host) return [{ name }];

    let sizeInBytes: number | undefined;
    let tableCount: number | undefined;

    try {
        const stats = await host.stat(dbPath);
        sizeInBytes = stats?.size;

        const binary = await host.which(binaryOf(config));
        const result = await host.exec([binary, dbPath, TABLE_COUNT_QUERY]);
        if (result.code === 0) {
            const count = parseInt(result.stdout.trim(), 10);
            if (!Number.isNaN(count)) tableCount = count;
        }
    } catch {
        // Size and table count are both optional, the name alone is still useful.
    }

    return [{ name, sizeInBytes, tableCount }];
};
