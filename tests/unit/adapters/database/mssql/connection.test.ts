import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool, mockQuery, PoolCtor } = vi.hoisted(() => {
    const mockQuery = vi.fn();
    const mockRequest = vi.fn(() => ({ query: mockQuery, input: vi.fn(), on: vi.fn() }));
    const mockPool = { connect: vi.fn(), close: vi.fn(), request: mockRequest };
    // A plain function, not an arrow: the adapter calls it with `new`.
    const PoolCtor = vi.fn(function () { return mockPool; });
    return { mockPool, mockQuery, PoolCtor };
});

vi.mock("mssql", () => ({
    default: { ConnectionPool: PoolCtor },
    ConnectionPool: PoolCtor,
}));

import { createFakeHost, type FakeHost } from "@/lib/testing/fake-host";
import {
    test as testConnection,
    getDatabases,
    getDatabasesWithStats,
    assertBackupSupported,
} from "@/lib/adapters/database/mssql/connection";
import { mssqlTransport } from "@/lib/adapters/database/mssql/transport";
import type { HostKind } from "@/lib/transport/types";

const baseConfig = { host: "sql.internal", port: 1433, user: "sa", password: "secret" };

/** The connection config the driver was constructed with. */
function lastPoolConfig(): Record<string, unknown> {
    const call = PoolCtor.mock.calls.at(-1) as unknown as [Record<string, unknown>];
    return call[0];
}

function mssqlHost(kind: HostKind): FakeHost {
    return createFakeHost({ kind });
}

describe("mssqlTransport", () => {
    it("treats a stored config without connectionMode as direct", () => {
        // Existing rows predate the field, and the Zod default never runs at
        // runtime because resolveAdapterConfig returns decrypted JSON.
        expect(mssqlTransport({ host: "sql", fileTransferMode: "local" })).toEqual({ kind: "direct" });
        expect(mssqlTransport({ host: "sql" })).toEqual({ kind: "direct" });
    });

    it("keeps the legacy SSH file transfer as a composite transport", () => {
        const spec = mssqlTransport({
            host: "sql.internal",
            fileTransferMode: "ssh",
            sshUsername: "ops",
        });

        expect(spec).toEqual({
            kind: "composite",
            exec: { kind: "direct" },
            files: { kind: "ssh", ssh: expect.objectContaining({ host: "sql.internal", username: "ops" }) },
        });
    });

    it("falls back to the database host when no SSH host is configured", () => {
        // MssqlSshTransfer did this, on the assumption that SQL Server and the
        // SSH server are the same machine.
        const spec = mssqlTransport({ host: "sql.internal", connectionMode: "ssh", sshUsername: "ops" });
        expect(spec).toMatchObject({ kind: "ssh", ssh: { host: "sql.internal" } });
    });

    it("prefers an explicit SSH host over the database host", () => {
        const spec = mssqlTransport({
            host: "sql.internal",
            sshHost: "jump.internal",
            connectionMode: "ssh",
            sshUsername: "ops",
        });
        expect(spec).toMatchObject({ kind: "ssh", ssh: { host: "jump.internal" } });
    });

    it("ignores fileTransferMode once the whole connection runs over SSH", () => {
        const spec = mssqlTransport({
            host: "sql.internal",
            connectionMode: "ssh",
            fileTransferMode: "local",
            sshUsername: "ops",
        });
        expect(spec.kind).toBe("ssh");
    });

    it("throws instead of silently falling back when the SSH username is missing", () => {
        expect(() => mssqlTransport({ host: "sql.internal", connectionMode: "ssh" }))
            .toThrow(/SSH username is missing/);
    });
});

