import type { StorageAdapter, StorageSession, AdapterConfig } from "@/lib/core/interfaces";
import type { LogLevel, LogType } from "@/lib/core/logs";

type OnLog = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;

export interface RestoreDestination {
    adapter: StorageAdapter;
    config: AdapterConfig;
}

/**
 * Keeps one pooled connection set per destination for the length of a restore.
 *
 * Restoring writes files one at a time through `StorageAdapter.upload()`, which opens and closes
 * a connection per call. On SFTP and FTP that means a full handshake - TCP, key exchange,
 * authentication, subsystem start - before each file, so a 130-file restore paid 130 of them,
 * and running 10 files at once meant 10 simultaneous logins repeated 13 times over. Servers
 * notice: OpenSSH's MaxStartups begins dropping connections, and fail2ban reads the pattern as
 * an attack.
 *
 * A session pools at most `concurrency` connections and reuses them, so the login count follows
 * the configured parallelism instead of the file count.
 */
export interface DestinationSessions {
    upload(
        destination: RestoreDestination,
        localPath: string,
        remotePath: string,
        onLog?: OnLog
    ): Promise<boolean>;
    close(): Promise<void>;
}

export function createDestinationSessions(concurrency: number, onLog?: OnLog): DestinationSessions {
    // Opened lazily and shared: two directory sources restoring to the same server belong on the
    // same connections, while two different servers rightly get their own. Because a session only
    // connects when a transfer asks for one, a destination that never sees more than three files
    // at once never opens more than three connections either.
    const sessions = new Map<string, Promise<StorageSession | undefined>>();

    const keyOf = (d: RestoreDestination) => `${d.adapter.id}:${JSON.stringify(d.config)}`;

    async function sessionFor(destination: RestoreDestination): Promise<StorageSession | undefined> {
        if (!destination.adapter.openSession) return undefined;
        const key = keyOf(destination);
        let pending = sessions.get(key);
        if (!pending) {
            // Stored before awaiting, so concurrent transfers to the same destination share one
            // session rather than each opening a pool of their own.
            pending = destination.adapter
                .openSession(destination.config, onLog, { concurrency })
                // A destination that cannot hold a session still restores - it just pays a
                // connection per file, exactly as it did before.
                .catch(() => undefined);
            sessions.set(key, pending);
        }
        return pending;
    }

    return {
        async upload(destination, localPath, remotePath, fileLog) {
            const session = await sessionFor(destination);
            return session
                ? session.upload(localPath, remotePath, undefined, fileLog)
                : destination.adapter.upload(destination.config, localPath, remotePath, undefined, fileLog);
        },

        async close() {
            await Promise.all([...sessions.values()].map(async (pending) => {
                const session = await pending.catch(() => undefined);
                await session?.close().catch(() => { });
            }));
            sessions.clear();
        },
    };
}
