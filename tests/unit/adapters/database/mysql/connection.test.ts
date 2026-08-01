import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MySQLConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockExecFileCb,
    mockIsSSHMode,
    mockGetMysqlCommand,
    mockGetMysqladminCommand,
    mockSshConnect,
    mockSshExec,
    mockSshEnd,
    mockExtractSshConfig,
    mockRemoteBinaryCheck,
    mockBuildMysqlArgs,
} = vi.hoisted(() => ({
    mockExecFileCb: vi.fn(),
    mockIsSSHMode: vi.fn(),
    mockGetMysqlCommand: vi.fn(() => "mysql"),
    mockGetMysqladminCommand: vi.fn(() => "mysqladmin"),
    mockSshConnect: vi.fn(),
    mockSshExec: vi.fn(),
    mockSshEnd: vi.fn(),
    mockExtractSshConfig: vi.fn(() => ({ host: "jump.example.com", port: 22 })),
    mockRemoteBinaryCheck: vi.fn(() => Promise.resolve("mysql")),
    mockBuildMysqlArgs: vi.fn(() => ["-h", "db.internal", "-u", "root"]),
}));

// connection.ts uses util.promisify(execFile); mock execFile so promisify wraps the mock.
vi.mock("child_process", () => ({
    execFile: mockExecFileCb,
    default: { execFile: mockExecFileCb },
}));

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = (...args: any[]) => mockSshConnect(...args);
        exec = (...args: any[]) => mockSshExec(...args);
        end = (...args: any[]) => mockSshEnd(...args);
        uploadFile = vi.fn().mockResolvedValue(undefined);
    },
    isSSHMode: (...args: any[]) => mockIsSSHMode(...args),
    extractSshConfig: (...args: any[]) => (mockExtractSshConfig as any)(...args),
    buildMysqlArgs: (...args: any[]) => (mockBuildMysqlArgs as any)(...args),
    withLocalMyCnf: vi.fn(async (password: any, callback: any) =>
        password ? callback('/tmp/mock-local.cnf') : callback(undefined)
    ),
    withRemoteMyCnf: vi.fn(async (_ssh: any, password: any, callback: any) =>
        password ? callback('/tmp/mock.cnf') : callback(undefined)
    ),
    remoteEnv: vi.fn((_env: any, cmd: string) => cmd),
    remoteBinaryCheck: (...args: any[]) => (mockRemoteBinaryCheck as any)(...args),
    shellEscape: vi.fn((s: string) => s),
}));

vi.mock("@/lib/adapters/database/mysql/tools", () => ({
    getMysqlCommand: (...args: any[]) => (mockGetMysqlCommand as (...a: any[]) => any)(...args),
    getMysqladminCommand: (...args: any[]) => (mockGetMysqladminCommand as (...a: any[]) => any)(...args),
    getMysqldumpCommand: vi.fn(() => "mysqldump"),
    initMysqlTools: vi.fn(),
}));

import {
    test,
    getDatabases,
    getDatabasesWithStats,
    ensureDatabase,
} from "@/lib/adapters/database/mysql/connection";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function buildConfig(overrides: Partial<MySQLConfig> = {}): MySQLConfig {
    return {
        host: "localhost",
        port: 3306,
        user: "root",
        password: "secret",
        database: "testdb",
        disableSsl: false,
        ...overrides,
    } as MySQLConfig;
}

/** Make mockExecFileCb call its last-arg callback successfully with the given stdout. */
function execSucceeds(stdout = "") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
        cb(null, { stdout, stderr: "" });
    });
}

/** Make mockExecFileCb call its last-arg callback with an error. */
function execFails(message = "command failed", stderr = "") {
    mockExecFileCb.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: { message: string; stderr: string }) => void;
        cb({ message, stderr });
    });
}

