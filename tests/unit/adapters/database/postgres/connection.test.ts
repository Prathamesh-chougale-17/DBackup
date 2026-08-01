import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostgresConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockExecFileCb,
    mockIsSSHMode,
    mockSshExec,
} = vi.hoisted(() => ({
    mockExecFileCb: vi.fn(),
    mockIsSSHMode: vi.fn(),
    mockSshExec: vi.fn(),
}));

// connection.ts uses util.promisify(execFile); mock execFile so promisify wraps the mock.
vi.mock("child_process", () => ({
    execFile: mockExecFileCb,
    default: { execFile: mockExecFileCb },
}));

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = vi.fn().mockResolvedValue(undefined);
        exec = (...args: any[]) => mockSshExec(...args);
        end = vi.fn();
    },
    isSSHMode: (...args: any[]) => mockIsSSHMode(...args),
    extractSshConfig: vi.fn(() => ({ host: "jump.example.com", port: 22 })),
    buildPsqlArgs: vi.fn(() => ["-h", "db.internal", "-U", "postgres"]),
    remoteEnv: vi.fn((_env: any, cmd: string) => cmd),
    remoteBinaryCheck: vi.fn().mockResolvedValue("psql"),
    shellEscape: vi.fn((s: string) => s),
}));

import {
    test,
    getDatabases,
    getDatabasesWithStats,
} from "@/lib/adapters/database/postgres/connection";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function buildConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
    return {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "secret",
        database: "testdb",
        ...overrides,
    } as PostgresConfig;
}

/** Make mockExecFileCb call its last-arg callback successfully with the given stdout. */
function execSucceeds(stdout = "") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
            err: null,
            result: { stdout: string; stderr: string }
        ) => void;
        cb(null, { stdout, stderr: "" });
    });
}

/** Make mockExecFileCb call its last-arg callback with an Error (with optional stderr). */
function execFails(message = "command failed", stderr = "") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error & { stderr?: string }) => void;
        const err = Object.assign(new Error(message), { stderr });
        cb(err);
    });
}

// -------------------------------------------------------------------------
// test()
// -------------------------------------------------------------------------

describe("PostgreSQL Connection - test()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("returns success with parsed version on first database attempt", async () => {
        execSucceeds("PostgreSQL 16.1 on x86_64-pc-linux-gnu\n");

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Connection successful");
        expect(result.version).toBe("16.1");
    });

    it("extracts minor version from full PostgreSQL version string", async () => {
        execSucceeds("PostgreSQL 14.10 on aarch64-unknown-linux-gnu, compiled by gcc\n");

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("14.10");
    });

    it("falls back to raw version string when regex does not match", async () => {
        execSucceeds("custom-build\n");

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("custom-build");
    });

    it("adds config.database to the try-list when set", async () => {
        mockExecFileCb
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: Error) => void;
                cb(new Error("postgres db not found"));
            })
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: Error) => void;
                cb(new Error("template1 not found"));
            })
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (
                    err: null,
                    result: { stdout: string; stderr: string }
                ) => void;
                cb(null, { stdout: "PostgreSQL 15.3\n", stderr: "" });
            });

        const result = await test(buildConfig({ database: "testdb" }), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("15.3");
    });

    it("returns failure when all connection attempts fail", async () => {
        execFails("Connection refused", "FATAL: connection refused");

        const result = await test(buildConfig({ database: undefined }), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Connection failed");
    });

    it("includes stderr in the failure message when available", async () => {
        execFails("command failed", "FATAL: password authentication failed");

        const result = await test(buildConfig({ database: undefined }), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("FATAL: password authentication failed");
    });

    it("handles non-Error rejection values from failed psql (uses String())", async () => {
        // Simulate execFile callback called with a string instead of Error
        mockExecFileCb.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: string) => void;
            cb("connection timeout");
        });

        const result = await test(buildConfig({ database: undefined }), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("connection timeout");
    });

    it("uses lastError.message when stderr is empty on failed connection", async () => {
        execFails("connection refused"); // default empty stderr

        const result = await test(buildConfig({ database: undefined }), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("connection refused");
    });

    // -------------------------------------------------------------------------
    // SSH path
    // -------------------------------------------------------------------------

    it("returns success via SSH when exec returns code 0", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({
            code: 0,
            stdout: "PostgreSQL 16.2 on x86_64\n",
            stderr: "",
        });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("SSH");
        expect(result.version).toBe("16.2");
    });

    it("returns failure via SSH when all exec calls return non-zero code", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({
            code: 1,
            stdout: "",
            stderr: "connection refused",
        });

        const result = await test(buildConfig({ database: undefined }), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH");
    });

    it("returns raw stdout as version when it does not match PostgreSQL pattern (SSH)", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 0, stdout: "custom-build-1.0\n", stderr: "" });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("custom-build-1.0");
    });

    it("handles missing password in SSH env setup", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 0, stdout: "PostgreSQL 15.0\n", stderr: "" });

        const result = await test(buildConfig({ password: "" }), fakeHost);

        expect(result.success).toBe(true);
    });

    it("returns failure via SSH when exec rejects with non-Error value", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockImplementation(() => Promise.reject("timeout string"));

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH connection failed");
        expect(result.message).toContain("timeout string");
    });

    it("uses error.message when SSH exec rejects with an Error instance", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockRejectedValue(new Error("SSH transport error"));

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH connection failed");
        expect(result.message).toContain("SSH transport error");
    });
});

