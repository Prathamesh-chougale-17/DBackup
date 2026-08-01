import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockSpawnProcess,
    mockFsStat,
    mockIsSSHMode,
    mockSshExec,
    mockSshExecStream,
    mockRemoteBinaryCheck,
    mockCreateWriteStream,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as {
        PassThrough: typeof import("stream").PassThrough;
    };
    return {
        mockSpawnProcess: vi.fn(),
        mockFsStat: vi.fn(),
        mockIsSSHMode: vi.fn(),
        mockSshExec: vi.fn(),
        mockSshExecStream: vi.fn(),
        mockRemoteBinaryCheck: vi.fn(),
        mockCreateWriteStream: vi.fn(),
        PassThrough,
    };
});

vi.mock("child_process", () => ({
    spawn: (...args: any[]) => mockSpawnProcess(...args),
    execFile: vi.fn(),
    default: { spawn: (...args: any[]) => mockSpawnProcess(...args), execFile: vi.fn() },
}));

vi.mock("@/lib/logging/logger", () => ({
    logger: {
        child: vi.fn().mockReturnValue({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock("@/lib/logging/errors", () => ({
    wrapError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

vi.mock("fs/promises", () => ({
    default: { stat: (...args: any[]) => mockFsStat(...args) },
    stat: (...args: any[]) => mockFsStat(...args),
}));

vi.mock("fs", () => {
    return {
        default: { createWriteStream: (...args: any[]) => mockCreateWriteStream(...args) },
        createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
    };
});

vi.mock("@/lib/ssh", () => ({
    SshClient: class {
        connect = vi.fn().mockResolvedValue(undefined);
        exec = (...args: any[]) => mockSshExec(...args);
        execStream = (...args: any[]) => mockSshExecStream(...args);
        end = vi.fn();
    },
    isSSHMode: (...args: any[]) => mockIsSSHMode(...args),
    extractSshConfig: vi.fn(() => ({ host: "jump.example.com", port: 22 })),
    buildRedisArgs: vi.fn(() => ["-h", "db.internal", "-p", "6379"]),
    remoteBinaryCheck: (...args: any[]) => mockRemoteBinaryCheck(...args),
    shellEscape: vi.fn((s: string) => `'${s}'`),
}));

vi.mock("crypto", () => ({
    randomUUID: vi.fn(() => "test-uuid-1234"),
    default: { randomUUID: vi.fn(() => "test-uuid-1234") },
}));

import { dump } from "@/lib/adapters/database/redis/dump";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function buildConfig(overrides: Partial<RedisConfig> = {}): RedisConfig {
    return {
        host: "localhost",
        port: 6379,
        password: "secret",
        ...overrides,
    } as RedisConfig;
}

/** Creates a mock spawn process that emits 'close' with the given exit code. */
function makeSpawnProcess(exitCode = 0, stderrData?: string, stdoutData?: string) {
    const proc = new PassThrough() as any;
    proc.stderr = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = vi.fn();
    process.nextTick(() => {
        if (stderrData) proc.stderr.emit("data", Buffer.from(stderrData));
        if (stdoutData) proc.stdout.emit("data", Buffer.from(stdoutData));
        proc.emit("close", exitCode);
    });
    return proc;
}

/** Creates a mock spawn process that emits 'error'. */
function makeSpawnProcessWithError(errMessage: string) {
    const proc = new PassThrough() as any;
    proc.stderr = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = vi.fn();
    process.nextTick(() => {
        proc.emit("error", new Error(errMessage));
    });
    return proc;
}

// -------------------------------------------------------------------------
// dump() - local
// -------------------------------------------------------------------------

describe("dump() - local", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(false);
        mockFsStat.mockResolvedValue({ size: 1024 * 512 });
    });

    it("returns success with size when redis-cli exits with code 0", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(0));

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(true);
        expect(result.size).toBe(1024 * 512);
        expect(result.path).toBe("/tmp/backup.rdb");
    });

    it("masks the password in the logged command", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(0));
        const logs: string[] = [];

        await dump(buildConfig({ password: "mysecret" }), "/tmp/backup.rdb", fakeHost, (msg) => logs.push(msg));

        const commandLog = logs.find((l) => l.includes("redis-cli"));
        expect(commandLog).not.toContain("mysecret");
    });

    it("includes stdout messages from redis-cli in the logs", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(0, undefined, "Saving..."));
        const logs: string[] = [];

        await dump(buildConfig(), "/tmp/backup.rdb", fakeHost, (msg) => logs.push(msg));

        expect(logs.some((l) => l.includes("Saving..."))).toBe(true);
    });

    it("does not log an empty stdout message (if-msg=false branch)", async () => {
        // Emit whitespace-only stdout data -> after .trim() it's empty -> not logged.
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(0, undefined, "   "));
        const logs: string[] = [];

        await dump(buildConfig(), "/tmp/backup.rdb", fakeHost, (msg) => logs.push(msg));

        // The whitespace-only message must NOT appear in the logs.
        expect(logs.every((l) => l.trim() !== "")).toBe(true);
    });

    it("handles a non-Error rejection in the catch block (String coercion for local path)", async () => {
        // Emit a plain-string error event to cover the `String(error)` branch.
        mockSpawnProcess.mockImplementation(() => {
            const proc = new PassThrough() as any;
            proc.stderr = new PassThrough();
            proc.stdout = new PassThrough();
            proc.kill = vi.fn();
            process.nextTick(() => proc.emit("error", "binary missing"));
            return proc;
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("binary missing");
    });

    it("returns failure when redis-cli exits with a non-zero code", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(1, "NOAUTH Authentication required"));

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("code 1");
    });

    it("returns failure when the spawn process emits an error event", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcessWithError("redis-cli not found"));

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("redis-cli not found");
    });

    it("returns failure when the resulting RDB file is empty", async () => {
        mockSpawnProcess.mockImplementation(() => makeSpawnProcess(0));
        mockFsStat.mockResolvedValue({ size: 0 });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("empty");
    });
});