describe("MySQL Connection - test()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("returns success with a parsed version on ping + version success", async () => {
        mockExecFileCb
            .mockImplementationOnce((...args: unknown[]) => {
                // mysqladmin ping
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "mysqld is alive", stderr: "" });
            })
            .mockImplementationOnce((...args: unknown[]) => {
                // mysql SELECT VERSION()
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "8.0.35-MySQL Community Server\n", stderr: "" });
            });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Connection successful");
        expect(result.version).toBe("8.0.35");
    });

    it("strips MariaDB suffix from version string", async () => {
        mockExecFileCb
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "mysqld is alive", stderr: "" });
            })
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "11.4.9-MariaDB-ubu2404\n", stderr: "" });
            });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("11.4.9");
    });

    it("returns failure when mysqladmin ping fails", async () => {
        mockExecFileCb.mockImplementationOnce((...args: unknown[]) => {
            const cb = args[args.length - 1] as (err: { stderr: string; message: string }) => void;
            cb({ stderr: "Access denied for user", message: "Command failed" });
        });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Connection failed");
        expect(result.message).toContain("Access denied");
    });

    it("returns the raw version string when it does not start with digits", async () => {
        mockExecFileCb
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "mysqld is alive", stderr: "" });
            })
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "custom-build\n", stderr: "" });
            });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("custom-build");
    });

    it("includes --skip-ssl args when disableSsl is true", async () => {
        mockExecFileCb
            .mockImplementationOnce((...args: unknown[]) => {
                const cmdArgs = args[1] as string[];
                expect(cmdArgs).toContain("--skip-ssl");
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "mysqld is alive", stderr: "" });
            })
            .mockImplementationOnce((...args: unknown[]) => {
                const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: "8.0.35\n", stderr: "" });
            });

        await test(buildConfig({ disableSsl: true }), fakeHost);
    });
});

describe("MySQL Connection - getDatabases()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("returns user databases and filters system databases", async () => {
        execSucceeds("information_schema\nmysql\nperformance_schema\nsys\ntestdb\n");

        const dbs = await getDatabases(buildConfig(), fakeHost);

        expect(dbs).toEqual(["testdb"]);
        expect(dbs).not.toContain("information_schema");
        expect(dbs).not.toContain("mysql");
        expect(dbs).not.toContain("performance_schema");
        expect(dbs).not.toContain("sys");
    });

    it("returns multiple user databases", async () => {
        execSucceeds("shop\nanalytics\nblog\n");

        const dbs = await getDatabases(buildConfig(), fakeHost);

        expect(dbs).toEqual(["shop", "analytics", "blog"]);
    });

    it("returns an empty array when only system databases exist", async () => {
        execSucceeds("information_schema\nmysql\n");

        const dbs = await getDatabases(buildConfig(), fakeHost);

        expect(dbs).toEqual([]);
    });

    it("passes --skip-ssl to the command when disableSsl is true", async () => {
        mockExecFileCb.mockImplementation((...args: unknown[]) => {
            const cmdArgs = args[1] as string[];
            expect(cmdArgs).toContain("--skip-ssl");
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "mydb\n", stderr: "" });
        });

        const dbs = await getDatabases(buildConfig({ disableSsl: true }), fakeHost);

        expect(dbs).toEqual(["mydb"]);
    });
});

describe("MySQL Connection - getDatabasesWithStats()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("parses tab-separated stats output correctly", async () => {
        execSucceeds("shop\t102400\t12\nanalytics\t512000\t3\n");

        const stats = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(stats).toHaveLength(2);
        expect(stats[0]).toEqual({ name: "shop", sizeInBytes: 102400, tableCount: 12 });
        expect(stats[1]).toEqual({ name: "analytics", sizeInBytes: 512000, tableCount: 3 });
    });

    it("returns an empty array for empty stdout", async () => {
        execSucceeds("");

        const stats = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(stats).toEqual([]);
    });

    it("defaults size and count to 0 for unparseable values", async () => {
        execSucceeds("broken\tNULL\tNULL\n");

        const stats = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(stats[0]).toEqual({ name: "broken", sizeInBytes: 0, tableCount: 0 });
    });

    it("passes --skip-ssl to the command when disableSsl is true", async () => {
        mockExecFileCb.mockImplementation((...args: unknown[]) => {
            const cmdArgs = args[1] as string[];
            expect(cmdArgs).toContain("--skip-ssl");
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "shop\t1024\t5\n", stderr: "" });
        });

        const stats = await getDatabasesWithStats(buildConfig({ disableSsl: true }), fakeHost);

        expect(stats[0].name).toBe("shop");
    });
});

