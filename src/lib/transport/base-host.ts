import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Duplex, Writable } from "node:stream";

import type {
    ExecOptions,
    ExecResult,
    ExecutionHost,
    HostKind,
    HostProcess,
    HostStat,
    PortForward,
    SpawnOptions,
    StageInputOptions,
    TempFileOptions,
    TransferOptions,
} from "./types";

/** Buffer ceiling per stream for exec(). Exceeding it fails rather than truncating. */
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** Event-loop turns exec() waits for output still queued when a command exits. */
const DRAIN_GRACE_TURNS = 3;

/** Yield n turns of the event loop. Costs no wall-clock time, unlike a timer. */
function yieldTurns(turns: number): Promise<void> {
    return new Promise((resolve) => {
        let left = turns;
        const step = () => (left-- <= 0 ? resolve() : setImmediate(step));
        step();
    });
}

/**
 * Shared behaviour for every transport.
 *
 * Concrete hosts only implement the primitives that genuinely differ between
 * running a process locally and running it over SSH. Everything expressible in
 * terms of those primitives lives here, so the two transports cannot drift.
 */
export abstract class BaseHost implements ExecutionHost {
    abstract readonly kind: HostKind;
    abstract readonly label: string;
    abstract readonly tmpDir: string;

    abstract spawn(argv: string[], options?: SpawnOptions): Promise<HostProcess>;
    abstract which(...candidates: string[]): Promise<string>;
    abstract putFile(localPath: string, hostPath: string, options?: TransferOptions): Promise<void>;
    abstract getFile(hostPath: string, localPath: string, options?: TransferOptions): Promise<void>;
    abstract removeFile(hostPath: string): Promise<void>;
    abstract stat(hostPath: string): Promise<HostStat | null>;
    abstract connect(remoteHost: string, remotePort: number): Promise<Duplex>;
    abstract connectSocket(socketPath: string): Promise<Duplex>;
    abstract forwardPort(remoteHost: string, remotePort: number): Promise<PortForward>;
    abstract dispose(): Promise<void>;

    /** Write bytes to a path on this host, applying `mode` if given. */
    protected abstract writeHostFile(
        hostPath: string,
        content: string | Buffer,
        mode?: number,
    ): Promise<void>;

    /** Open a writable stream to a path on this host, used by the transform path of stageInput. */
    protected abstract openHostWriteStream(hostPath: string): Promise<Writable>;

    /** Unique path inside this host's temp directory. */
    protected hostTempPath(suffix = ""): string {
        const sep = this.tmpDir.endsWith("/") ? "" : "/";
        return `${this.tmpDir}${sep}dbackup_${randomUUID()}${suffix}`;
    }

    /**
     * Run to completion and buffer both streams.
     *
     * A non-zero exit is returned, never thrown: callers such as pg_restore treat
     * some non-zero codes as success, so the judgement stays with them.
     */
    async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
        if (options.stdin !== undefined && options.stdinFile !== undefined) {
            throw new Error("exec() accepts either `stdin` or `stdinFile`, not both.");
        }

        const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
        const proc = await this.spawn(argv, {
            env: options.env,
            cwd: options.cwd,
            stdinFile: options.stdinFile,
            stdin: options.stdin !== undefined,
        });

