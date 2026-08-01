import type { ExecutionHost } from "@/lib/transport";
import { execFile } from "child_process";
import { promisify } from "util";
import { SshClient, shellEscape, extractSqliteSshConfig, remoteBinaryCheck } from "@/lib/ssh";
import { TableInfo, ColumnInfo, TableDataOptions, TableDataResult } from "@/lib/core/interfaces";

const execFileAsync = promisify(execFile);

/** Sanitize a SQLite identifier for double-quote quoting. */
function escapeIdentifier(name: string): string {
    return name.replace(/"/g, '""').replace(/\0/g, "");
}

/** Parse PRAGMA table_info output (pipe-separated: cid|name|type|notnull|dflt_value|pk). */
function parsePragmaTableInfo(stdout: string): ColumnInfo[] {
    return stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split("|");
            return {
                name: parts[1] ?? "",
                dataType: parts[2] ?? "TEXT",
                nullable: parts[3] === "0",
                primaryKey: parts[5] === "1",
                defaultValue: parts[4] && parts[4] !== "" ? parts[4] : undefined,
            };
        });
}

function parseDataRows(
    stdout: string,
    columns: ColumnInfo[]
): Record<string, unknown>[] {
    return stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const values = line.split("\t");
            const row: Record<string, unknown> = {};
            columns.forEach((col, i) => {
                row[col.name] = values[i] ?? null;
            });
            return row;
        });
}

/** Sanitize a SQLite string value for use in a single-quoted SQL literal. */
function escapeSqliteLiteral(value: string): string {
    return value.replace(/'/g, "''").replace(/\0/g, "");
}

export async function getTables(config: Record<string, unknown>, _database: string, _host: ExecutionHost): Promise<TableInfo[]> {
    const dbPath = config.path as string;
    const mode = (config.mode as string) || "local";
    const binaryPath = (config.sqliteBinaryPath as string) || "sqlite3";
    const query = `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;`;

    if (mode === "ssh") {
        const sshConfig = extractSqliteSshConfig(config);
        if (!sshConfig) throw new Error("SSH host and username are required");

        const client = new SshClient();
        try {
            await client.connect(sshConfig);
            const bin = await remoteBinaryCheck(client, binaryPath);
            const result = await client.exec(`${shellEscape(bin)} ${shellEscape(dbPath)} ${shellEscape(query)}`);
            if (result.code !== 0) throw new Error(`Failed to list tables: ${result.stderr}`);
            const tables: TableInfo[] = result.stdout
                .split("\n")
                .map(l => l.trim())
                .filter(Boolean)
                .map(line => {
                    const [name, rawType] = line.split("|");
                    return { name, type: rawType === "view" ? "view" as const : "table" as const };
                });
            return await enrichWithRowCountsSsh(client, bin, dbPath, tables);
        } finally {
            client.end();
        }
    }

    const { stdout } = await execFileAsync(binaryPath, [dbPath, query]);
    const tables: TableInfo[] = stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const [name, rawType] = line.split("|");
            return { name, type: rawType === "view" ? "view" as const : "table" as const };
        });
    return enrichWithRowCounts(binaryPath, dbPath, tables);
}

async function enrichWithRowCounts(binaryPath: string, dbPath: string, tables: TableInfo[]): Promise<TableInfo[]> {
    const tableNames = tables.filter(t => t.type === "table").map(t => t.name);
    if (tableNames.length === 0) return tables;
    const countQuery = tableNames
        .map(name => `SELECT count(*) FROM "${escapeIdentifier(name)}"`)
        .join(" UNION ALL ");
    try {
        const { stdout: countOut } = await execFileAsync(binaryPath, [dbPath, `${countQuery};`]);
        const rowCounts = new Map<string, number>();
        countOut.split("\n").map(l => l.trim()).filter(Boolean).forEach((line, i) => {
            if (i < tableNames.length) {
                const count = parseInt(line, 10);
                if (!isNaN(count)) rowCounts.set(tableNames[i], count);
            }
        });
        return tables.map(t => (t.type === "table" && rowCounts.has(t.name) ? { ...t, rowCount: rowCounts.get(t.name) } : t));
    } catch {
        return tables;
    }
}