describe("MySQL Connection - ensureDatabase()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
    });

    it("runs CREATE DATABASE when not privileged", async () => {
        execSucceeds();

        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", "secret", false, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
        // Only one execFile call (CREATE DATABASE, no GRANT)
        expect(mockExecFileCb).toHaveBeenCalledTimes(1);
    });

    it("runs CREATE DATABASE and GRANT when privileged", async () => {
        execSucceeds();

        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "admin", "adminpw", true, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
        expect(logs).toContain("Permissions granted for 'newdb'.");
        // Two execFile calls: CREATE DATABASE + GRANT
        expect(mockExecFileCb).toHaveBeenCalledTimes(2);
    });

    it("pushes a warning to logs when the command fails", async () => {
        execFails("Access denied");

        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "faildb", "root", "secret", false, logs);

        expect(logs.some((l) => l.includes("Warning") && l.includes("faildb"))).toBe(true);
    });

    it("includes --skip-ssl in args when disableSsl is true", async () => {
        mockExecFileCb.mockImplementation((...args: unknown[]) => {
            const cmdArgs = args[1] as string[];
            expect(cmdArgs).toContain("--skip-ssl");
            const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
            cb(null, { stdout: "", stderr: "" });
        });

        const logs: string[] = [];
        await ensureDatabase(buildConfig({ disableSsl: true }), "newdb", "root", "secret", false, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
    });
});

// -------------------------------------------------------------------------
// ensureDatabase() - SSH path
// -------------------------------------------------------------------------

describe("MySQL Connection - ensureDatabase() SSH path", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(true);
        mockSshConnect.mockResolvedValue(undefined);
        mockSshEnd.mockReturnValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("mysql");
        mockBuildMysqlArgs.mockReturnValue(["-h", "db.internal", "-u", "root"]);
    });

    it("creates the database via SSH successfully", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", "secret", false, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("creates database and grants privileges via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", "secret", true, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
        expect(logs).toContain("Permissions granted for 'newdb'.");
        expect(mockSshExec).toHaveBeenCalledTimes(2);
    });

    it("logs a warning when create database command returns non-zero code via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "Access denied" });
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "faildb", "root", "secret", false, logs);

        expect(logs.some((l) => l.includes("Warning") && l.includes("faildb"))).toBe(true);
    });

    it("logs a warning when grant command fails via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
            .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Grant denied" });
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", "secret", true, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
        expect(logs.some((l) => l.includes("Warning grants"))).toBe(true);
    });

    it("catches SSH connection errors and logs a warning", async () => {
        mockSshConnect.mockRejectedValue(new Error("SSH connection refused"));
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", "secret", false, logs);

        expect(logs.some((l) => l.includes("Warning") && l.includes("newdb"))).toBe(true);
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("does not set MYSQL_PWD when pass is undefined", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        const logs: string[] = [];
        await ensureDatabase(buildConfig(), "newdb", "root", undefined, false, logs);

        expect(logs).toContain("Database 'newdb' ensured.");
    });
});

// -------------------------------------------------------------------------
// test() - SSH path
// -------------------------------------------------------------------------

