import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMeta } = vi.hoisted(() => ({ mockMeta: vi.fn() }));

/**
 * MongoDB is the one adapter whose two connection modes cannot share an
 * implementation: direct mode speaks the wire protocol through the driver,
 * SSH mode shells out to mongosh. That split lives behind MongoMeta, so the
 * adapter itself is transport-agnostic and is tested against a stub.
 *
 * The two MongoMeta implementations are covered separately.
 */
vi.mock("@/lib/adapters/database/mongodb/meta", () => ({
    withMongoMeta: (_config: unknown, _host: unknown, fn: (meta: unknown) => unknown) => fn(mockMeta()),
}));

import { createFakeHost } from "@/lib/testing/fake-host";
import {
    test as testConnection,
    getDatabases,
    getDatabasesWithStats,
} from "@/lib/adapters/database/mongodb/connection";
import type { HostKind } from "@/lib/transport/types";

const baseConfig = { host: "mongo.internal", port: 27017, user: "root", password: "secret" };

function meta(overrides: Record<string, unknown>) {
    mockMeta.mockReturnValue({
        serverVersion: vi.fn(),
        listDatabaseNames: vi.fn(),
        databaseStats: vi.fn(),
        listCollections: vi.fn(),
        findPage: vi.fn(),
        checkWritable: vi.fn(() => null),
        close: vi.fn(),
        ...overrides,
    });
}

describe.each<HostKind>(["direct", "ssh"])("MongoDB connection over a %s host", (kind) => {
    beforeEach(() => vi.clearAllMocks());

    describe("test()", () => {
        it("reports success with the server version", async () => {
            meta({ serverVersion: vi.fn().mockResolvedValue("7.0.5") });
            const result = await testConnection(baseConfig as never, createFakeHost({ kind }));

            expect(result.success).toBe(true);
            expect(result.version).toBe("7.0.5");
        });

        it("turns a failure into a result rather than throwing", async () => {
            meta({ serverVersion: vi.fn().mockRejectedValue(new Error("Authentication failed")) });
            const result = await testConnection(baseConfig as never, createFakeHost({ kind }));

            expect(result.success).toBe(false);
            expect(result.message).toContain("Authentication failed");
        });

        it("rejects a call made without a transport", async () => {
            const result = await testConnection(baseConfig as never, undefined);
            expect(result.success).toBe(false);
            expect(result.message).toContain("requires an execution host");
        });
    });

    describe("getDatabases()", () => {
        it("returns the user database names", async () => {
            meta({ listDatabaseNames: vi.fn().mockResolvedValue(["shop", "analytics"]) });
            expect(await getDatabases(baseConfig as never, createFakeHost({ kind })))
                .toEqual(["shop", "analytics"]);
        });

        it("wraps a failure with context", async () => {
            meta({ listDatabaseNames: vi.fn().mockRejectedValue(new Error("not authorized")) });
            await expect(getDatabases(baseConfig as never, createFakeHost({ kind })))
                .rejects.toThrow(/Failed to list databases.*not authorized/);
        });
    });

    describe("getDatabasesWithStats()", () => {
        it("maps sizes and collection counts onto the shared shape", async () => {
            meta({
                databaseStats: vi.fn().mockResolvedValue([
                    { name: "shop", sizeOnDisk: 2048, collectionCount: 4 },
                ]),
            });

            expect(await getDatabasesWithStats(baseConfig as never, createFakeHost({ kind })))
                .toEqual([{ name: "shop", sizeInBytes: 2048, tableCount: 4 }]);
        });

        it("wraps a failure with context", async () => {
            meta({ databaseStats: vi.fn().mockRejectedValue(new Error("boom")) });
            await expect(getDatabasesWithStats(baseConfig as never, createFakeHost({ kind })))
                .rejects.toThrow(/Failed to list databases with stats.*boom/);
        });
    });
});
