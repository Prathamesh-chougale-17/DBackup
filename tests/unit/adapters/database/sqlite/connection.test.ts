import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SQLiteConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockExecFileCb,
    mockFsAccess,
    mockFsStat,
    mockSshConnect,
    mockSshExec,
    mockSshEnd,
    mockExtractSqliteSshConfig,
    mockRemoteBinaryCheck,
} = vi.hoisted(() => ({
    mockExecFileCb: vi.fn(),
    mockFsAccess: vi.fn(),
    mockFsStat: vi.fn(),
    mockSshConnect: vi.fn(),
    mockSshExec: vi.fn(),
    mockSshEnd: vi.fn(),
    mockExtractSqliteSshConfig: vi.fn(),
    mockRemoteBinaryCheck: vi.fn(),
}));

vi.mock("child_process", () => ({
    execFile: mockExecFileCb,
    default: { execFile: mockExecFileCb },
}));

vi.mock("fs/promises", () => ({
    default: {
        access: (...args: any[]) => mockFsAccess(...args),
        stat: (...args: any[]) => mockFsStat(...args),
    },
    access: (...args: any[]) => mockFsAccess(...args),
    stat: (...args: any[]) => mockFsStat(...args),
}));

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = (...args: any[]) => mockSshConnect(...args);
        exec = (...args: any[]) => mockSshExec(...args);
        end = () => mockSshEnd();
    },
    shellEscape: vi.fn((s: string) => s),
    extractSqliteSshConfig: (...args: any[]) => mockExtractSqliteSshConfig(...args),
    remoteBinaryCheck: (...args: any[]) => mockRemoteBinaryCheck(...args),
}));

import {
    test,
    getDatabases,
    getDatabasesWithStats,
} from "@/lib/adapters/database/sqlite/connection";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function buildConfig(overrides: Partial<SQLiteConfig> = {}): SQLiteConfig {
    return {
        mode: "local",
        path: "/data/db.sqlite",
        sqliteBinaryPath: "sqlite3",
        ...overrides,
    } as SQLiteConfig;
}

/** Make execFile call its callback successfully. */
function execSucceeds(stdout = "") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
        cb(null, { stdout, stderr: "" });
    });
}

/** Make execFile call its callback with an error. */
function execFails(message = "command failed") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: { message: string }) => void;
        cb({ message });
    });
}

// -------------------------------------------------------------------------
// test() - local mode
// -------------------------------------------------------------------------

describe("SQLite Connection - test() local mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns success when binary and file are accessible", async () => {
        execSucceeds("3.39.2 2022-07-21 15:24:47");
        mockFsAccess.mockResolvedValue(undefined);

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Local SQLite connection successful");
        expect(result.version).toBe("3.39.2");
    });

    it("uses 'sqlite3' as default binary when not specified", async () => {
        execSucceeds("3.40.0 2023-01-01");
        mockFsAccess.mockResolvedValue(undefined);

        const result = await test(buildConfig({ sqliteBinaryPath: undefined }), fakeHost);

        expect(result.success).toBe(true);
        expect(mockExecFileCb).toHaveBeenCalledWith(
            "sqlite3",
            expect.any(Array),
            expect.any(Function),
        );
    });

    it("returns failure when binary is not found", async () => {
        mockExecFileCb.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: Error) => void;
            const err = new Error("spawn sqlite3 ENOENT");
            cb(err);
        });
        mockFsAccess.mockResolvedValue(undefined);

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("ENOENT");
    });

    it("returns failure when database file is not accessible", async () => {
        execSucceeds("3.39.2 2022-07-21");
        mockFsAccess.mockRejectedValue(new Error("EACCES: permission denied"));

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("EACCES");
    });
});

// -------------------------------------------------------------------------
// test() - ssh mode
// -------------------------------------------------------------------------

describe("SQLite Connection - test() ssh mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function buildSshConfig(overrides: Partial<SQLiteConfig> = {}): SQLiteConfig {
        return buildConfig({
            mode: "ssh",
            host: "example.com",
            username: "admin",
            ...overrides,
        });
    }

    it("returns failure when SSH config is missing host/username", async () => {
        mockExtractSqliteSshConfig.mockReturnValue(null);

        const result = await test(buildSshConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH host and username are required");
    });

    it("returns success when SSH connection and file check pass", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "example.com", username: "admin" });
        mockSshConnect.mockResolvedValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("sqlite3");
        mockSshExec
            .mockResolvedValueOnce({ stdout: "3.39.2 2022-07-21 15:24:47", code: 0 }) // version
            .mockResolvedValueOnce({ stdout: "exists", code: 0 }); // file check

        const result = await test(buildSshConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("SSH SQLite connection successful");
        expect(result.version).toBe("3.39.2");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("returns failure when remote file does not exist", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "example.com", username: "admin" });
        mockSshConnect.mockResolvedValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("sqlite3");
        mockSshExec
            .mockResolvedValueOnce({ stdout: "3.39.2 2022-07-21", code: 0 }) // version
            .mockResolvedValueOnce({ stdout: "", code: 1 }); // file not found

        const result = await test(buildSshConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("not found");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("returns failure when SSH connection throws", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "example.com", username: "admin" });
        mockSshConnect.mockRejectedValue(new Error("Connection refused"));

        const result = await test(buildSshConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Connection refused");
        expect(mockSshEnd).toHaveBeenCalled();
    });
});

