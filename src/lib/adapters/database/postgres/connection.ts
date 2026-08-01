import type { ExecutionHost } from "@/lib/transport";
import { execFile } from "child_process";
import util from "util";
import { PostgresConfig } from "@/lib/adapters/definitions";
import {
    SshClient,
    isSSHMode,
    extractSshConfig,
    buildPsqlArgs,
    remoteEnv,
    remoteBinaryCheck,
    shellEscape,
} from "@/lib/ssh";

export const execFileAsync = util.promisify(execFile);

export async function test(config: PostgresConfig, _host?: ExecutionHost): Promise<{ success: boolean; message: string; version?: string }> {
    if (isSSHMode(config)) {
        const sshConfig = extractSshConfig(config)!;
        const ssh = new SshClient();
        try {
            await ssh.connect(sshConfig);
            await remoteBinaryCheck(ssh, "psql");
            const args = buildPsqlArgs(config);
            const env: Record<string, string | undefined> = {};
            if (config.password) env.PGPASSWORD = config.password;

            const dbsToTry = ['postgres', 'template1'];
            if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

            for (const db of dbsToTry) {
                const cmd = remoteEnv(env, `psql ${args.join(" ")} -d ${shellEscape(db)} -t -c 'SELECT version()'`);
                const result = await ssh.exec(cmd);
                if (result.code === 0) {
                    const rawVersion = result.stdout.trim();
                    const versionMatch = rawVersion.match(/PostgreSQL\s+([\d.]+)/);
                    const version = versionMatch ? versionMatch[1] : rawVersion;
                    return { success: true, message: "Connection successful (via SSH)", version };
                }
            }
            return { success: false, message: "SSH connection to PostgreSQL failed" };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, message: `SSH connection failed: ${msg}` };
        } finally {
            ssh.end();
        }
    }

    const dbsToTry = ['postgres', 'template1'];
    if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

    const env = { ...process.env, PGPASSWORD: config.password };
    let lastError: unknown;

    for (const db of dbsToTry) {
        try {
            const args = ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', db, '-t', '-c', 'SELECT version()'];
            const { stdout } = await execFileAsync('psql', args, { env });

            // Extract version number only (e.g. "PostgreSQL 16.1 on ..." → "16.1")
            const rawVersion = stdout.trim();
            const versionMatch = rawVersion.match(/PostgreSQL\s+([\d.]+)/);
            const version = versionMatch ? versionMatch[1] : rawVersion;

            return { success: true, message: "Connection successful", version };
        } catch (error: unknown) {
            lastError = error;
        }
    }
    const errMsg = lastError instanceof Error
        ? (lastError as { stderr?: string }).stderr || lastError.message
        : String(lastError);
    return { success: false, message: "Connection failed: " + errMsg };
}

export async function getDatabases(config: PostgresConfig, _host: ExecutionHost): Promise<string[]> {
    if (isSSHMode(config)) {
        const sshConfig = extractSshConfig(config)!;
        const ssh = new SshClient();
        try {
            await ssh.connect(sshConfig);
            const args = buildPsqlArgs(config);
            const env: Record<string, string | undefined> = {};
            if (config.password) env.PGPASSWORD = config.password;

            const dbsToTry = ['postgres', 'template1'];
            if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

            for (const db of dbsToTry) {
                const cmd = remoteEnv(env, `psql ${args.join(" ")} -d ${shellEscape(db)} -t -A -c 'SELECT datname FROM pg_database WHERE datistemplate = false;'`);
                const result = await ssh.exec(cmd);
                if (result.code === 0) {
                    return result.stdout.split('\n').map(s => s.trim()).filter(s => s);
                }
            }
            throw new Error("Failed to list databases via SSH");
        } finally {
            ssh.end();
        }
    }

    const dbsToTry = ['postgres', 'template1'];
    if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

    const env = { ...process.env, PGPASSWORD: config.password };
    let lastError: unknown;

    for (const db of dbsToTry) {
        try {
            // -t = tuples only (no header/footer), -A = unaligned
            const args = ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', db, '-t', '-A', '-c', 'SELECT datname FROM pg_database WHERE datistemplate = false;'];
            const { stdout } = await execFileAsync('psql', args, { env });
            return stdout.split('\n').map(s => s.trim()).filter(s => s);
        } catch (error: unknown) {
            lastError = error;
        }
    }
    throw lastError;
}

