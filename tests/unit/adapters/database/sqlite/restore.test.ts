import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SQLiteConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockSpawnProcess,
    mockFsExistsSync,
    mockFsCopyFileSync,
    mockFsUnlinkSync,
    mockFsCreateReadStream,
    mockFsStatPromise,
    mockSshConnect,
    mockSshExec,
    mockSshExecStream,
    mockSshUploadFile,
    mockSshEnd,
    mockExtractSqliteSshConfig,
    mockRandomUUID,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as { PassThrough: typeof import("stream").PassThrough };
    return {
        mockSpawnProcess: vi.fn(),
        mockFsExistsSync: vi.fn(),
        mockFsCopyFileSync: vi.fn(),
        mockFsUnlinkSync: vi.fn(),
        mockFsCreateReadStream: vi.fn(),
        mockFsStatPromise: vi.fn(),
        mockSshConnect: vi.fn(),
        mockSshExec: vi.fn(),
        mockSshExecStream: vi.fn(),
        mockSshUploadFile: vi.fn(),
        mockSshEnd: vi.fn(),
        mockExtractSqliteSshConfig: vi.fn(),
        mockRandomUUID: vi.fn(() => "test-uuid-1234"),
        PassThrough,
    };
});

vi.mock("child_process", () => ({
    spawn: (...args: any[]) => mockSpawnProcess(...args),
    default: { spawn: (...args: any[]) => mockSpawnProcess(...args) },
}));

vi.mock("fs", () => ({
    default: {
        existsSync: (...args: any[]) => mockFsExistsSync(...args),
        copyFileSync: (...args: any[]) => mockFsCopyFileSync(...args),
        unlinkSync: (...args: any[]) => mockFsUnlinkSync(...args),
        createReadStream: (...args: any[]) => mockFsCreateReadStream(...args),
        promises: { stat: (...args: any[]) => mockFsStatPromise(...args) },
    },
    existsSync: (...args: any[]) => mockFsExistsSync(...args),
    copyFileSync: (...args: any[]) => mockFsCopyFileSync(...args),
    unlinkSync: (...args: any[]) => mockFsUnlinkSync(...args),
    createReadStream: (...args: any[]) => mockFsCreateReadStream(...args),
    promises: { stat: (...args: any[]) => mockFsStatPromise(...args) },
}));

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = (...args: any[]) => mockSshConnect(...args);
        exec = (...args: any[]) => mockSshExec(...args);
        execStream = (...args: any[]) => mockSshExecStream(...args);
        uploadFile = (...args: any[]) => mockSshUploadFile(...args);
        end = () => mockSshEnd();
    },
    shellEscape: vi.fn((s: string) => s),
    extractSqliteSshConfig: (...args: any[]) => mockExtractSqliteSshConfig(...args),
}));

vi.mock("crypto", () => ({
    randomUUID: (...args: any[]) => (mockRandomUUID as (...a: any[]) => any)(...args),
    default: { randomUUID: (...args: any[]) => (mockRandomUUID as (...a: any[]) => any)(...args) },
}));

import { prepareRestore, restore } from "@/lib/adapters/database/sqlite/restore";

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

/** Creates a mock spawn child process. */
function makeSpawnProcess(exitCode = 0, stderrData?: string) {
    const proc = new PassThrough() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();

    process.nextTick(() => {
        if (stderrData) proc.stderr.emit("data", Buffer.from(stderrData));
        proc.emit("close", exitCode);
    });

    return proc;
}

/** Creates a mock SSH stream. */
function makeSshStream(exitCode = 0, stderrData?: string) {
    const stream = new PassThrough() as any;
    stream.stderr = new PassThrough();

    process.nextTick(() => {
        if (stderrData) stream.stderr.emit("data", Buffer.from(stderrData));
        stream.emit("exit", exitCode, null);
    });

    return stream;
}

// -------------------------------------------------------------------------
// prepareRestore()
// -------------------------------------------------------------------------

describe("SQLite prepareRestore()", () => {
    it("resolves without error (no-op)", async () => {
        await expect(prepareRestore(buildConfig(), [], fakeHost)).resolves.toBeUndefined();
    });
});

// -------------------------------------------------------------------------
// restore() - local mode
// -------------------------------------------------------------------------

