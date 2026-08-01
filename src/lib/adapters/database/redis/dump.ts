import type { ExecutionHost } from "@/lib/transport";
import { BackupResult } from "@/lib/core/interfaces";
import { LogLevel, LogType } from "@/lib/core/logs";
import { spawn } from "child_process";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { buildConnectionArgs } from "./connection";
import { RedisConfig } from "@/lib/adapters/definitions";
import {
    SshClient,
    isSSHMode,
    extractSshConfig,
    buildRedisArgs,
    remoteBinaryCheck,
    shellEscape,
} from "@/lib/ssh";
import { randomUUID } from "crypto";

/**
 * Dump Redis database using RDB snapshot
 *
 * Uses `redis-cli --rdb` to download the RDB file directly from the server.
 * This is the recommended method for remote backups.
 *
 * Note: RDB contains ALL databases (0-15), not just the selected one.
 */
export async function dump(
    config: RedisConfig,
    destinationPath: string,
    _host: ExecutionHost,
    onLog?: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void,
    _onProgress?: (percentage: number) => void
): Promise<BackupResult> {
    if (isSSHMode(config)) {
        return dumpSSH(config, destinationPath, onLog);
    }

    const startedAt = new Date();
    const logs: string[] = [];

    const log = (msg: string, level: LogLevel = "info", type: LogType = "general", details?: string) => {
        logs.push(msg);
        if (onLog) onLog(msg, level, type, details);
    };

    try {
        log("Starting Redis RDB backup...", "info");

        // Build connection args
        const args = buildConnectionArgs(config);

        // Add --rdb flag with destination path
        args.push("--rdb", destinationPath);

        // Mask password in logs
        const logArgs = args.map(arg => {
            if (arg === config.password) return "******";
            return arg;
        });
        const command = `redis-cli ${logArgs.join(" ")}`;
        log("Executing redis-cli", "info", "command", command);

        // Execute redis-cli --rdb
        const rdbProcess = spawn("redis-cli", args);

        let stderr = "";

        rdbProcess.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        rdbProcess.stdout.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg) log(msg, "info");
        });

        // Wait for process to complete
        await new Promise<void>((resolve, reject) => {
            rdbProcess.on("close", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`redis-cli exited with code ${code}: ${stderr}`));
                }
            });
            rdbProcess.on("error", reject);
        });

        // Verify the dump file exists and has content
        const stats = await fs.stat(destinationPath);
        if (stats.size === 0) {
            throw new Error("RDB dump file is empty");
        }

        log(`RDB backup completed successfully (${stats.size} bytes)`, "success");

        return {
            success: true,
            path: destinationPath,
            size: stats.size,
            logs,
            startedAt,
            completedAt: new Date(),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Backup failed: ${message}`, "error");
        return {
            success: false,
            logs,
            error: message,
            startedAt,
            completedAt: new Date(),
        };
    }
}

/**
 * SSH variant: run redis-cli --rdb on remote, then stream the file back.
 * redis-cli --rdb writes to a file (not stdout), so we use a remote temp file.
 */
async function dumpSSH(
    config: RedisConfig,
    destinationPath: string,
    onLog?: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void,
): Promise<BackupResult> {
    const startedAt = new Date();
    const logs: string[] = [];
    const log = (msg: string, level: LogLevel = "info", type: LogType = "general", details?: string) => {
        logs.push(msg);
        if (onLog) onLog(msg, level, type, details);
    };

    const sshConfig = extractSshConfig(config)!;
    const ssh = new SshClient();
    const remoteTempFile = `/tmp/dbackup_redis_${randomUUID()}.rdb`;

    try {
        await ssh.connect(sshConfig);
        const redisBin = await remoteBinaryCheck(ssh, "redis-cli");
        const args = buildRedisArgs(config);

        // TLS flag
        if ((config as any).tls) args.push("--tls");
        // Database selection
        if (config.database !== undefined && config.database !== 0) {
            args.push("-n", String(config.database));
        }

        log("Starting Redis RDB backup (SSH)...", "info");

        // 1. Run redis-cli --rdb on remote to create temp file
        const rdbCmd = `${redisBin} ${args.join(" ")} --rdb ${shellEscape(remoteTempFile)}`;
        log("Executing remote redis-cli --rdb", "info", "command", rdbCmd.replace(config.password || '___NONE___', '******'));

        const rdbResult = await ssh.exec(rdbCmd);
        if (rdbResult.code !== 0) {
            throw new Error(`Remote redis-cli --rdb failed: ${rdbResult.stderr}`);
        }

        // 2. Stream remote file back to local
        log("Streaming RDB file from remote...", "info");
        const writeStream = createWriteStream(destinationPath);

        await new Promise<void>((resolve, reject) => {
            ssh.execStream(`cat ${shellEscape(remoteTempFile)}`, (err, stream) => {
                if (err) return reject(err);

                stream.pipe(writeStream);

                stream.on('exit', (code: number | null, signal?: string) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Failed to stream RDB from remote (code ${code ?? 'null'}${signal ? `, signal: ${signal}` : ''})`));
                });

                stream.on('error', (err: Error) => reject(err));
                writeStream.on('error', (err: Error) => reject(err));
            });
        });

        // 3. Verify local file
        const stats = await fs.stat(destinationPath);
        if (stats.size === 0) {
            throw new Error("RDB dump file is empty");
        }

        log(`RDB backup completed successfully via SSH (${stats.size} bytes)`, "success");

        return {
            success: true,
            path: destinationPath,
            size: stats.size,
            logs,
            startedAt,
            completedAt: new Date(),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Backup failed: ${message}`, "error");
        return {
            success: false,
            logs,
            error: message,
            startedAt,
            completedAt: new Date(),
        };
    } finally {
        // Cleanup remote temp file
        await ssh.exec(`rm -f ${shellEscape(remoteTempFile)}`).catch(() => {});
        ssh.end();
    }
}
