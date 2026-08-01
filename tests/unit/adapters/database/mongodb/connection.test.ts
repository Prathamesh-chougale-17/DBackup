import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MongoDBConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockMongoConnect,
    mockMongoClose,
    mockAdminCommand,
    mockListCollections,
    mockSshConnect,
    mockSshExec,
    mockSshEnd,
    mockIsSSHMode,
    mockExtractSshConfig,
    mockBuildMongoArgs,
    mockRemoteBinaryCheck,
} = vi.hoisted(() => ({
    mockMongoConnect: vi.fn(),
    mockMongoClose: vi.fn(),
    mockAdminCommand: vi.fn(),
    mockListCollections: vi.fn(),
    mockSshConnect: vi.fn(),
    mockSshExec: vi.fn(),
    mockSshEnd: vi.fn(),
    mockIsSSHMode: vi.fn(),
    mockExtractSshConfig: vi.fn(),
    mockBuildMongoArgs: vi.fn(),
    mockRemoteBinaryCheck: vi.fn(),
}));

// Mock MongoClient
vi.mock("mongodb", () => {
    class MockMongoClient {
        connect() { return mockMongoConnect(); }
        close() { return mockMongoClose(); }
        db(_name: string) {
            return {
                command: (...args: any[]) => mockAdminCommand(...args),
                listCollections: () => ({ toArray: () => mockListCollections() }),
            };
        }
    }
    return { MongoClient: MockMongoClient };
});

// Mock SSH utilities
vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect(...args: any[]) { return mockSshConnect(...args); }
        exec(...args: any[]) { return mockSshExec(...args); }
        end() { return mockSshEnd(); }
    },
    isSSHMode: (...args: any[]) => mockIsSSHMode(...args),
    extractSshConfig: (...args: any[]) => mockExtractSshConfig(...args),
    buildMongoArgs: (...args: any[]) => mockBuildMongoArgs(...args),
    remoteBinaryCheck: (...args: any[]) => mockRemoteBinaryCheck(...args),
}));

import { test, getDatabases, getDatabasesWithStats } from "@/lib/adapters/database/mongodb/connection";

function buildConfig(overrides: Partial<MongoDBConfig> = {}): MongoDBConfig {
    return {
        connectionMode: "direct",
        host: "localhost",
        port: 27017,
        database: "testdb",
        ...overrides,
    };
}

describe("MongoDB Connection - test()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMongoClose.mockResolvedValue(undefined);
    });

    describe("direct connection", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(false);
        });

        it("returns success with version when connection works", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand
                .mockResolvedValueOnce(undefined) // ping
                .mockResolvedValueOnce({ version: "7.0.5" }); // buildInfo

            const result = await test(buildConfig(), fakeHost);

            expect(result.success).toBe(true);
            expect(result.message).toContain("successful");
            expect(result.version).toBe("7.0.5");
        });

        it("returns success with URI config", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ version: "6.0.0" });

            const result = await test(buildConfig({ uri: "mongodb://user:pass@host:27017/" }), fakeHost);

            expect(result.success).toBe(true);
            expect(result.version).toBe("6.0.0");
        });

        it("returns success and Unknown version when buildInfo has no version", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({});

            const result = await test(buildConfig(), fakeHost);

            expect(result.success).toBe(true);
            expect(result.version).toBe("Unknown");
        });

        it("returns failure when connect throws", async () => {
            mockMongoConnect.mockRejectedValue(new Error("Connection refused"));

            const result = await test(buildConfig(), fakeHost);

            expect(result.success).toBe(false);
            expect(result.message).toContain("Connection refused");
        });

        it("builds URI with auth when user and password provided", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ version: "7.0.0" });

            const result = await test(
                buildConfig({ user: "admin", password: "secret", authenticationDatabase: "admin" })
            , fakeHost);

            expect(result.success).toBe(true);
        });

        it("builds URI without auth when no user configured", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ version: "7.0.0" });

            const result = await test(buildConfig({ user: undefined, password: undefined }), fakeHost);

            expect(result.success).toBe(true);
        });
    });

    describe("SSH mode", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(true);
            mockExtractSshConfig.mockReturnValue({ host: "remote.example.com" });
            mockBuildMongoArgs.mockReturnValue(["--host", "localhost"]);
            mockRemoteBinaryCheck.mockResolvedValue("mongosh");
            mockSshConnect.mockResolvedValue(undefined);
            mockSshEnd.mockReturnValue(undefined);
        });

        it("returns success when SSH exec succeeds", async () => {
            mockSshExec.mockResolvedValue({ code: 0, stdout: "7.0.5\n", stderr: "" });

            const result = await test(buildConfig({ sshHost: "remote.example.com", sshUsername: "deploy" } as any), fakeHost);

            expect(result.success).toBe(true);
            expect(result.message).toContain("SSH");
            expect(result.version).toBe("7.0.5");
        });

        it("returns failure when SSH exec exits with non-zero code", async () => {
            mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "auth failed" });

            const result = await test(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost);

            expect(result.success).toBe(false);
            expect(result.message).toContain("auth failed");
        });

        it("returns failure when SSH connect throws", async () => {
            mockSshConnect.mockRejectedValue(new Error("SSH timeout"));

            const result = await test(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost);

            expect(result.success).toBe(false);
            expect(result.message).toContain("SSH connection failed");
        });
    });
});

