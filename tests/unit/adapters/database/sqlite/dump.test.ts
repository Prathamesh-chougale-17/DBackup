import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SQLiteConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockSpawnProcess,
    mockFsCreateWriteStream,
    mockSshConnect,
    mockSshExec,
    mockSshExecStream,
    mockSshEnd,
    mockExtractSqliteSshConfig,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as { PassThrough: typeof import("stream").PassThrough };
    return {
        mockSpawnProcess: vi.fn(),
        mockFsCreateWriteStream: vi.fn(),
        mockSshConnect: vi.fn(),
        mockSshExec: vi.fn(),
        mockSshExecStream: vi.fn(),
        mockSshEnd: vi.fn(),
        mockExtractSqliteSshConfig: vi.fn(),
        PassThrough,
    };
});

vi.mock("child_process", () => ({
    spawn: (...args: any[]) => mockSpawnProcess(...args),
    default: { spawn: (...args: any[]) => mockSpawnProcess(...args) },
}));

vi.mock("fs", () => {
    const createWriteStream = (...args: any[]) => mockFsCreateWriteStream(...args);
    return {
        default: { createWriteStream, stat: vi.fn((p: string, cb: any) => cb(null, { size: 1024 })) },
        createWriteStream,
        stat: vi.fn((p: string, cb: any) => cb(null, { size: 1024 })),
    };
});

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = (...args: any[]) => mockSshConnect(...args);
        exec = (...args: any[]) => mockSshExec(...args);
        execStream = (...args: any[]) => mockSshExecStream(...args);
        end = () => mockSshEnd();
    },
    shellEscape: vi.fn((s: string) => s),
    extractSqliteSshConfig: (...args: any[]) => mockExtractSqliteSshConfig(...args),
}));

import { dump } from "@/lib/adapters/database/sqlite/dump";

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

/** Creates a mock spawn child process that emits close with the given code. */
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

/** Creates a mock SSH stream that emits exit with the given code. */
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
// dump() - local mode
// -------------------------------------------------------------------------

describe("SQLite dump() - local mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns success when sqlite3 exits with code 0", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        const result = await dump(buildConfig(), "/tmp/out.sql", fakeHost, undefined, undefined);

        expect(result.success).toBe(true);
        expect(mockSpawnProcess).toHaveBeenCalledWith(
            "sqlite3",
            ["/data/db.sqlite", ".backup /tmp/out.sql"],
        );
    });

    it("uses default sqlite3 binary when not specified", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        await dump(buildConfig({ sqliteBinaryPath: undefined }), "/tmp/out.sql", fakeHost);

        expect(mockSpawnProcess).toHaveBeenCalledWith("sqlite3", expect.any(Array));
    });

    it("returns failure when sqlite3 exits with non-zero code", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(1));

        const result = await dump(buildConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("failed with code 1");
    });

    it("returns failure when spawn emits an error", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);

        const proc = new PassThrough() as any;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        process.nextTick(() => proc.emit("error", new Error("spawn ENOENT")));
        mockSpawnProcess.mockReturnValue(proc);

        const result = await dump(buildConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("spawn ENOENT");
    });

    it("logs stderr output as warnings", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0, "some warning"));

        const logs: string[] = [];
        await dump(buildConfig(), "/tmp/out.sql", fakeHost, (msg) => logs.push(msg));

        expect(logs.some((l) => l.includes("Starting SQLite dump"))).toBe(true);
    });

    it("includes timestamps in result", async () => {
        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);
        mockSpawnProcess.mockReturnValue(makeSpawnProcess(0));

        const result = await dump(buildConfig(), "/tmp/out.sql", fakeHost);

        expect(result.startedAt).toBeInstanceOf(Date);
        expect(result.completedAt).toBeInstanceOf(Date);
    });
});

// -------------------------------------------------------------------------
// dump() - invalid mode
// -------------------------------------------------------------------------

describe("SQLite dump() - invalid mode", () => {
    it("returns failure for unsupported mode", async () => {
        const config = buildConfig();
        (config as any).mode = "ftp";

        const result = await dump(config, "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid mode");
    });
});

// -------------------------------------------------------------------------
// dump() - ssh mode
// -------------------------------------------------------------------------

describe("SQLite dump() - ssh mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function buildSshConfig(overrides: Partial<SQLiteConfig> = {}): SQLiteConfig {
        return buildConfig({ mode: "ssh", host: "host.example", username: "user", ...overrides });
    }

    it("returns failure when SSH config is missing", async () => {
        mockExtractSqliteSshConfig.mockReturnValue(null);

        const result = await dump(buildSshConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("SSH host and username are required");
    });

    it("returns success on successful SSH dump", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // remote backup
            .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // cleanup rm -f

        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);

        const stream = makeSshStream(0);
        mockSshExecStream.mockImplementation((_cmd: string, cb: any) => cb(null, stream));

        const result = await dump(buildSshConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(true);
        expect(mockSshEnd).toHaveBeenCalled();
    });

    it("returns failure when SSH stream exits with non-zero code", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // remote backup
            .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // cleanup rm -f

        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);

        const stream = makeSshStream(1);
        mockSshExecStream.mockImplementation((_cmd: string, cb: any) => cb(null, stream));

        const result = await dump(buildSshConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("code 1");
    });

    it("returns failure when SSH execStream returns an error", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // remote backup
            .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // cleanup rm -f

        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);

        mockSshExecStream.mockImplementation((_cmd: string, cb: any) =>
            cb(new Error("channel open failed"), null),
        );

        const result = await dump(buildSshConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("channel open failed");
    });

    it("includes signal in error message when SSH stream exits with signal", async () => {
        mockExtractSqliteSshConfig.mockReturnValue({ host: "host.example", username: "user" });
        mockSshConnect.mockResolvedValue(undefined);
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // remote backup
            .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // cleanup rm -f

        const writeStream = new PassThrough() as any;
        mockFsCreateWriteStream.mockReturnValue(writeStream);

        const stream = new PassThrough() as any;
        stream.stderr = new PassThrough();
        process.nextTick(() => stream.emit("exit", 1, "SIGKILL"));
        mockSshExecStream.mockImplementation((_cmd: string, cb: any) => cb(null, stream));

        const result = await dump(buildSshConfig(), "/tmp/out.sql", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("SIGKILL");
    });
});