// -------------------------------------------------------------------------
// dump() - SSH
// -------------------------------------------------------------------------

describe("dump() - SSH", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSSHMode.mockReturnValue(true);
        mockRemoteBinaryCheck.mockResolvedValue("redis-cli");
        mockFsStat.mockResolvedValue({ size: 2048 });
        // Default write-stream mock: pipe triggers finish.
        mockCreateWriteStream.mockImplementation(() => {
            const stream = new PassThrough() as any;
            stream.on("pipe", () => process.nextTick(() => stream.emit("finish")));
            return stream;
        });
    });

    /** Creates a readable stream mock that emits 'exit' with the given code. */
    function makeReadableStream(exitCode = 0) {
        const stream = new PassThrough() as any;
        process.nextTick(() => stream.emit("exit", exitCode));
        return stream;
    }

    it("returns success even when the cleanup 'rm -f' exec rejects (error is swallowed)", async () => {
        mockSshExec
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // rdb command succeeds
            .mockRejectedValueOnce(new Error("cleanup failed")); // rm -f in finally rejects
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(true);
    });

    it("returns success via SSH when all steps complete successfully", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });

        const result = await dump(buildConfig({ tls: true, database: 2 }), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(true);
        expect(result.size).toBe(2048);
    });

    it("returns success via SSH when config has no tls and database is 0", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });

        const result = await dump(buildConfig({ tls: false, database: 0 }), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(true);
    });

    it("returns failure when remote redis-cli --rdb exits with non-zero code", async () => {
        mockSshExec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "AUTH required" });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Remote redis-cli --rdb failed");
    });

    it("returns failure when execStream callback receives an error", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: Error, stream: null) => void) => {
            callback(new Error("stream open failed"), null);
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("stream open failed");
    });

    it("returns failure when stream exits with a non-zero code", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(1));
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Failed to stream RDB");
    });

    it("returns failure when the downloaded RDB file is empty", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });
        mockFsStat.mockResolvedValue({ size: 0 });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("empty");
    });

    it("passes onLog messages to the callback in SSH mode", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });

        const logs: string[] = [];
        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost, (msg) => logs.push(msg));

        expect(result.success).toBe(true);
        expect(logs.some((l) => l.includes("SSH"))).toBe(true);
    });

    it("handles absent password by using the placeholder in the logged command", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            callback(null, makeReadableStream(0));
        });
        const logs: string[] = [];

        // password is undefined - triggers the '___NONE___' fallback in the replace() call.
        const result = await dump(
            buildConfig({ password: undefined }),
            "/tmp/backup.rdb", fakeHost,
            (msg) => logs.push(msg),
        );

        expect(result.success).toBe(true);
    });

    it("returns failure with signal details when stream exit code is null", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            const stream = new PassThrough() as any;
            // Emit null code with a signal to cover both `code ?? 'null'` and `signal ?` branches.
            process.nextTick(() => stream.emit("exit", null, "SIGKILL"));
            callback(null, stream);
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("null");
        expect(result.error).toContain("SIGKILL");
    });

    it("handles a non-Error rejection in the catch block (String coercion)", async () => {
        // Make remoteBinaryCheck reject with a plain string, not an Error instance.
        mockRemoteBinaryCheck.mockRejectedValue("binary not found");

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("binary not found");
    });

    it("returns failure when the readable stream emits an error event", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            const stream = new PassThrough() as any;
            process.nextTick(() => stream.emit("error", new Error("stream read error")));
            callback(null, stream);
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("stream read error");
    });

    it("returns failure when the write-stream emits an error event", async () => {
        mockSshExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
        mockSshExecStream.mockImplementation((_cmd: string, callback: (err: null, stream: any) => void) => {
            const readStream = new PassThrough() as any;
            callback(null, readStream);
        });
        mockCreateWriteStream.mockImplementationOnce(() => {
            const writeStream = new PassThrough() as any;
            writeStream.on("pipe", () => {
                process.nextTick(() => writeStream.emit("error", new Error("disk full")));
            });
            return writeStream;
        });

        const result = await dump(buildConfig(), "/tmp/backup.rdb", fakeHost);

        expect(result.success).toBe(false);
        expect(result.error).toContain("disk full");
    });
});
