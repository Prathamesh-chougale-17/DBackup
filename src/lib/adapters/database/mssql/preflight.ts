import type { ExecutionHost } from "@/lib/transport";

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
    const probe = `${backupPath.replace(/\/+$/, "")}/.dbackup_probe`;
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