// -------------------------------------------------------------------------
// test() - invalid mode
// -------------------------------------------------------------------------

describe("SQLite Connection - test() invalid mode", () => {
    it("returns failure for unsupported mode", async () => {
        const config = buildConfig({ mode: "local" });
        // Override mode to an invalid value bypassing TypeScript
        (config as any).mode = "ftp";

        const result = await test(config, fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid mode");
    });
});

// -------------------------------------------------------------------------
// getDatabases()
// -------------------------------------------------------------------------

describe("SQLite Connection - getDatabases()", () => {
    it("returns filename extracted from path", async () => {
        const result = await getDatabases(buildConfig({ path: "/var/data/myapp.sqlite" }), fakeHost);
        expect(result).toEqual(["myapp.sqlite"]);
    });

    it("returns fallback name when path has no separator", async () => {
        const result = await getDatabases(buildConfig({ path: "database.sqlite" }), fakeHost);
        expect(result).toEqual(["database.sqlite"]);
    });
});

// -------------------------------------------------------------------------
// getDatabasesWithStats() - local mode
// -------------------------------------------------------------------------

describe("SQLite Connection - getDatabasesWithStats() local mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns name, size and table count on success", async () => {
        mockFsStat.mockResolvedValue({ size: 204800 });
        execSucceeds("5\n");

        const result = await getDatabasesWithStats(buildConfig({ path: "/data/app.sqlite" }), fakeHost);

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("app.sqlite");
        expect(result[0].sizeInBytes).toBe(204800);
        expect(result[0].tableCount).toBe(5);
    });

    it("returns name and size even when table count query fails", async () => {
        mockFsStat.mockResolvedValue({ size: 1024 });
        execFails("no such table");

        const result = await getDatabasesWithStats(buildConfig({ path: "/data/app.sqlite" }), fakeHost);

        expect(result[0].name).toBe("app.sqlite");
        expect(result[0].sizeInBytes).toBe(1024);
        expect(result[0].tableCount).toBeUndefined();
    });

    it("returns name only when stat fails", async () => {
        mockFsStat.mockRejectedValue(new Error("ENOENT"));

        const result = await getDatabasesWithStats(buildConfig({ path: "/data/app.sqlite" }), fakeHost);

        expect(result[0].name).toBe("app.sqlite");
        expect(result[0].sizeInBytes).toBeUndefined();
    });
});

// -------------------------------------------------------------------------
// getDatabasesWithStats() - ssh mode
// -------------------------------------------------------------------------

describe("SQLite Connection - getDatabasesWithStats() ssh mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function buildSshConfig(overrides: Partial<SQLiteConfig> = {}): SQLiteConfig {
        return buildConfig({ mode: "ssh", host: "host.example", username: "user", ...overrides });
    }

    it("returns name only when SSH config is missing", async () => {
        mockExtractSqliteSshConfig.mockReturnValue(null);

        const result = await getDatabasesWithStats(buildSshConfig({ path: "/remote/db.sqlite" }), fakeHost);

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("db.sqlite");
        expect(result[0].sizeInBytes).toBeUndefined();
    });

    it("returns name, size and table count on SSH success", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "204800", code: 0 }) // stat
            .mockResolvedValueOnce({ stdout: "3", code: 0 }); // table count

        const result = await getDatabasesWithStats(buildSshConfig({ path: "/remote/db.sqlite" }), fakeHost);

        expect(result[0].name).toBe("db.sqlite");
        expect(result[0].sizeInBytes).toBe(204800);
        expect(result[0].tableCount).toBe(3);
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("returns name and size when SSH table count fails", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "8192", code: 0 }) // stat
            .mockRejectedValueOnce(new Error("command failed")); // table count error

        const result = await getDatabasesWithStats(buildSshConfig({ path: "/remote/db.sqlite" }), fakeHost);

        expect(result[0].sizeInBytes).toBe(8192);
        expect(result[0].tableCount).toBeUndefined();
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("returns name only when SSH connection fails", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockRejectedValue(new Error("timeout"));

        const result = await getDatabasesWithStats(buildSshConfig({ path: "/remote/db.sqlite" }), fakeHost);

        expect(result[0].name).toBe("db.sqlite");
        expect(result[0].sizeInBytes).toBeUndefined();
        expect(mockSshEnd).toHaveBeenCalled();
    });
});