describe("MongoDB Connection - getDatabases()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMongoClose.mockResolvedValue(undefined);
    });

    describe("direct connection", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(false);
        });

        it("filters out system databases", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand.mockResolvedValue({
                databases: [
                    { name: "admin" },
                    { name: "config" },
                    { name: "local" },
                    { name: "myapp" },
                    { name: "analytics" },
                ],
            });

            const result = await getDatabases(buildConfig(), fakeHost);

            expect(result).toEqual(["myapp", "analytics"]);
        });

        it("throws on connection failure", async () => {
            mockMongoConnect.mockRejectedValue(new Error("ECONNREFUSED"));

            await expect(getDatabases(buildConfig(), fakeHost)).rejects.toThrow("Failed to list databases");
        });
    });

    describe("SSH mode", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(true);
            mockExtractSshConfig.mockReturnValue({ host: "remote.example.com" });
            mockBuildMongoArgs.mockReturnValue(["--host", "localhost"]);
            mockRemoteBinaryCheck.mockResolvedValue("mongosh");
            mockSshConnect.mockResolvedValue(undefined);
            mockSshEnd.mockReturnValue(undefined);
        });

        it("parses JSON array from SSH output", async () => {
            mockSshExec.mockResolvedValue({
                code: 0,
                stdout: '["myapp","analytics","reports"]\n',
                stderr: "",
            });

            const result = await getDatabases(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost);

            expect(result).toEqual(["myapp", "analytics", "reports"]);
        });

        it("filters system databases from SSH output", async () => {
            mockSshExec.mockResolvedValue({
                code: 0,
                stdout: '["admin","local","myapp"]\n',
                stderr: "",
            });

            const result = await getDatabases(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost);

            expect(result).toEqual(["myapp"]);
        });

        it("falls back to line-by-line parsing when no JSON array found", async () => {
            mockSshExec.mockResolvedValue({
                code: 0,
                stdout: "myapp\nanalytics\n",
                stderr: "",
            });

            const result = await getDatabases(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost);

            expect(result).toContain("myapp");
            expect(result).toContain("analytics");
        });

        it("throws when SSH exec returns non-zero code", async () => {
            mockSshExec.mockResolvedValue({
                code: 1,
                stdout: "",
                stderr: "Access denied",
            });

            await expect(
                getDatabases(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost)
            ).rejects.toThrow("Failed to list databases");
        });
    });
});