describe("MySQL Connection - test() SSH path", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(true);
        mockSshConnect.mockResolvedValue(undefined);
        mockSshEnd.mockReturnValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("mysql");
        mockBuildMysqlArgs.mockReturnValue(["-h", "db.internal", "-u", "root"]);
    });

    it("returns success with version via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })  // ping
            .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" })  // SELECT 1
            .mockResolvedValueOnce({ code: 0, stdout: "8.0.35-MySQL Community Server\n", stderr: "" }); // version

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("SSH");
        expect(result.version).toBe("8.0.35");
    });

    it("returns failure when SSH ping fails", async () => {
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "Connection refused" });

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH ping failed");
    });

    it("returns failure when auth check (SELECT 1) fails via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })  // ping
            .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "ERROR 1045 (28000): Access denied for user" }); // SELECT 1

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Connection failed");
    });

    it("returns success with version unknown when version query fails via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })  // ping
            .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" })  // SELECT 1
            .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Permission denied" }); // version fails

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.message).toContain("version unknown");
    });

    it("returns raw version string when regex does not match via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })  // ping
            .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" })  // SELECT 1
            .mockResolvedValueOnce({ code: 0, stdout: "custom-build\n", stderr: "" }); // version

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(true);
        expect(result.version).toBe("custom-build");
    });

    it("catches SSH exceptions and returns failure", async () => {
        mockSshConnect.mockRejectedValue(new Error("Connection timeout"));

        const result = await test(buildConfig(), fakeHost);

        expect(result.success).toBe(false);
        expect(result.message).toContain("SSH connection failed");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("does not set MYSQL_PWD when password is not set via SSH", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })  // ping
            .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" })  // SELECT 1
            .mockResolvedValueOnce({ code: 0, stdout: "8.0.35\n", stderr: "" }); // version

        const result = await test(buildConfig({ password: undefined }), fakeHost);

        expect(result.success).toBe(true);
    });
});

// -------------------------------------------------------------------------
// getDatabases() - SSH path
// -------------------------------------------------------------------------

describe("MySQL Connection - getDatabases() SSH path", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(true);
        mockSshConnect.mockResolvedValue(undefined);
        mockSshEnd.mockReturnValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("mysql");
        mockBuildMysqlArgs.mockReturnValue(["-h", "db.internal", "-u", "root"]);
    });

    it("returns filtered databases via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "information_schema\nmysql\ntestdb\nshop\n", stderr: "" });

        const dbs = await getDatabases(buildConfig(), fakeHost);

        expect(dbs).toEqual(["testdb", "shop"]);
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("throws when SSH exec returns non-zero code", async () => {
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "Permission denied" });

        await expect(getDatabases(buildConfig(), fakeHost)).rejects.toThrow("Failed to list databases");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("does not set MYSQL_PWD when password is not set via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "testdb\n", stderr: "" });

        const dbs = await getDatabases(buildConfig({ password: undefined }), fakeHost);

        expect(dbs).toEqual(["testdb"]);
    });
});

// -------------------------------------------------------------------------
// getDatabasesWithStats() - SSH path
// -------------------------------------------------------------------------

describe("MySQL Connection - getDatabasesWithStats() SSH path", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(true);
        mockSshConnect.mockResolvedValue(undefined);
        mockSshEnd.mockReturnValue(undefined);
        mockRemoteBinaryCheck.mockResolvedValue("mysql");
        mockBuildMysqlArgs.mockReturnValue(["-h", "db.internal", "-u", "root"]);
    });

    it("returns parsed database stats via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "shop\t102400\t12\nanalytics\t512000\t3\n", stderr: "" });

        const stats = await getDatabasesWithStats(buildConfig(), fakeHost);

        expect(stats).toHaveLength(2);
        expect(stats[0]).toEqual({ name: "shop", sizeInBytes: 102400, tableCount: 12 });
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("throws when SSH exec returns non-zero code", async () => {
        // Both the stats query and the SHOW DATABASES fallback fail.
        mockSshExec.mockResolvedValue({ code: 1, stdout: "", stderr: "Permission denied" });

        await expect(getDatabasesWithStats(buildConfig(), fakeHost)).rejects.toThrow("Failed to list databases");
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("does not set MYSQL_PWD when password is not set via SSH", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "shop\t1024\t5\n", stderr: "" });

        const stats = await getDatabasesWithStats(buildConfig({ password: undefined }), fakeHost);

        expect(stats[0].name).toBe("shop");
    });
});
