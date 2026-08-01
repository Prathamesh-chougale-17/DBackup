import type { ExecutionHost } from "@/lib/transport";
import { TableInfo, ColumnInfo, TableDataOptions, TableDataResult } from "@/lib/core/interfaces";

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

export async function getTables(
    config: Record<string, unknown>,
    _database: string,
    host: ExecutionHost,
): Promise<TableInfo[]> {
    const dbPath = config.path as string;
    const binary = await host.which((config.sqliteBinaryPath as string) || "sqlite3");
    const query = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;";

    const result = await host.exec([binary, dbPath, query]);
    if (result.code !== 0) {
        throw new Error(`Failed to list tables: ${result.stderr.trim()}`);
    }

    const tables: TableInfo[] = result.stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const [name, rawType] = line.split("|");
            return { name, type: rawType === "view" ? "view" as const : "table" as const };
        });

    return enrichWithRowCounts(host, binary, dbPath, tables);
}

async function enrichWithRowCounts(
    host: ExecutionHost,
    binary: string,
    dbPath: string,
    tables: TableInfo[],
): Promise<TableInfo[]> {
    const tableNames = tables.filter(t => t.type === "table").map(t => t.name);
    if (tableNames.length === 0) return tables;

    const countQuery = tableNames
        .map(name => `SELECT count(*) FROM "${escapeIdentifier(name)}"`)
        .join(" UNION ALL ");

    const result = await host.exec([binary, dbPath, `${countQuery};`]);
    if (result.code !== 0) return tables;

    const rowCounts = new Map<string, number>();
    result.stdout.split("\n").map(l => l.trim()).filter(Boolean).forEach((line, i) => {
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
    host: ExecutionHost,
): Promise<TableDataResult> {
    const { table, page, pageSize, sortBy, sortDir, search, searchColumn, matchMode } = options;
    const offset = (page - 1) * pageSize;
    const dbPath = config.path as string;
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

    const binary = await host.which((config.sqliteBinaryPath as string) || "sqlite3");

    // Three concurrent queries. Over SSH each one is a separate channel, which
    // the transport caps so a wide fan-out cannot exhaust the server session limit.
    const [pragmaResult, countResult, dataResult] = await Promise.all([
        host.exec([binary, dbPath, pragmaQuery]),
        host.exec([binary, dbPath, countQuery]),
        host.exec([binary, "-separator", "\t", dbPath, dataQuery]),
    ]);

    if (pragmaResult.code !== 0) throw new Error(`Schema query failed: ${pragmaResult.stderr.trim()}`);
    if (countResult.code !== 0) throw new Error(`Count query failed: ${countResult.stderr.trim()}`);
    if (dataResult.code !== 0) throw new Error(`Data query failed: ${dataResult.stderr.trim()}`);

    const columns = parsePragmaTableInfo(pragmaResult.stdout);
    const totalCount = parseInt(countResult.stdout.trim(), 10) || 0;
    const rows = parseDataRows(dataResult.stdout, columns);
    return { rows, totalCount, columns };
}