describe("SQLite restore() - local mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFsStatPromise.mockResolvedValue({ size: 2048 });
        mockFsExistsSync.mockReturnValue(false);
    });

    function makeReadStream() {
        const stream = new PassThrough() as any;
        process.nextTick(() => stream.end());
        return stream;
    }

    it("returns success when sqlite3 exits with code 0", async () => {
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        const result = await restore(buildConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(true);
        expect(mockSpawnProcess).toHaveBeenCalledWith("sqlite3", ["/data/db.sqlite", ".restore /tmp/backup.sql"]);
    });

    it("creates safety backup and removes existing DB file before restore", async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsCopyFileSync.mockReturnValue(undefined);
        mockFsUnlinkSync.mockReturnValue(undefined);
        mockFsCreateReadStream.mockReturnValue(makeReadStream());
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        await restore(buildConfig({ path: "/data/db.sqlite" }), "/tmp/backup.sql", fakeHost);

        expect(mockFsCopyFileSync).toHaveBeenCalledWith(
            "/data/db.sqlite",
            expect.stringMatching(/\.bak-\d+$/),
        );
        expect(mockFsUnlinkSync).toHaveBeenCalledWith("/data/db.sqlite");
    });

    it("calls onProgress during restore", async () => {
        mockFsStatPromise.mockResolvedValue({ size: 1000 });
        const readStream = new PassThrough() as any;
        mockFsCreateReadStream.mockReturnValue(readStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        const progressValues: number[] = [];
        const restorePromise = restore(buildConfig(), "/tmp/backup.sql", fakeHost, undefined, (p) => progressValues.push(p));

        process.nextTick(() => {
            readStream.emit("data", Buffer.alloc(500));
            readStream.emit("data", Buffer.alloc(500));
            readStream.end();
        });

        await restorePromise;

        expect(progressValues.length).toBeGreaterThan(0);
        expect(progressValues[progressValues.length - 1]).toBe(100);
    });

    it("returns failure when sqlite3 exits with non-zero code", async () => {
        mockFsCreateReadStream.mockReturnValue(makeReadStream());
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(1));

        const result = await restore(buildConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("failed with code 1");
    });

    it("returns failure when spawn emits an error", async () => {
        mockFsCreateReadStream.mockReturnValue(makeReadStream());

        const proc = new PassThrough() as any;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        process.nextTick(() => proc.emit("error", new Error("spawn ENOENT")));
        mockSpawnProcess.mockReturnValue(proc);

        const result = await restore(buildConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("spawn ENOENT");
    });

    it("includes timestamps and logs in result", async () => {
        mockFsCreateReadStream.mockReturnValue(makeReadStream());
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        const result = await restore(buildConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.startedAt).toBeInstanceOf(Date);
        expect(result.completedAt).toBeInstanceOf(Date);
        expect(Array.isArray(result.logs)).toBe(true);
    });
});

// -------------------------------------------------------------------------
// restore() - invalid mode
// -------------------------------------------------------------------------

describe("SQLite restore() - invalid mode", () => {
    it("returns failure for unsupported mode", async () => {
        const config = buildConfig();
        (config as any).mode = "ftp";

        const result = await restore(config, "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid mode");
    });
});

// -------------------------------------------------------------------------
// restore() - ssh mode
// -------------------------------------------------------------------------

describe("SQLite restore() - ssh mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFsStatPromise.mockResolvedValue({ size: 1024 });
    });

    function buildSshConfig(overrides: Partial<SQLiteConfig> = {}): SQLiteConfig {
        return buildConfig({ mode: "ssh", host: "host.example", username: "user", ...overrides });
    }

    it("returns failure when SSH config is missing", async () => {
        mockExtractSqliteSshConfig.mockReturnValue(null);

        const result = await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("SSH host and username are required");
    });

    it("returns success on successful SSH restore", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "Backed up and removed old DB", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }) // size check
            .mockResolvedValue({ stdout: "", code: 0 }); // cleanup rm -f
        mockSshUploadFile.mockResolvedValue(undefined);

        const stream = makeSshStream(0);
        mockSshExecStream.mockImplementation((_cmd: string, cb: any) => cb(null, stream));

        const result = await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(true);
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("calls onProgress during SSH restore", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }) // size check
            .mockResolvedValue({ stdout: "", code: 0 }); // cleanup
        mockSshUploadFile.mockResolvedValue(undefined);

        const stream = makeSshStream(0);
        mockSshExecStream.mockImplementation((_cmd: string, cb: any) => cb(null, stream));

        const progressValues: number[] = [];
        await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost, undefined, (p) => progressValues.push(p));

        expect(progressValues).toContain(50);
        expect(progressValues).toContain(100);
    });

    it("throws when upload size mismatches", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockFsStatPromise.mockResolvedValue({ size: 2048 });
        mockSshExec
            .mockResolvedValueOnce({ stdout: "", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }); // wrong remote size
        mockSshUploadFile.mockResolvedValue(undefined);
        // cleanup
        mockSshExec.mockResolvedValue({ stdout: "", code: 0 });

        const result = await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("mismatch");
    });

    it("returns failure when SSH stream exits with non-zero code", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }) // size check
            .mockResolvedValueOnce({ stdout: "", stderr: "restore failed", code: 1 }) // restore cmd - fails
            .mockResolvedValue({ stdout: "", code: 0 }); // cleanup
        mockSshUploadFile.mockResolvedValue(undefined);

        const result = await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("code 1");
    });

    it("includes signal in error message when SSH stream exits with signal", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }) // size check
            .mockResolvedValueOnce({ stdout: "", stderr: "process killed: SIGTERM", code: 1 }) // restore cmd - fails
            .mockResolvedValue({ stdout: "", code: 0 }); // cleanup
        mockSshUploadFile.mockResolvedValue(undefined);

        const result = await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("SIGTERM");
    });

    it("cleans up temp file even when restore fails", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ stdout: "", code: 0 }) // backup cmd
            .mockResolvedValueOnce({ stdout: "1024", code: 0 }) // size check
            .mockResolvedValue({ stdout: "", code: 0 }); // cleanup
        mockSshUploadFile.mockResolvedValue(undefined);

        mockSshExecStream.mockImplementation((_cmd: string, cb: any) =>
            cb(new Error("exec failed"), null),
        );

        await restore(buildSshConfig(), "/tmp/backup.sql", fakeHost);

        // cleanup rm -f should still be called via finally block
        const rmCall = (mockSshExec.mock.calls as any[]).find(
            (c: any[]) => typeof c[0] === "string" && c[0].includes("rm -f"),
        );
        expect(rmCall).toBeDefined();
    });
});