import { DatabaseInfo } from "@/lib/core/interfaces";

// NOTE: PostgreSQL's information_schema.tables is scoped to the currently connected
// database, so a single-query cross-database table count is not possible.
// We fetch sizes in one query, then run a separate per-database query for table counts.
const pgStatsQuery = `
    SELECT d.datname, pg_database_size(d.datname) AS size_bytes FROM pg_database d WHERE d.datistemplate = false ORDER BY d.datname;
`.trim();

const pgTableCountQuery = `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');`;

function parseStatsOutput(stdout: string): DatabaseInfo[] {
    return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line)
        .map(line => {
            const parts = line.split('\t');
            return {
                name: parts[0],
                sizeInBytes: parseInt(parts[1], 10) || 0,
            };
        });
}

async function countTablesInDatabase(config: PostgresConfig, dbName: string): Promise<number | undefined> {
    const env = { ...process.env, PGPASSWORD: config.password };
    const args = ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', dbName, '-t', '-A', '-c', pgTableCountQuery];
    try {
        const { stdout } = await execFileAsync('psql', args, { env });
        const count = parseInt(stdout.trim(), 10);
        return isNaN(count) ? undefined : count;
    } catch {
        return undefined;
    }
}

async function countTablesViaSsh(
    ssh: SshClient,
    args: string[],
    env: Record<string, string | undefined>,
    dbName: string,
): Promise<number | undefined> {
    const cmd = remoteEnv(env, `psql ${args.join(" ")} -d ${shellEscape(dbName)} -t -A -c ${shellEscape(pgTableCountQuery)}`);
    const result = await ssh.exec(cmd);
    if (result.code !== 0) return undefined;
    const count = parseInt(result.stdout.trim(), 10);
    return isNaN(count) ? undefined : count;
}

export async function getDatabasesWithStats(config: PostgresConfig, _host: ExecutionHost): Promise<DatabaseInfo[]> {
    if (isSSHMode(config)) {
        const sshConfig = extractSshConfig(config)!;
        const ssh = new SshClient();
        try {
            await ssh.connect(sshConfig);
            const args = buildPsqlArgs(config);
            const env: Record<string, string | undefined> = {};
            if (config.password) env.PGPASSWORD = config.password;

            const dbsToTry = ['postgres', 'template1'];
            if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

            for (const db of dbsToTry) {
                const cmd = remoteEnv(env, `psql ${args.join(" ")} -d ${shellEscape(db)} -t -A -F '\t' -c ${shellEscape(pgStatsQuery)}`);
                const result = await ssh.exec(cmd);
                if (result.code === 0) {
                    const statsResults = parseStatsOutput(result.stdout);
                    const withTableCounts = await Promise.all(
                        statsResults.map(async (dbEntry) => {
                            const tableCount = await countTablesViaSsh(ssh, args, env, dbEntry.name);
                            return tableCount !== undefined ? { ...dbEntry, tableCount } : dbEntry;
                        })
                    );
                    return withTableCounts;
                }
            }
            throw new Error("Failed to get database stats via SSH");
        } finally {
            ssh.end();
        }
    }

    const dbsToTry = ['postgres', 'template1'];
    if (typeof config.database === 'string' && config.database) dbsToTry.push(config.database);

    const env = { ...process.env, PGPASSWORD: config.password };
    let lastError: unknown;

    for (const db of dbsToTry) {
        try {
            const args = ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', db, '-t', '-A', '-F', '\t', '-c', pgStatsQuery];
            const { stdout } = await execFileAsync('psql', args, { env });
            const statsResults = parseStatsOutput(stdout);
            const withTableCounts = await Promise.all(
                statsResults.map(async (dbEntry) => {
                    const tableCount = await countTablesInDatabase(config, dbEntry.name);
                    return tableCount !== undefined ? { ...dbEntry, tableCount } : dbEntry;
                })
            );
            return withTableCounts;
        } catch (error: unknown) {
            lastError = error;
        }
    }
    throw lastError;
}