        let overflow: Error | null = null;
        const collect = (stream: NodeJS.ReadableStream, label: string) => {
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer | string) => {
                if (overflow) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buf.length;
                if (size > maxBuffer) {
                    overflow = new Error(
                        `Command output exceeded the ${maxBuffer} byte limit on ${label}: ${argv[0]}`,
                    );
                    proc.kill();
                    return;
                }
                chunks.push(buf);
            });

            // Process exit and stream exhaustion are separate events. An SSH
            // channel can report the command as finished while data already in
            // flight is delivered on later ticks, and `close` was observed
            // arriving before `end` - so reading the chunks at exit time can
            // miss the tail, or all of it. That would silently truncate a
            // database listing into a backup that skips databases.
            //
            // `end` means every byte was delivered, so it wins. `close` is
            // accepted too, but only after one turn of the event loop, which
            // lets data already sitting in the stream's buffer be emitted
            // first.
            const drained = new Promise<void>((resolve) => {
                stream.once("end", () => resolve());
                stream.once("error", () => resolve());
                stream.once("close", () => setImmediate(resolve));
            });

            return { chunks, drained };
        };

        const stdout = collect(proc.stdout, "stdout");
        const stderr = collect(proc.stderr, "stderr");

        if (options.stdin !== undefined && proc.stdin) {
            proc.stdin.end(options.stdin);
        }

        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, options.timeoutMs);
        }

        try {
            const { code, signal } = await proc.exit();
            // Bounded on purpose. A stream that reports nothing at all must
            // not be able to deadlock a command that already finished, and a
            // channel's stderr does exactly that when the command wrote
            // nothing to it. Yielding a few turns costs no wall-clock time and
            // is enough to flush what the exit left queued.
            await Promise.race([
                Promise.all([stdout.drained, stderr.drained]),
                yieldTurns(DRAIN_GRACE_TURNS),
            ]);
            if (overflow) throw overflow;
            if (timedOut) {
                throw new Error(`Command timed out after ${options.timeoutMs} ms: ${argv[0]}`);
            }
            return {
                stdout: Buffer.concat(stdout.chunks).toString("utf8"),
                stderr: Buffer.concat(stderr.chunks).toString("utf8"),
                code,
                signal,
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Create a temp file on this host, run the callback, delete it afterwards.
     *
     * Replaces the withLocalMyCnf / withRemoteMyCnf pair: one contract, and the
     * cleanup runs even when the callback throws.
     */
    async withTempFile<T>(options: TempFileOptions, fn: (path: string) => Promise<T>): Promise<T> {
        const hostPath = this.hostTempPath(options.suffix ?? "");
        await this.writeHostFile(hostPath, options.content ?? "", options.mode);
        try {
            return await fn(hostPath);
        } finally {
            await this.removeFile(hostPath).catch(() => {});
        }
    }

    /**
     * Make a local file readable by a command on this host.
     *
     * The base implementation copies the bytes over and cleans up. DirectHost
     * short-circuits this when no transform is requested, because the file is
     * already where the command will look for it.
     */
    async stageInput<T>(
        localPath: string,
        options: StageInputOptions,
        fn: (hostPath: string) => Promise<T>,
    ): Promise<T> {
        const hostPath = this.hostTempPath();
        const verifySize = options.verifySize ?? true;

        let expectedBytes: number | null = null;
        if (options.transform) {
            expectedBytes = await this.streamToHost(localPath, hostPath, options);
        } else {
            await this.putFile(localPath, hostPath, options);
        }

        try {
            if (verifySize) {
                await this.verifyStagedSize(localPath, hostPath, expectedBytes);
            }
            return await fn(hostPath);
        } finally {
            await this.removeFile(hostPath).catch(() => {});
        }
    }

    /**
     * Give a command a path to write on this host, then bring the bytes back to
     * `localPath`. Cleans up the host-side file even when the callback throws.
     */
    async captureOutput<T>(
        localPath: string,
        options: TransferOptions,
        fn: (hostPath: string) => Promise<T>,
    ): Promise<T> {
        const hostPath = this.hostTempPath();
        try {
            const result = await fn(hostPath);
            await this.getFile(hostPath, localPath, options);
            return result;
        } finally {
            await this.removeFile(hostPath).catch(() => {});
        }
    }

    /**
     * Copy a local file to this host through an optional transform, returning the
     * number of bytes actually written so the size check compares like with like.
     */
    protected async streamToHost(
        localPath: string,
        hostPath: string,
        options: StageInputOptions,
    ): Promise<number> {
        let written = 0;
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
            written += chunk.length;
            options.onProgress?.(written, 0);
        });

        const target = await this.openHostWriteStream(hostPath);
        const stages = options.transform
            ? [createReadStream(localPath), options.transform(), counter, target]
            : [createReadStream(localPath), counter, target];

        await pipeline(stages as never);
        return written;
    }

    /**
     * Compare what landed on the host against what was sent.
     *
     * `expectedBytes` is the post-transform count when a transform ran, because
     * comparing against the original file size would be wrong by construction.
     */
    protected async verifyStagedSize(
        localPath: string,
        hostPath: string,
        expectedBytes: number | null,
    ): Promise<void> {
        let expected = expectedBytes;
        if (expected === null) {
            expected = (await fsStat(localPath)).size;
        }

        const staged = await this.stat(hostPath);
        if (!staged) {
            throw new Error(`Staged file disappeared before use: ${hostPath} on ${this.label}`);
        }
        if (staged.size !== expected) {
            throw new Error(
                `Staged file size mismatch on ${this.label}: expected ${expected} bytes, found ${staged.size}.`,
            );
        }
    }
}
