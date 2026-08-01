import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFsStat } = vi.hoisted(() => ({ mockFsStat: vi.fn() }));

vi.mock("fs/promises", () => ({
    default: { stat: (...args: unknown[]) => mockFsStat(...args) },
    stat: (...args: unknown[]) => mockFsStat(...args),
}));

import { createFakeHost, type FakeHost } from "@/lib/testing/fake-host";
import { restore, prepareRestore } from "@/lib/adapters/database/redis/restore";
import type { HostKind } from "@/lib/transport/types";

/**
 * Redis has no remote RDB restore, so `restore()` is a guidance flow: it reads
 * the server's data directory and filename and prints the manual steps.
 *
 * Both this and prepareRestore used to run redis-cli LOCALLY against
 * `config.host`, which in SSH mode is meant to be resolved from the SSH server.
 * They now go through the transport, so an SSH source is actually queried.
 */

const baseConfig = {
    host: "redis.internal",
    port: 6379,
    password: "secret",
    database: 0,
};

function commandOf(argv: string[]): string {
    if (argv.includes("PING")) return "PING";
    if (argv.includes("ACL")) return `ACL ${argv[argv.indexOf("ACL") + 1]}`;
    if (argv.includes("INFO")) return "INFO";
    if (argv.includes("CONFIG")) return `CONFIG ${argv[argv.indexOf("GET") + 1]}`;
    return "";
}

function redisHost(kind: HostKind, replies: Record<string, { stdout?: string; code?: number }> = {}): FakeHost {
    return createFakeHost({
        kind,
        onExec: (argv) => {
            const command = commandOf(argv);
            if (replies[command]) return replies[command];
            if (command === "PING") return { stdout: "PONG\n" };
            return { stdout: "" };
        },
    });
}

describe.each<HostKind>(["direct", "ssh"])("Redis restore over a %s host", (kind) => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFsStat.mockResolvedValue({ size: 1024 });
    });

    describe("prepareRestore()", () => {
        it("accepts a server that answers PING", async () => {
            await expect(prepareRestore(baseConfig as never, [], redisHost(kind)))
                .resolves.toBeUndefined();
        });

        it("rejects a server that cannot be reached", async () => {
            const host = redisHost(kind, { PING: { code: 1, stdout: "" } });
            await expect(prepareRestore(baseConfig as never, [], host))
                .rejects.toThrow(/Cannot connect to Redis\/Valkey/);
        });

        it("rejects a reply that is not PONG", async () => {
            const host = redisHost(kind, { PING: { stdout: "NOAUTH Authentication required\n" } });
            await expect(prepareRestore(baseConfig as never, [], host))
                .rejects.toThrow(/Cannot connect to Redis\/Valkey/);
        });

        it("continues when ACL commands are unavailable", async () => {
            // ACL does not exist before Redis 6, which is not a reason to stop.
            const host = redisHost(kind, { "ACL WHOAMI": { code: 1, stdout: "" } });
            await expect(prepareRestore(baseConfig as never, [], host)).resolves.toBeUndefined();
        });

        it("skips the permission probe for the default user", async () => {
            const host = redisHost(kind, { "ACL WHOAMI": { stdout: "default\n" } });
            await prepareRestore(baseConfig as never, [], host);

            expect(host.calls.exec.some(a => a.includes("LIST"))).toBe(false);
        });

        it("checks the ACL list for a non-default user", async () => {
            const host = redisHost(kind, { "ACL WHOAMI": { stdout: "backup\n" } });
            await prepareRestore(baseConfig as never, [], host);

            expect(host.calls.exec.some(a => a.includes("LIST"))).toBe(true);
        });
    });

    describe("restore()", () => {
        it("reports the server data directory and RDB filename", async () => {
            const host = redisHost(kind, {
                "CONFIG dir": { stdout: "dir\n/var/lib/redis\n" },
                "CONFIG dbfilename": { stdout: "dbfilename\nsnapshot.rdb\n" },
            });

            const result = await restore(baseConfig as never, "/tmp/backup.rdb", host);

            expect(result.success).toBe(true);
            expect(result.metadata).toMatchObject({
                requiresManualSteps: true,
                dataDir: "/var/lib/redis",
                rdbFilename: "snapshot.rdb",
            });
        });

        it("falls back to conventional paths when the server does not say", async () => {
            const result = await restore(baseConfig as never, "/tmp/backup.rdb", redisHost(kind));

            expect(result.metadata).toMatchObject({
                dataDir: "/var/lib/redis",
                rdbFilename: "dump.rdb",
            });
        });

        it("names Valkey when the server reports a Valkey version", async () => {
            const host = redisHost(kind, { INFO: { stdout: "valkey_version:8.0.1\r\n" } });
            const logs: string[] = [];

            await restore(baseConfig as never, "/tmp/backup.rdb", host, (m: string) => logs.push(m));

            expect(logs.join("\n")).toContain("VALKEY RESTORE REQUIRES MANUAL STEPS");
        });

        it("defaults to Redis when the version cannot be read", async () => {
            const host = redisHost(kind, { INFO: { code: 1, stdout: "" } });
            const logs: string[] = [];

            await restore(baseConfig as never, "/tmp/backup.rdb", host, (m: string) => logs.push(m));

            expect(logs.join("\n")).toContain("REDIS RESTORE REQUIRES MANUAL STEPS");
        });

        it("fails when the backup file cannot be read", async () => {
            mockFsStat.mockRejectedValue(new Error("ENOENT: no such file"));

            const result = await restore(baseConfig as never, "/tmp/missing.rdb", redisHost(kind));

            expect(result.success).toBe(false);
            expect(result.error).toContain("ENOENT");
        });
    });
});
