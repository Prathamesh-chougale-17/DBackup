import { DatabaseAdapter } from "@/lib/core/interfaces";
import type { ExecutionHost } from "@/lib/transport";

export const prepareRestore: NonNullable<DatabaseAdapter["prepareRestore"]> = async () => {
    // SQLite needs no preparation: the restore replaces a single file.
};

/**
 * Move the current database aside before it is replaced.
 *
 * The direct path used fs calls and the SSH path an inline `if [ -f ... ]` shell
 * construct with a `$(date +%s)` suffix. Both are now the same argv commands
 * with the timestamp computed here, so the two modes cannot drift apart.
 */
async function backupExisting(
    host: ExecutionHost,
    dbPath: string,
    log: (msg: string) => void,
): Promise<void> {
    const existing = await host.stat(dbPath);
    if (!existing) {
        log("No existing database to back up.");
        return;
    }

    const backupPath = `${dbPath}.bak-${Date.now()}`;
    log(`Backing up existing database to ${backupPath}`);

    const copied = await host.exec(["cp", dbPath, backupPath]);
    if (copied.code !== 0) {
        throw new Error(`Could not back up the existing database: ${copied.stderr.trim()}`);
    }

    log("Removing existing database file before restore...");
    const removed = await host.exec(["rm", "-f", dbPath]);
    if (removed.code !== 0) {
        throw new Error(`Could not remove the existing database: ${removed.stderr.trim()}`);
    }
}

export const restore: DatabaseAdapter["restore"] = async (config, sourcePath, host, onLog, onProgress) => {
    const startedAt = new Date();
    const logs: string[] = [];

    const log = (msg: string) => {
        logs.push(msg);
        if (onLog) onLog(msg);
    };

    try {
        if (!host) {
            throw new Error("SQLite adapter requires an execution host. Call it through withHost().");
        }

        const dbPath = config.path as string;
        const binary = await host.which((config.sqliteBinaryPath as string) || "sqlite3");

        log(`Starting SQLite restore of ${dbPath}...`);
        await backupExisting(host, dbPath, log);

        // `.restore` reads from a path, so the backup file is staged onto the
        // execution host. On a direct host that is the original file, no copy.
        await host.stageInput(sourcePath, {}, async (stagedPath) => {
            onProgress?.(50);

            const argv = [binary, dbPath, `.restore ${stagedPath}`];
            log(`Executing: ${argv.join(" ")}`);

            const result = await host.exec(argv);
            if (result.code !== 0) {
                throw new Error(
                    `SQLite restore failed with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
                );
            }
            if (result.stderr.trim()) {
                log(`[SQLite Stderr]: ${result.stderr.trim()}`);
            }
        });

        onProgress?.(100);
        log("Restore completed successfully.");

        return { success: true, logs, startedAt, completedAt: new Date() };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error during restore: ${message}`);
        return {
            success: false,
            error: message,
            logs,
            startedAt,
            completedAt: new Date(),
        };
    }
};
