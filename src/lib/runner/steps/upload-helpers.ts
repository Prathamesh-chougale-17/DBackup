import type { AdapterConfig, StorageAdapter, StorageSession } from "@/lib/core/interfaces";
import type { LogLevel, LogType } from "@/lib/core/logs";
import { untilAborted } from "@/lib/concurrency";

type LogFn = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;

/**
 * Opens a persistent upload session for the given adapter if supported,
 * otherwise returns a shim that delegates each upload to the stateless
 * `adapter.upload()` method. The session is always closed after `fn` returns
 * or throws.
 *
 * Per-upload progress and log callbacks are passed through unchanged, so
 * live progress reporting (bytes, speed) works identically whether a real
 * session or the shim is used.
 */
export async function withStorageSession<T>(
    adapter: StorageAdapter,
    config: AdapterConfig,
    onLog: LogFn | undefined,
    fn: (session: StorageSession) => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const session = adapter.openSession
        ? await adapter.openSession(config, onLog)
        : createStatelessSessionShim(adapter, config);

    // An upload in flight takes no signal of its own, so cancelling drops the connection
    // underneath it. Uploading one large archive is a single call that can run for minutes,
    // which without this ignores a cancel for its entire duration - the same way collecting a
    // few large files used to.
    const abortUpload = () => { void session.close().catch(() => { }); };
    signal?.addEventListener("abort", abortUpload, { once: true });

    try {
        // Dropping the connection is what stops the transfer; this is what stops *waiting* for
        // it. An upload torn down mid-flight does not reliably reject - see untilAborted.
        return await untilAborted(fn(session), signal);
    } finally {
        signal?.removeEventListener("abort", abortUpload);
        await session.close().catch(() => { });
    }
}

function createStatelessSessionShim(adapter: StorageAdapter, config: AdapterConfig): StorageSession {
    return {
        upload: (localPath, remotePath, onProgress, onLog, options) =>
            adapter.upload(config, localPath, remotePath, onProgress, onLog, options),
        close: async () => { },
    };
}