// -------------------------------------------------------------------------
// getDatabases()
// -------------------------------------------------------------------------

describe("PostgreSQL Connection - getDatabases()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("returns list of databases from psql output", async () => {
        execSucceeds("postgres\ntestdb\nanalytics\n");

        const result = await getDatabases(buildConfig(), fakeHost);

        expect(result).toEqual(["postgres", "testdb", "analytics"]);
    });

    it("filters out empty lines from psql output", async () => {
        execSucceeds("db1\n\ndb2\n\n");

        const result = await getDatabases(buildConfig(), fakeHost);

        expect(result).toEqual(["db1", "db2"]);
    });

    it("throws when all connection attempts fail", async () => {
        execFails("connection refused");

        await expect(getDatabases(buildConfig({ database: undefined }), fakeHost)).rejects.toBeDefined();
    });

    it("returns databases via SSH when SSH mode is active", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({
            code: 0,
            stdout: "postgres\napp_db\n",
            stderr: "",
        });

        const result = await getDatabases(buildConfig(), fakeHost);

        expect(result).toEqual(["postgres", "app_db"]);
    });

    it("handles missing password in SSH getDatabases env setup", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 0, stdout: "mydb\n", stderr: "" });

        const result = await getDatabases(buildConfig({ password: "" }), fakeHost);

        expect(result).toEqual(["mydb"]);
    });

    it("throws via SSH when all exec calls return non-zero", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });

        await expect(getDatabases(buildConfig({ database: undefined }), fakeHost)).rejects.toThrow(
            "Failed to list databases via SSH"
        );
    });
});

// -------------------------------------------------------------------------
// getDatabasesWithStats()
// -------------------------------------------------------------------------

describe("PostgreSQL Connection - getDatabasesWithStats()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("returns parsed stats from tab-separated psql output", async () => {
        execSucceeds("postgres\t8192000\napp_db\t204800\n");

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toEqual([
            { name: "postgres", sizeInBytes: 8192000 },
            { name: "app_db", sizeInBytes: 204800 },
        ]);
    });

    it("defaults to 0 for unparseable size field", async () => {
        execSucceeds("broken\tnot_a_number\n");

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toEqual([
            { name: "broken", sizeInBytes: 0 },
        ]);
    });

    it("filters out empty lines", async () => {
        execSucceeds("db1\t1024\n\n");

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toHaveLength(1);
    });

    it("populates tableCount via per-database query when count succeeds", async () => {
        // stats query
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "postgres\t8192000\napp_db\t204800\n", stderr: "" });
        });
        // table count for postgres
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "5\n", stderr: "" });
        });
        // table count for app_db
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "12\n", stderr: "" });
        });

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toEqual([
            { name: "postgres", sizeInBytes: 8192000, tableCount: 5 },
            { name: "app_db", sizeInBytes: 204800, tableCount: 12 },
        ]);
    });

    it("omits tableCount when per-database count query fails", async () => {
        // stats query succeeds
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "app_db\t204800\n", stderr: "" });
        });
        // table count query fails (e.g., permission denied)
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: Error) => void;
            cb(Object.assign(new Error("permission denied"), { stderr: "" }));
        });

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toEqual([{ name: "app_db", sizeInBytes: 204800 }]);
    });

    it("throws when all connection attempts fail", async () => {
        execFails("connection refused");

        await expect(
            getDatabasesWithStats(buildConfig({ database: undefined }), fakeHost)
        ).rejects.toBeDefined();
    });

    it("returns stats via SSH when SSH mode is active", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({
            code: 0,
            stdout: "mydb\t512000\n",
            stderr: "",
        });

        const result = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(result).toEqual([{ name: "mydb", sizeInBytes: 512000 }]);
    });

    it("handles missing password in SSH getDatabasesWithStats env setup", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 0, stdout: "db1\t1024\n", stderr: "" });

        const result = await getDatabasesWithStats(buildConfig({ password: "" }), fakeHost);

        expect(result).toEqual([{ name: "db1", sizeInBytes: 1024 }]);
    });

    it("throws via SSH when all exec calls return non-zero", async () => {
        mockIsSSHMode.mockReturnValue(true);
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });

        await expect(
            getDatabasesWithStats(buildConfig({ database: undefined }), fakeHost)
        ).rejects.toThrow("Failed to get database stats via SSH");
    });
});
