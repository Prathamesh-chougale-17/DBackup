import { describe, it, expect } from "vitest";

import { createFakeHost } from "@/lib/testing/fake-host";
import {
    test as testConnection,
    getDatabases,
    getDatabasesWithStats,
} from "@/lib/adapters/database/sqlite/connection";
import { sqliteTransport } from "@/lib/adapters/database/sqlite/transport";
import type { HostKind } from "@/lib/transport/types";

/**
 * SQLite stores `mode` plus unprefixed SSH fields rather than the
 * `connectionMode` plus `sshHost` convention every other adapter uses. The
 * stored shape is unchanged: only the resolver knows about it.
 */

const baseConfig = { mode: "local", path: "/data/app.sqlite" };

describe("sqliteTransport", () => {
    it("treats an absent mode as local", () => {
        expect(sqliteTransport({ path: "/data/app.sqlite" })).toEqual({ kind: "direct" });
    });

    it("treats local mode as direct", () => {
        expect(sqliteTransport(baseConfig)).toEqual({ kind: "direct" });
    });

    it("builds an ssh spec from the unprefixed fields", () => {
        expect(sqliteTransport({
            mode: "ssh",
            path: "/data/app.sqlite",
            host: "nas.local",
            port: 2222,
            username: "pi",
            authType: "privateKey",
            privateKey: "KEY",
            passphrase: "pp",
        })).toEqual({
            kind: "ssh",
            ssh: {
                host: "nas.local",
                port: 2222,
                username: "pi",
                authType: "privateKey",
                password: undefined,
                privateKey: "KEY",
                passphrase: "pp",
            },
        });
    });

    it("throws instead of silently falling back when the SSH fields are incomplete", () => {
        expect(() => sqliteTransport({ mode: "ssh", path: "/data/app.sqlite", host: "nas.local" }))
            .toThrow(/SSH host or username is missing/);
    });
});

describe.each<HostKind>(["direct", "ssh"])("SQLite connection over a %s host", (kind) => {
    describe("test()", () => {
        it("reports the sqlite3 version when the database file exists", async () => {
            const host = createFakeHost({
                kind,
                files: { "/data/app.sqlite": 4096 },
                onExec: () => ({ stdout: "3.45.1 2024-01-30 ...\n" }),
            });

            const result = await testConnection(baseConfig as never, host);

            expect(result.success).toBe(true);
            expect(result.version).toBe("3.45.1");
        });

        it("fails when the database file is missing", async () => {
            const host = createFakeHost({ kind, onExec: () => ({ stdout: "3.45.1\n" }) });
            const result = await testConnection(baseConfig as never, host);

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");
        });

        it("fails when sqlite3 is not available", async () => {
            const host = createFakeHost({ kind, onWhich: () => null });
            expect((await testConnection(baseConfig as never, host)).success).toBe(false);
        });

        it("honours an explicitly configured binary path", async () => {
            const host = createFakeHost({
                kind,
                files: { "/data/app.sqlite": 1 },
                onExec: () => ({ stdout: "3.45.1\n" }),
            });

            await testConnection({ ...baseConfig, sqliteBinaryPath: "/opt/bin/sqlite3" } as never, host);
            expect(host.calls.which[0]).toEqual(["/opt/bin/sqlite3"]);
        });

        it("rejects a call made without a transport", async () => {
            const result = await testConnection(baseConfig as never, undefined);
            expect(result.success).toBe(false);
            expect(result.message).toContain("requires an execution host");
        });
    });

    describe("getDatabases()", () => {
        it("reports the filename as the database name", async () => {
            const host = createFakeHost({ kind });
            expect(await getDatabases(baseConfig as never, host)).toEqual(["app.sqlite"]);
        });

        it("handles a Windows style path", async () => {
            const host = createFakeHost({ kind });
            expect(await getDatabases({ ...baseConfig, path: "C:\\data\\app.sqlite" } as never, host))
                .toEqual(["app.sqlite"]);
        });
    });

    describe("getDatabasesWithStats()", () => {
        it("reports the file size and the table count", async () => {
            const host = createFakeHost({
                kind,
                files: { "/data/app.sqlite": 8192 },
                onExec: () => ({ stdout: "7\n" }),
            });

            expect(await getDatabasesWithStats(baseConfig as never, host)).toEqual([
                { name: "app.sqlite", sizeInBytes: 8192, tableCount: 7 },
            ]);
        });

        it("omits the table count when the query fails", async () => {
            const host = createFakeHost({
                kind,
                files: { "/data/app.sqlite": 8192 },
                onExec: () => ({ code: 1, stderr: "file is not a database" }),
            });

            expect(await getDatabasesWithStats(baseConfig as never, host)).toEqual([
                { name: "app.sqlite", sizeInBytes: 8192, tableCount: undefined },
            ]);
        });

        it("still reports the name when nothing can be read", async () => {
            const host = createFakeHost({ kind, onWhich: () => null });
            expect(await getDatabasesWithStats(baseConfig as never, host)).toEqual([
                { name: "app.sqlite", sizeInBytes: undefined, tableCount: undefined },
            ]);
        });
    });
});