describe("MongoDB Connection - getDatabasesWithStats()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMongoClose.mockResolvedValue(undefined);
    });

    describe("direct connection", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(false);
        });

        it("returns stats including collection count", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand.mockResolvedValue({
                databases: [
                    { name: "myapp", sizeOnDisk: 1024000 },
                    { name: "admin", sizeOnDisk: 512 },
                ],
            });
            mockListCollections.mockResolvedValue([{}, {}, {}]); // 3 collections

            const result = await getDatabasesWithStats(buildConfig(), fakeHost);

            expect(result).toHaveLength(1); // admin filtered
            expect(result[0].name).toBe("myapp");
            expect(result[0].sizeInBytes).toBe(1024000);
            expect(result[0].tableCount).toBe(3);
        });

        it("handles listCollections failure gracefully (best-effort)", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand.mockResolvedValue({
                databases: [{ name: "myapp", sizeOnDisk: 1024000 }],
            });
            mockListCollections.mockRejectedValue(new Error("no permission"));

            const result = await getDatabasesWithStats(buildConfig(), fakeHost);

            expect(result[0].name).toBe("myapp");
            expect(result[0].tableCount).toBeUndefined();
        });

        it("throws on connection failure", async () => {
            mockMongoConnect.mockRejectedValue(new Error("timeout"));

            await expect(getDatabasesWithStats(buildConfig(), fakeHost)).rejects.toThrow(
                "Failed to list databases with stats"
            );
        });

        it("handles close() failure silently in finally block", async () => {
            mockMongoConnect.mockResolvedValue(undefined);
            mockAdminCommand.mockResolvedValue({ databases: [{ name: "myapp", sizeOnDisk: 100 }] });
            mockListCollections.mockResolvedValue([]);
            mockMongoClose.mockRejectedValue(new Error("close failed"));

            // Should not throw even though close fails
            const result = await getDatabasesWithStats(buildConfig(), fakeHost);
            expect(result[0].name).toBe("myapp");
        });
    });

    describe("SSH mode", () => {
        beforeEach(() => {
            mockIsSSHMode.mockReturnValue(true);
            mockExtractSshConfig.mockReturnValue({ host: "remote.example.com" });
            mockBuildMongoArgs.mockReturnValue(["--host", "localhost"]);
            mockRemoteBinaryCheck.mockResolvedValue("mongosh");
            mockSshConnect.mockResolvedValue(undefined);
            mockSshEnd.mockReturnValue(undefined);
        });

        it("parses JSON stats array from SSH output", async () => {
            const stats = [
                { name: "myapp", size: 2048000, tables: 5 },
                { name: "config", size: 0, tables: 0 },
            ];
            mockSshExec.mockResolvedValue({
                code: 0,
                stdout: `${JSON.stringify(stats)}\n`,
                stderr: "",
            });

            const result = await getDatabasesWithStats(
                buildConfig({ sshHost: "remote.example.com" } as any)
            , fakeHost);

            // "config" is a system DB and gets filtered
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("myapp");
            expect(result[0].sizeInBytes).toBe(2048000);
            expect(result[0].tableCount).toBe(5);
        });

        it("throws when SSH exec fails", async () => {
            mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "connection refused" });

            await expect(
                getDatabasesWithStats(buildConfig({ sshHost: "remote.example.com" } as any), fakeHost)
            ).rejects.toThrow("Failed to get database stats");
        });

        it("falls back to tab-separated parsing when no JSON found", async () => {
            mockSshExec.mockResolvedValue({
                code: 0,
                stdout: "myapp\t1024\t4\n",
                stderr: "",
            });

            const result = await getDatabasesWithStats(
                buildConfig({ sshHost: "remote.example.com" } as any)
            , fakeHost);

            expect(result[0].name).toBe("myapp");
            expect(result[0].sizeInBytes).toBe(1024);
            expect(result[0].tableCount).toBe(4);
        });
    });
});
