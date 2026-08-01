import { DatabaseAdapter } from "@/lib/core/interfaces";
import { LogLevel, LogType } from "@/lib/core/logs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import { SshClient, shellEscape, extractSqliteSshConfig } from "@/lib/ssh";
import { SQLiteConfig } from "@/lib/adapters/definitions";

export const dump: DatabaseAdapter["dump"] = async (config, destinationPath, _host, onLog, onProgress) => {
    const startedAt = new Date();
    const mode = config.mode || "local";
    const logs: string[] = [];

    const log = (msg: string, level: LogLevel = 'info', type: LogType = 'general', details?: string) => {
        logs.push(msg);
        if (onLog) onLog(msg, level, type, details);
    };

    try {
        log(`Starting SQLite dump in ${mode} mode...`);

        if (mode === "local") {
            return await dumpLocal(config as SQLiteConfig, destinationPath, log, onProgress).then(res => ({
                ...res,
                startedAt,
                completedAt: new Date(),
                logs
            }));
        } else if (mode === "ssh") {
            return await dumpSsh(config as SQLiteConfig, destinationPath, log, onProgress).then(res => ({
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
        log(`Error during dump: ${message}`);
        return {
            success: false,
            error: message,
            logs,
            startedAt,
            completedAt: new Date()
        };
    }
};

async function dumpLocal(config: SQLiteConfig, destinationPath: string, log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void, _onProgress?: (percent: number) => void): Promise<any> {
    const binaryPath = config.sqliteBinaryPath || "sqlite3";
    const dbPath = config.path;

    log(`Dumping database: ${dbPath}`, 'info', 'command', `${binaryPath} "${dbPath}" ".backup ${destinationPath}"`);

    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, [dbPath, `.backup ${destinationPath}`]);

        child.stderr.on("data", (data) => {
            log(`SQLite stderr`, 'warning', 'general', data.toString().trim());
        });

        child.on("close", (code) => {
            if (code === 0) {
                log("Dump complete", 'success');
                fs.stat(destinationPath, (err, stats) => {
                    if (err) resolve({ success: true });
                    else resolve({ success: true, size: stats.size, path: destinationPath });
                });
            } else {
                reject(new Error(`SQLite dump process failed with code ${code}`));
            }
        });

        child.on("error", (err) => {
            reject(err);
        });
    });
}

async function dumpSsh(config: SQLiteConfig, destinationPath: string, log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void, _onProgress?: (percent: number) => void): Promise<any> {
    const client = new SshClient();
    const binaryPath = config.sqliteBinaryPath || "sqlite3";
    const dbPath = config.path;

    const sshConfig = extractSqliteSshConfig(config);
    if (!sshConfig) throw new Error("SSH host and username are required");
    await client.connect(sshConfig);
    log("SSH connection established");

    const remoteTempFile = `/tmp/dbackup_sqlite_dump_${randomUUID()}.db`;

    try {
        // Step 1: create a binary backup on the remote machine via .backup
        const backupCmd = `${shellEscape(binaryPath)} ${shellEscape(dbPath)} ".backup ${remoteTempFile}"`;
        log(`Creating binary backup on remote: ${dbPath}`, 'info', 'command', `${binaryPath} ${dbPath} ".backup /tmp/..."`);
        const backupResult = await client.exec(backupCmd);
        if (backupResult.code !== 0) {
            throw new Error(`Remote backup failed (code ${backupResult.code}): ${backupResult.stderr.trim()}`);
        }

        // Step 2: stream the binary backup file back via cat
        const writeStream = fs.createWriteStream(destinationPath);
        log("Streaming binary backup from remote...");

        return new Promise((resolve, reject) => {
            client.execStream(`cat ${shellEscape(remoteTempFile)}`, (err, stream) => {
                if (err) {
                    client.exec(`rm -f ${shellEscape(remoteTempFile)}`).catch(() => {}).finally(() => client.end());
                    return reject(err);
                }

                stream.pipe(writeStream);

                stream.stderr.on("data", (data: any) => {
                    log(`SQLite stderr`, 'warning', 'general', data.toString().trim());
                });

                stream.on("exit", (code: number | null, signal?: string) => {
                    client.exec(`rm -f ${shellEscape(remoteTempFile)}`).catch(() => {}).finally(() => client.end());
                    if (code === 0) {
                        log("Dump complete", 'success');
                        fs.stat(destinationPath, (err, stats) => {
                            if (err) resolve({ success: true });
                            else resolve({ success: true, size: stats.size, path: destinationPath });
                        });
                    } else {
                        reject(new Error(`Remote process exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`));
                    }
                });
            });
        });
    } catch (err) {
        await client.exec(`rm -f ${shellEscape(remoteTempFile)}`).catch(() => {});
        client.end();
        throw err;
    }
}