describe.each<HostKind>(["direct", "ssh"])("MSSQL connection over a %s host", (kind) => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPool.connect.mockResolvedValue(undefined);
        mockPool.close.mockResolvedValue(undefined);
    });

    describe("test()", () => {
        it("reports the version and edition", async () => {
            mockQuery.mockResolvedValue({
                recordset: [{
                    Version: "Microsoft SQL Server 2022 (RTM)",
                    ProductVersion: "16.0.1000.6",
                    Edition: "Developer Edition (64-bit)",
                    EngineEdition: 3,
                }],
            });

            const result = await testConnection(baseConfig as never, mssqlHost(kind));

            expect(result.success).toBe(true);
            expect(result.version).toBe("16.0.1000");
            expect(result.edition).toBe("Developer");
            expect(result.message).toContain("SQL Server 2022");
        });

        it("recognises Azure SQL Edge", async () => {
            mockQuery.mockResolvedValue({
                recordset: [{ Version: "Azure SQL Edge", ProductVersion: "15.0.0", Edition: "Edge", EngineEdition: 9 }],
            });

            expect((await testConnection(baseConfig as never, mssqlHost(kind))).edition).toBe("Azure SQL Edge");
        });

        it.each([
            [5, "Azure SQL Database"],
            [8, "Azure SQL Managed Instance"],
        ])("refuses EngineEdition %i and names the product", async (engineEdition, product) => {
            // Azure answers SERVERPROPERTY('Edition') with "SQL Azure", which the
            // old name parsing reduced to the meaningless "SQL". EngineEdition is
            // the only reliable signal, and it has to be read before the name.
            mockQuery.mockResolvedValue({
                recordset: [{
                    Version: "Microsoft SQL Azure (RTM) - 12.0.2000.8",
                    ProductVersion: "12.0.2000.8",
                    Edition: "SQL Azure",
                    EngineEdition: engineEdition,
                }],
            });

            const result = await testConnection(baseConfig as never, mssqlHost(kind));

            expect(result.success).toBe(false);
            expect(result.message).toContain(product);
            expect(result.edition).toBe(product);
            // Still reported, so the run log and version history stay accurate.
            expect(result.version).toBe("12.0.2000");
        });

        it.each([
            ["ECONNREFUSED 1.2.3.4:1433", "Connection refused"],
            ["Login failed for user 'sa'", "Login failed"],
            ["self signed certificate in chain", "Certificate error"],
        ])("turns %s into a readable message", async (raw, expected) => {
            mockPool.connect.mockRejectedValue(new Error(raw));
            const result = await testConnection(baseConfig as never, mssqlHost(kind));

            expect(result.success).toBe(false);
            expect(result.message).toContain(expected);
        });

        it("rejects a call made without a transport", async () => {
            const result = await testConnection(baseConfig as never, undefined);
            expect(result.success).toBe(false);
            expect(result.message).toContain("requires an execution host");
        });
    });

    describe("getDatabases()", () => {
        it("returns the user databases", async () => {
            mockQuery.mockResolvedValue({ recordset: [{ name: "shop" }, { name: "analytics" }] });
            expect(await getDatabases(baseConfig as never, mssqlHost(kind))).toEqual(["shop", "analytics"]);
        });

        it("returns nothing when the query fails", async () => {
            mockPool.connect.mockRejectedValue(new Error("timeout"));
            expect(await getDatabases(baseConfig as never, mssqlHost(kind))).toEqual([]);
        });
    });

    describe("getDatabasesWithStats()", () => {
        it("reports the size and table count per database", async () => {
            mockQuery
                .mockResolvedValueOnce({ recordset: [{ name: "shop", state_desc: "ONLINE", size_bytes: "8192" }] })
                .mockResolvedValueOnce({ recordset: [{ cnt: 12 }] });

            expect(await getDatabasesWithStats(baseConfig as never, mssqlHost(kind)))
                .toEqual([{ name: "shop", sizeInBytes: 8192, tableCount: 12 }]);
        });

        it("defaults the table count to zero for an inaccessible database", async () => {
            mockQuery
                .mockResolvedValueOnce({ recordset: [{ name: "shop", state_desc: "OFFLINE", size_bytes: "0" }] })
                .mockRejectedValueOnce(new Error("database is offline"));

            expect(await getDatabasesWithStats(baseConfig as never, mssqlHost(kind)))
                .toEqual([{ name: "shop", sizeInBytes: 0, tableCount: 0 }]);
        });

        it("still lists databases when sys.master_files does not exist", async () => {
            // Azure SQL Database has no server-scoped catalog view. Letting that
            // escape took out the whole Database Explorer with a "Connection
            // Failed" card, even though the names were perfectly readable.
            mockQuery
                .mockRejectedValueOnce(new Error("Invalid object name 'sys.master_files'."))
                .mockResolvedValueOnce({ recordset: [{ name: "shop", state_desc: "ONLINE" }] })
                .mockResolvedValueOnce({ recordset: [{ cnt: 3 }] });

            const databases = await getDatabasesWithStats(baseConfig as never, mssqlHost(kind));

            expect(databases).toHaveLength(1);
            expect(databases[0].name).toBe("shop");
            expect(databases[0].tableCount).toBe(3);
            // Undefined, not 0. The explorer drops the column entirely rather
            // than showing a table full of confident zeroes.
            expect(databases[0].sizeInBytes).toBeUndefined();
        });
    });

    describe("assertBackupSupported()", () => {
        it("lets a real SQL Server through", async () => {
            mockQuery.mockResolvedValue({ recordset: [{ EngineEdition: 3 }] });

            await expect(assertBackupSupported(baseConfig as never, mssqlHost(kind)))
                .resolves.toBeUndefined();
        });

        it("rejects Azure SQL Database and says why it can never work", async () => {
            mockQuery.mockResolvedValue({ recordset: [{ EngineEdition: 5 }] });

            await expect(assertBackupSupported(baseConfig as never, mssqlHost(kind)))
                .rejects.toThrow(/no BACKUP DATABASE statement/);
        });

        it("stays out of the way when the edition cannot be determined", async () => {
            // Refusing on an unanswerable probe would break setups this adapter
            // has always handled. Let the operation fail on its own terms.
            mockPool.connect.mockRejectedValue(new Error("timeout"));

            await expect(assertBackupSupported(baseConfig as never, mssqlHost(kind)))
                .resolves.toBeUndefined();
        });
    });
});

