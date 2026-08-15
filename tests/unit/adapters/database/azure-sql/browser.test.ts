import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool, mockQuery, PoolCtor } = vi.hoisted(() => {
    const mockQuery = vi.fn();
    const mockRequest = vi.fn(() => ({ query: mockQuery, input: vi.fn().mockReturnThis(), on: vi.fn() }));
    const mockPool = { connect: vi.fn(), close: vi.fn(), request: mockRequest };
    const PoolCtor = vi.fn(function () { return mockPool; });
    return { mockPool, mockQuery, PoolCtor };
});

vi.mock("mssql", () => ({
    default: { ConnectionPool: PoolCtor, NVarChar: "nvarchar" },
    ConnectionPool: PoolCtor,
    NVarChar: "nvarchar",
}));

import { createFakeHost } from "@/lib/testing/fake-host";
import { getTables, getTableData } from "@/lib/adapters/database/azure-sql/browser";

const config = {
    host: "myserver.database.windows.net",
    port: 1433,
    user: "backupadmin",
    password: "s3cret",
    database: "",
    requestTimeout: 300000,
} as never;

/** Deliberately distinctive, so a stray occurrence in a query is unmistakable. */
const DATABASE = "zzdatabasenamezz";

function everyQuery(): string[] {
    return mockQuery.mock.calls.map((c) => c[0] as string);
}

function poolDatabase(): unknown {
    const call = PoolCtor.mock.calls.at(-1) as unknown as [Record<string, unknown>];
    return call[0].database;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ recordset: [] });
});

/**
 * Azure SQL Database rejects three-part names outright, so the database is
 * selected by connecting to it. These assertions are the cheap guard against
 * someone pasting a query over from the MSSQL browser, where every name is
 * prefixed with `[db].` and would work nowhere here.
 */
describe("Azure SQL table browsing", () => {
    it("selects the database by connecting to it, not by naming it", async () => {
        await getTables(config, DATABASE, createFakeHost({ kind: "direct" }));

        expect(poolDatabase()).toBe(DATABASE);
        for (const sql of everyQuery()) {
            expect(sql).not.toContain(DATABASE);
        }
    });

    it("reads the catalog with two-part names only", async () => {
        await getTables(config, DATABASE, createFakeHost({ kind: "direct" }));

        const sql = everyQuery()[0];
        expect(sql).toContain("FROM INFORMATION_SCHEMA.TABLES");
        expect(sql).not.toContain("].INFORMATION_SCHEMA");
    });

    it("names no database when paging through table rows either", async () => {
        mockQuery.mockResolvedValue({ recordset: [{ total: 0 }] });

        await getTableData(
            config,
            { database: DATABASE, table: "orders", page: 1, pageSize: 50 } as never,
            createFakeHost({ kind: "direct" }),
        );

        expect(poolDatabase()).toBe(DATABASE);
        for (const sql of everyQuery()) {
            expect(sql).not.toContain(DATABASE);
        }
    });

    it("qualifies a non-dbo table with its schema and nothing more", async () => {
        mockQuery.mockResolvedValue({ recordset: [{ total: 0 }] });

        await getTableData(
            config,
            { database: DATABASE, table: "sales.orders", page: 1, pageSize: 50 } as never,
            createFakeHost({ kind: "direct" }),
        );

        const dataQuery = everyQuery().find((q) => q.includes("FETCH NEXT"))!;
        expect(dataQuery).toContain("[sales].[orders]");
    });

    it("escapes a closing bracket in a table name", async () => {
        mockQuery.mockResolvedValue({ recordset: [{ total: 0 }] });

        await getTableData(
            config,
            { database: DATABASE, table: "we]ird", page: 1, pageSize: 50 } as never,
            createFakeHost({ kind: "direct" }),
        );

        const dataQuery = everyQuery().find((q) => q.includes("FETCH NEXT"))!;
        expect(dataQuery).toContain("[we]]ird]");
    });
});
