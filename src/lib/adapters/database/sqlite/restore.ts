import { DatabaseAdapter } from "@/lib/core/interfaces";
import { spawn } from "child_process";
import fs from "fs";
import { SshClient, shellEscape, extractSqliteSshConfig } from "@/lib/ssh";
import { SQLiteConfig } from "@/lib/adapters/definitions";
import { randomUUID } from "crypto";

export const prepareRestore: NonNullable<DatabaseAdapter["prepareRestore"]> = async (_config, _databases) => {
     // No major prep needed for SQLite mostly, but could check write permissions here
};

export const restore: DatabaseAdapter["restore"] = async (config, sourcePath, _host, onLog, onProgress) => {
    const startedAt = new Date();
    const mode = config.mode || "local";
    const logs: string[] = [];

    const log = (msg: string) => {
        logs.push(msg);
        if (onLog) onLog(msg);
    };

    try {
        log(`Starting SQLite restore in ${mode} mode...`);

        if (mode === "local") {
            return await restoreLocal(config as SQLiteConfig, sourcePath, log, onProgress).then(res => ({
                ...res,
                startedAt,
                completedAt: new Date(),
                logs
            }));
        } else if (mode === "ssh") {
            return await restoreSsh(config as SQLiteConfig, sourcePath, log, onProgress).then(res => ({
                ...res,
                startedAt,
                completedAt: new Date(),
                logs
            }));
        } else {
            throw new Error(`Invalid mode: ${mode}`);
        }

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error during restore: ${message}`);
        return {
            success: false,
            error: message,
            logs,
            startedAt,
            completedAt: new Date()
        };
    }
};

async function restoreLocal(config: SQLiteConfig, sourcePath: string, log: (msg: string) => void, onProgress?: (percent: number) => void): Promise<any> {
    const binaryPath = config.sqliteBinaryPath || "sqlite3";
    const dbPath = config.path;

    // Safety backup
    if (fs.existsSync(dbPath)) {
        const backupPath = `${dbPath}.bak-${Date.now()}`;
        log(`Backing up existing database to ${backupPath}`);
        fs.copyFileSync(dbPath, backupPath);

        log(`Removing existing database file before restore...`);
        fs.unlinkSync(dbPath);
    }

    log(`Executing: ${binaryPath} "${dbPath}" ".restore ${sourcePath}"`);

    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, [dbPath, `.restore ${sourcePath}`]);

        child.stderr.on("data", (data) => {
            log(`[SQLite Stderr]: ${data.toString()}`);
        });

        child.on("close", (code) => {
            if (code === 0) {
                if (onProgress) onProgress(100);
                log("Restore completed successfully.");
                resolve({ success: true });
            } else {
                reject(new Error(`SQLite restore process failed with code ${code}`));
            }
        });

        child.on("error", (err) => {
            reject(err);
        });
    });
}

async function restoreSsh(config: SQLiteConfig, sourcePath: string, log: (msg: string) => void, onProgress?: (percent: number) => void): Promise<any> {
    const client = new SshClient();
    const binaryPath = config.sqliteBinaryPath || "sqlite3";
    const dbPath = config.path;

    const sshConfig = extractSqliteSshConfig(config);
    if (!sshConfig) throw new Error("SSH host and username are required");
    await client.connect(sshConfig);
    log("SSH connection established.");

    const remoteTempFile = `/tmp/dbackup_sqlite_restore_${randomUUID()}.db`;

    try {
        // Create remote backup and delete original
        log("Creating remote backup of existing DB and cleaning up...");
        const escapedPath = shellEscape(dbPath);
        const backupCmd = `if [ -f ${escapedPath} ]; then cp ${escapedPath} ${escapedPath}.bak-$(date +%s); rm ${escapedPath}; echo "Backed up and removed old DB"; else echo "No existing DB"; fi`;
        await client.exec(backupCmd);

        // 1. Upload SQL dump to remote via SFTP
        const totalSize = (await fs.promises.stat(sourcePath)).size;
        log(`Uploading dump to remote server via SFTP (${(totalSize / 1024 / 1024).toFixed(1)} MB)...`);
        await client.uploadFile(sourcePath, remoteTempFile);

        // Verify upload integrity
        try {
            const sizeCheck = await client.exec(`stat -c '%s' ${shellEscape(remoteTempFile)} 2>/dev/null || stat -f '%z' ${shellEscape(remoteTempFile)}`);
            const remoteSize = parseInt(sizeCheck.stdout.trim(), 10);
            if (remoteSize !== totalSize) {
                throw new Error(`Upload size mismatch! Local: ${totalSize}, Remote: ${remoteSize}`);
            }
            log(`Upload verified: ${(remoteSize / 1024 / 1024).toFixed(1)} MB`);
        } catch (e) {
            if (e instanceof Error && e.message.includes('mismatch')) throw e;
        }

        if (onProgress) onProgress(50);

        // 2. Restore the binary backup on the remote server via .restore
        const command = `${shellEscape(binaryPath)} ${escapedPath} ".restore ${remoteTempFile}"`;
        log(`Executing remote command: ${binaryPath} ${dbPath}`);
        const result = await client.exec(command);
        if (result.code !== 0) {
            throw new Error(`Remote restore failed (code ${result.code}): ${result.stderr.trim()}`);
        }
        if (result.stderr) {
            log(`[Remote Stderr]: ${result.stderr}`);
        }

        if (onProgress) onProgress(100);
        log("Remote restore completed successfully.");

        return { success: true };
    } finally {
        // Cleanup remote temp file
        await client.exec(`rm -f ${shellEscape(remoteTempFile)}`).catch(() => {});
        client.end();
    }
}


