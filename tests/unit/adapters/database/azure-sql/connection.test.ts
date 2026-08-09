import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool, mockQuery, PoolCtor } = vi.hoisted(() => {
    const mockQuery = vi.fn();
    const mockRequest = vi.fn(() => ({ query: mockQuery, input: vi.fn().mockReturnThis(), on: vi.fn() }));
    const mockPool = { connect: vi.fn(), close: vi.fn(), request: mockRequest };
    // A plain function, not an arrow: the adapter calls it with `new`.
    const PoolCtor = vi.fn(function () { return mockPool; });
    return { mockPool, mockQuery, PoolCtor };
});

vi.mock("mssql", () => ({
    default: { ConnectionPool: PoolCtor, NVarChar: "nvarchar" },
    ConnectionPool: PoolCtor,
    NVarChar: "nvarchar",
}));

import { createFakeHost } from "@/lib/testing/fake-host";
import { test as testConnection, getDatabases } from "@/lib/adapters/database/azure-sql/connection";
import { getDatabasesWithStats } from "@/lib/adapters/database/azure-sql/catalog";

const config = {
    host: "myserver.database.windows.net",
    port: 1433,
    user: "backupadmin",
    password: "s3cret",
    database: "",
    requestTimeout: 300000,
} as never;

/** The connection config the driver was constructed with. */
function lastPoolConfig(): Record<string, unknown> {
    const call = PoolCtor.mock.calls.at(-1) as unknown as [Record<string, unknown>];
    return call[0];
}

function azureRow(overrides: Record<string, unknown> = {}) {
    return { ProductVersion: "12.0.2000.8", EngineEdition: 5, ServiceObjective: "S0", ...overrides };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
});

describe("Azure SQL connection test", () => {
    it("accepts Azure SQL Database and reports its service tier", async () => {
        mockQuery.mockResolvedValue({ recordset: [azureRow()] });

        const result = await testConnection(config, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(result.edition).toBe("Azure SQL Database");
        expect(result.message).toContain("S0");
        // Azure has reported this same version for years regardless of the engine
        // actually running. Surfaced, never used to pick behaviour.
        expect(result.version).toBe("12.0.2000");
    });

    it.each([
        [8, /Managed Instance/],
        [6, /Synapse/],
        [9, /Azure SQL Edge/],
        [3, /regular SQL Server instance/],
    ])("refuses EngineEdition %i and names what it actually found", async (engineEdition, expected) => {
        // All of these answer on 1433 with a TDS handshake and look identical until
        // the first catalog query, so a bare "connection failed" would send people
        // looking at firewalls.
        mockQuery.mockResolvedValue({ recordset: [azureRow({ EngineEdition: engineEdition })] });

        const result = await testConnection(config, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.message).toMatch(expected);
    });

    it("fails the test when SqlPackage is missing, and says backups are what break", async () => {
        mockQuery.mockResolvedValue({ recordset: [azureRow()] });
        const host = createFakeHost({ kind: "direct", onWhich: () => null });

        const result = await testConnection(config, host);

        expect(result.success).toBe(false);
        expect(result.message).toContain("backups cannot run");
        // Still reported, because the connection itself was fine.
        expect(result.edition).toBe("Azure SQL Database");
    });

    it("points a rejected client at the firewall rule rather than the credentials", async () => {
        mockPool.connect.mockRejectedValue(new Error("Client with IP address '1.2.3.4' is not allowed to access the server."));

        const result = await testConnection(config, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.message).toContain("firewall rule");
    });

    it("always negotiates TLS with a verified certificate", async () => {
        mockQuery.mockResolvedValue({ recordset: [azureRow()] });

        await testConnection(config, createFakeHost({ kind: "direct" }));

        const options = lastPoolConfig().options as Record<string, unknown>;
        expect(options.encrypt).toBe(true);
        expect(options.trustServerCertificate).toBe(false);
    });
});

describe("Azure SQL database listing", () => {
    it("excludes master by name, not by id", async () => {
        // The MSSQL adapter filters on database_id > 4 to skip four system
        // databases. Azure has only master, and assigns user database ids per
        // server with no guarantee about the range.
        mockQuery.mockResolvedValue({ recordset: [{ name: "shop" }, { name: "analytics" }] });

        await getDatabases(config, createFakeHost({ kind: "direct" }));

        const sql = mockQuery.mock.calls[0][0] as string;
        expect(sql).toContain("name <> 'master'");
        expect(sql).not.toContain("database_id > 4");
    });

    it("returns nothing rather than throwing when the catalog is unreachable", async () => {
        mockPool.connect.mockRejectedValue(new Error("timeout"));

        expect(await getDatabases(config, createFakeHost({ kind: "direct" }))).toEqual([]);
    });
});

describe("Azure SQL database stats", () => {
    it("reads size and table count from inside each database", async () => {
        // No three-part names exist here, so every database needs its own
        // connection. sys.database_files is per database by definition.
        mockQuery
            .mockResolvedValueOnce({ recordset: [{ name: "shop" }] })
            .mockResolvedValueOnce({ recordset: [{ size_bytes: "8192" }] })
            .mockResolvedValueOnce({ recordset: [{ cnt: 12 }] });

        const databases = await getDatabasesWithStats(config, createFakeHost({ kind: "direct" }));

        expect(databases).toEqual([{ name: "shop", sizeInBytes: 8192, tableCount: 12 }]);
    });

    it("keeps listing the others when one database cannot be read", async () => {
        // Reproducing the MSSQL bug this adapter exists downstream of, where one
        // missing catalog view took out the whole Database Explorer page, would be
        // embarrassing.
        mockQuery.mockResolvedValueOnce({ recordset: [{ name: "shop" }, { name: "locked" }] });

        // The first connection is the name listing. Of the two per-database ones
        // that follow, exactly one fails. Which of them is not asserted: the
        // per-database reads run concurrently, so pinning the loser would be
        // testing the scheduler rather than the degradation.
        mockPool.connect
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("login failed"))
            .mockResolvedValue(undefined);
        mockQuery.mockResolvedValue({ recordset: [{ size_bytes: "4096", cnt: 3 }] });

        const databases = await getDatabasesWithStats(config, createFakeHost({ kind: "direct" }));

        expect(databases.map((d) => d.name).sort()).toEqual(["locked", "shop"]);

        const degraded = databases.filter((d) => d.sizeInBytes === undefined);
        expect(degraded).toHaveLength(1);
        expect(degraded[0].tableCount).toBe(0);
    });

    it("excludes the transaction log from the reported size", async () => {
        // A BACPAC never contains the log, so counting it would overstate what a
        // backup of this database is going to cost.
        mockQuery
            .mockResolvedValueOnce({ recordset: [{ name: "shop" }] })
            .mockResolvedValueOnce({ recordset: [{ size_bytes: "8192" }] })
            .mockResolvedValueOnce({ recordset: [{ cnt: 1 }] });

        await getDatabasesWithStats(config, createFakeHost({ kind: "direct" }));

        const sizeQuery = mockQuery.mock.calls[1][0] as string;
        expect(sizeQuery).toContain("sys.database_files");
        expect(sizeQuery).toContain("type = 0");
    });
});
