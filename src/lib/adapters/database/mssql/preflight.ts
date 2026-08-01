import type { ExecutionHost } from "@/lib/transport";
import type { MSSQLConfig } from "@/lib/adapters/definitions";
import { executeParameterizedQuery } from "./connection";
import { stripTrailingSlashes } from "@/lib/paths";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

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

    try {
        await writeProbe(host, backupPath);
        await host.removeFile(probePath(backupPath)).catch(() => {});
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
 * Drop an empty file into the backup directory.
 *
 * Uses the file transfer rather than a remote `touch`, for two reasons. It is
 * what the backup itself does - the .bak comes back over SFTP - so the probe
 * exercises the mechanism that has to work, instead of a shell command that
 * might succeed on a host where the transfer would not. And it keeps the path
 * out of a command line altogether: nothing here is ever parsed by a shell.
 *
 * The probe goes into backupPath itself. host.withTempFile would write into the
 * host's temp directory, which proves nothing about this path.
 */
async function writeProbe(host: ExecutionHost, backupPath: string): Promise<void> {
    const local = path.join(os.tmpdir(), `dbackup-probe-${randomUUID()}`);
    await fs.writeFile(local, "");
    try {
        await host.putFile(local, probePath(backupPath));
    } finally {
        await fs.unlink(local).catch(() => {});
    }
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

    const created = await writeProbe(host, backupPath).then(() => true, () => false);
    if (!created) return null;

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