describe("MSSQL connection through an SSH tunnel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPool.connect.mockResolvedValue(undefined);
        mockPool.close.mockResolvedValue(undefined);
        mockQuery.mockResolvedValue({ recordset: [] });
    });

    it("dials the database directly when no tunnel is involved", async () => {
        await getDatabases(baseConfig as never, mssqlHost("direct"));

        const cfg = lastPoolConfig();
        expect(cfg.server).toBe("sql.internal");
        expect(cfg.port).toBe(1433);
        expect((cfg.options as Record<string, unknown>).serverName).toBeUndefined();
    });

    it("dials the forwarded loopback address when tunnelled", async () => {
        const host = mssqlHost("ssh");
        await getDatabases(baseConfig as never, host);

        const cfg = lastPoolConfig();
        expect(cfg.server).toBe("127.0.0.1");
        expect(cfg.port).not.toBe(1433);
        expect(host.calls.forwards).toEqual([{ host: "sql.internal", port: 1433 }]);
    });

    it("keeps certificate validation working through the tunnel", async () => {
        // The driver now dials 127.0.0.1, whose default TLS server name collapses
        // to an empty string, so the real hostname has to be restored explicitly.
        await getDatabases(baseConfig as never, mssqlHost("ssh"));

        const options = (lastPoolConfig()).options as Record<string, unknown>;
        expect(options.serverName).toBe("sql.internal");
    });

    it("caps the pool so the SSH session limit is not exhausted", async () => {
        // Each pooled TDS connection is its own SSH channel, and OpenSSH allows
        // ten sessions by default with SFTP claiming one.
        await getDatabases(baseConfig as never, mssqlHost("ssh"));

        const pool = (lastPoolConfig()).pool as Record<string, unknown>;
        expect(pool.max).toBe(4);
    });

    it("does not cap the pool without a tunnel", async () => {
        await getDatabases(baseConfig as never, mssqlHost("direct"));
        expect((lastPoolConfig()).pool).toBeUndefined();
    });
});
