import sql from "mssql";
import type { ExecutionHost } from "@/lib/transport";
import type { AzureSQLConfig } from "@/lib/adapters/definitions";
import type { TableInfo, ColumnInfo, TableDataOptions, TableDataResult } from "@/lib/core/interfaces";
import { withPool } from "./pool";

/**
 * Table browsing on Azure SQL Database.
 *
 * Structurally the MSSQL browser with every three-part name removed. Azure SQL
 * Database rejects `[db].schema.object` outright ("Reference to database and/or
 * server name in ... is not supported in this version of SQL Server"), so the
 * database is selected by connecting to it instead. `withPool(..., { database })`
 * is what makes that a one-word difference at each call site.
 *
 * Every query below is therefore two-part at most. A three-part name reintroduced
 * here would work in no environment at all, which is why the tests assert on it.
 */

/** Sanitize an identifier for bracket-quoting. */
function escapeIdentifier(name: string): string {
    return name.replace(/]/g, "]]").replace(/\0/g, "");
}

/** Sanitize a value for use in a single-quoted SQL string literal. */
function escapeStringLiteral(name: string): string {
    return name.replace(/'/g, "''").replace(/\0/g, "");
}

export async function getTables(
    config: AzureSQLConfig,
    database: string,
    host: ExecutionHost,
): Promise<TableInfo[]> {
    return withPool(config, host, async (pool) => {
        const result = await pool.request().query(`
            SELECT
                t.TABLE_SCHEMA AS schema_name,
                t.TABLE_NAME AS name,
                t.TABLE_TYPE AS table_type,
                COALESCE(SUM(p.rows), 0) AS row_count,
                COALESCE(SUM(CAST(a.total_pages AS BIGINT)) * 8 * 1024, 0) AS size_bytes
            FROM INFORMATION_SCHEMA.TABLES t
            LEFT JOIN sys.tables st ON st.name = t.TABLE_NAME AND st.schema_id = SCHEMA_ID(t.TABLE_SCHEMA)
            LEFT JOIN sys.indexes i ON i.object_id = st.object_id AND i.type <= 1
            LEFT JOIN sys.partitions p ON p.object_id = st.object_id AND p.index_id = i.index_id
            LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id
            GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE
            ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
        `);

        return result.recordset.map((row: Record<string, unknown>) => ({
            name: row.schema_name !== "dbo" ? `${row.schema_name}.${row.name}` : String(row.name),
            type: (row.table_type === "VIEW" ? "view" : "table") as TableInfo["type"],
            rowCount: Number(row.row_count) || 0,
            sizeInBytes: Number(row.size_bytes) || 0,
        }));
    }, { database });
}

export async function getTableData(
    config: AzureSQLConfig,
    options: TableDataOptions,
    host: ExecutionHost,
): Promise<TableDataResult> {
    const { database, table, page, pageSize, sortBy, sortDir, search, searchColumn, matchMode } = options;
    const offset = (page - 1) * pageSize;

    // Tables in schemas other than dbo are stored as "schema.tableName".
    let tableSchema = "dbo";
    let tableName = table;
    if (table.includes(".")) {
        const dotIndex = table.indexOf(".");
        tableSchema = table.substring(0, dotIndex);
        tableName = table.substring(dotIndex + 1);
    }

    const schemaId = escapeIdentifier(tableSchema);
    const tblId = escapeIdentifier(tableName);
    const schemaLiteral = escapeStringLiteral(tableSchema);
    const tblLiteral = escapeStringLiteral(tableName);

    const sortColExpr = sortBy
        ? `[${escapeIdentifier(sortBy)}] ${sortDir === "desc" ? "DESC" : "ASC"}`
        : "(SELECT NULL)";

    const searchActive = !!(search && searchColumn);
    const searchTermValue = searchActive
        ? matchMode === "starts" ? `${search}%`
        : matchMode === "ends"   ? `%${search}`
        : matchMode === "equals" ? search!
        : `%${search}%`
        : undefined;
    const whereClause = searchActive
        ? matchMode === "equals"
            ? ` WHERE CAST([${escapeIdentifier(searchColumn!)}] AS NVARCHAR(MAX)) = @searchTerm`
            : ` WHERE CAST([${escapeIdentifier(searchColumn!)}] AS NVARCHAR(MAX)) LIKE @searchTerm`
        : "";

    return withPool(config, host, async (pool) => {
        const colReq = pool.request();
        const countReq = pool.request();
        const dataReq = pool.request();

        if (searchActive) {
            countReq.input("searchTerm", sql.NVarChar, searchTermValue);
            dataReq.input("searchTerm", sql.NVarChar, searchTermValue);
        }

        const [colResult, countResult, dataResult] = await Promise.all([
            colReq.query(`
                SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
                    CASE WHEN COLUMN_NAME IN (
                        SELECT kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = '${tblLiteral}'
                    ) THEN 'PRI' ELSE '' END AS COLUMN_KEY,
                    COLUMN_DEFAULT
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = '${tblLiteral}' AND TABLE_SCHEMA = '${schemaLiteral}'
                ORDER BY ORDINAL_POSITION
            `),
            countReq.query(`SELECT COUNT(*) AS total FROM [${schemaId}].[${tblId}]${whereClause}`),
            dataReq.query(`
                SELECT * FROM [${schemaId}].[${tblId}]${whereClause}
                ORDER BY ${sortColExpr}
                OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
            `),
        ]);

        const columns: ColumnInfo[] = colResult.recordset.map((row: Record<string, unknown>) => ({
            name: String(row.COLUMN_NAME),
            dataType: String(row.DATA_TYPE),
            nullable: row.IS_NULLABLE === "YES",
            primaryKey: row.COLUMN_KEY === "PRI",
            defaultValue: (row.COLUMN_DEFAULT as string | undefined) ?? undefined,
        }));

        const totalCount = Number(countResult.recordset[0]?.total) || 0;

        const rows: Record<string, unknown>[] = dataResult.recordset.map((row: Record<string, unknown>) => {
            const record: Record<string, unknown> = {};
            for (const col of columns) {
                const val = row[col.name];
                record[col.name] = val === undefined ? null : val;
            }
            return record;
        });

        return { rows, totalCount, columns };
    }, { database });
}
