import type { ExecutionHost } from "@/lib/transport";
import type { MSSQLConfig } from "@/lib/adapters/definitions";
import { executeParameterizedQuery } from "./connection";
import { stripTrailingSlashes } from "@/lib/paths";

/**
 * Verify that SQL Server's backup directory is usable from DBackup's side.
 *
 * The .bak file is written by SQL Server into `backupPath` and then has to be
 * read (or, on restore, written) from wherever DBackup reaches the files. A
 * mistake here only shows up as an empty or missing .bak in the middle of a
 * backup, so the connection test checks it up front.
 *
 * Replaces MssqlSshTransfer.testBackupPath, which did the same thing over its
 * own SFTP session.
 */
export async function checkBackupPath(
    host: ExecutionHost,
    backupPath: string,
): Promise<{ readable: boolean; writable: boolean; error?: string }> {
    const stats = await host.stat(backupPath).catch(() => null);
    if (!stats) {
        return { readable: false, writable: false, error: `Path not found: ${backupPath}` };
    }
    if (!stats.isDirectory) {
        return { readable: false, writable: false, error: `Not a directory: ${backupPath}` };
    }

    // The probe goes into backupPath itself. host.withTempFile would write into
    // the host's temp directory, which proves nothing about this path.
    const probe = probePath(backupPath);
    try {
        const created = await host.exec(["touch", probe]);
        if (created.code !== 0) {
            return { readable: true, writable: false, error: created.stderr.trim() };
        }
        await host.removeFile(probe).catch(() => {});
        return { readable: true, writable: true };
    } catch (error: unknown) {
        return {
            readable: true,
            writable: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function probePath(backupPath: string): string {
    // stripTrailingSlashes, not `/\/+$/`. That regex backtracks quadratically on
    // a long run of slashes, and backupPath comes straight from a stored config.
    return `${stripTrailingSlashes(backupPath)}/.dbackup_probe`;
}

/**
 * Verify that SQL Server and the SSH account mean the *same* directory.
 *
 * checkBackupPath only looks from the SSH side. A containerized SQL Server
 * writes into its own `/var/opt/mssql/backup`, and the SSH account can have a
 * directory of that name too - both checks pass, and the backup then fails on
 * the download with nothing but "No such file". This creates a file over SSH
 * and asks SQL Server whether it can see it.
 *
 * Returns `null` when the question cannot be answered, which is not a failure:
 * xp_fileexist is an undocumented procedure and a locked-down login may not be
 * allowed to run it.
 */
export async function checkBackupPathShared(
    config: MSSQLConfig,
    host: ExecutionHost,
    backupPath: string,
): Promise<{ shared: boolean } | null> {
    const probe = probePath(backupPath);

    const created = await host.exec(["touch", probe]).catch(() => null);
    if (!created || created.code !== 0) return null;

    try {
        const result = await executeParameterizedQuery(
            config,
            host,
            "EXEC master.dbo.xp_fileexist @path",
            { path: probe },
        );

        const row = result.recordset?.[0] as Record<string, unknown> | undefined;
        const exists = row?.["File Exists"];
        if (exists === undefined) return null;

        return { shared: Boolean(exists) };
    } catch {
        return null;
    } finally {
        await host.removeFile(probe).catch(() => {});
    }
}