async function enrichWithRowCountsSsh(client: SshClient, bin: string, dbPath: string, tables: TableInfo[]): Promise<TableInfo[]> {
    const tableNames = tables.filter(t => t.type === "table").map(t => t.name);
    if (tableNames.length === 0) return tables;
    const countQuery = tableNames
        .map(name => `SELECT count(*) FROM "${escapeIdentifier(name)}"`)
        .join(" UNION ALL ");
    const countResult = await client.exec(`${shellEscape(bin)} ${shellEscape(dbPath)} ${shellEscape(`${countQuery};`)}`);
    if (countResult.code !== 0) return tables;
    const rowCounts = new Map<string, number>();
    countResult.stdout.split("\n").map(l => l.trim()).filter(Boolean).forEach((line, i) => {
        if (i < tableNames.length) {
            const count = parseInt(line, 10);
            if (!isNaN(count)) rowCounts.set(tableNames[i], count);
        }
    });
    return tables.map(t => (t.type === "table" && rowCounts.has(t.name) ? { ...t, rowCount: rowCounts.get(t.name) } : t));
}

export async function getTableData(
    config: Record<string, unknown>,
    options: TableDataOptions,
    _host: ExecutionHost
): Promise<TableDataResult> {
    const { table, page, pageSize, sortBy, sortDir, search, searchColumn, matchMode } = options;
    const offset = (page - 1) * pageSize;
    const dbPath = config.path as string;
    const mode = (config.mode as string) || "local";
    const binaryPath = (config.sqliteBinaryPath as string) || "sqlite3";
    const tblId = `"${escapeIdentifier(table)}"`;
    const whereClause = (search && searchColumn)
        ? matchMode === "equals"
            ? ` WHERE "${escapeIdentifier(searchColumn)}" = '${escapeSqliteLiteral(search)}'`
            : matchMode === "starts"
            ? ` WHERE "${escapeIdentifier(searchColumn)}" LIKE '${escapeSqliteLiteral(search)}%'`
            : matchMode === "ends"
            ? ` WHERE "${escapeIdentifier(searchColumn)}" LIKE '%${escapeSqliteLiteral(search)}'`
            : ` WHERE "${escapeIdentifier(searchColumn)}" LIKE '%${escapeSqliteLiteral(search)}%'`
        : "";
    const sortClause = sortBy
        ? ` ORDER BY "${escapeIdentifier(sortBy)}" ${sortDir === "desc" ? "DESC" : "ASC"}`
        : "";
    const pragmaQuery = `PRAGMA table_info(${tblId});`;
    const countQuery = `SELECT COUNT(*) FROM ${tblId}${whereClause};`;
    const dataQuery = `SELECT * FROM ${tblId}${whereClause}${sortClause} LIMIT ${pageSize} OFFSET ${offset};`;

    if (mode === "ssh") {
        const sshConfig = extractSqliteSshConfig(config);
        if (!sshConfig) throw new Error("SSH host and username are required");

        const client = new SshClient();
        try {
            await client.connect(sshConfig);
            const bin = await remoteBinaryCheck(client, binaryPath);
            const dbArg = shellEscape(dbPath);

            const [pragmaResult, countResult, dataResult] = await Promise.all([
                client.exec(`${shellEscape(bin)} ${dbArg} ${shellEscape(pragmaQuery)}`),
                client.exec(`${shellEscape(bin)} ${dbArg} ${shellEscape(countQuery)}`),
                client.exec(`${shellEscape(bin)} -separator '\t' ${dbArg} ${shellEscape(dataQuery)}`),
            ]);

            if (pragmaResult.code !== 0) throw new Error(`Schema query failed: ${pragmaResult.stderr}`);
            if (countResult.code !== 0) throw new Error(`Count query failed: ${countResult.stderr}`);
            if (dataResult.code !== 0) throw new Error(`Data query failed: ${dataResult.stderr}`);

            const columns = parsePragmaTableInfo(pragmaResult.stdout);
            const totalCount = parseInt(countResult.stdout.trim(), 10) || 0;
            const rows = parseDataRows(dataResult.stdout, columns);
            return { rows, totalCount, columns };
        } finally {
            client.end();
        }
    }

    const [pragmaOut, countOut, dataOut] = await Promise.all([
        execFileAsync(binaryPath, [dbPath, pragmaQuery]),
        execFileAsync(binaryPath, [dbPath, countQuery]),
        execFileAsync(binaryPath, ["-separator", "\t", dbPath, dataQuery]),
    ]);

    const columns = parsePragmaTableInfo(pragmaOut.stdout);
    const totalCount = parseInt(countOut.stdout.trim(), 10) || 0;
    const rows = parseDataRows(dataOut.stdout, columns);
    return { rows, totalCount, columns };
}
