/**
 * A fixed-size pool of reusable connections, shared by everything running against one adapter.
 *
 * Protocols that authenticate per connection - SFTP and FTP - pay a full handshake before the
 * first byte moves: TCP, key exchange, authentication, subsystem start. Opening one per file
 * turns a 130-file backup into 130 handshakes, which is both slow and the fastest way to trip
 * an SSH server's connection-rate limits (OpenSSH's MaxStartups drops new connections, and
 * fail2ban reads a burst of them as an attack).
 *
 * Borrowers exceeding the limit wait for a connection to come back rather than opening another,
 * so the number of sockets is decided here and not by how many files happen to be in flight.
 */
export interface ConnectionPool<T> {
    /** Runs `fn` with a borrowed connection, returning it to the pool afterwards. */
    withConnection<R>(fn: (connection: T) => Promise<R>): Promise<R>;
    /** Closes every connection. Callers still waiting are rejected rather than left hanging. */
    close(): Promise<void>;
    /** How many connections are currently open - for logging and tests. */
    openCount(): number;
}

export interface ConnectionPoolOptions<T> {
    /** Maximum number of connections open at once. Values below 1 are treated as 1. */
    limit: number;
    connect: () => Promise<T>;
    disconnect: (connection: T) => Promise<void>;
    /**
     * Whether a connection is still usable. A dropped connection must never be handed to the
     * next borrower: pooling makes one dead socket everybody's problem, where an unpooled
     * transfer would only have failed for itself.
     */
    isAlive: (connection: T) => boolean;
}

export function createConnectionPool<T>({
    limit,
    connect,
    disconnect,
    isAlive,
}: ConnectionPoolOptions<T>): ConnectionPool<T> {
    const max = Math.max(1, Math.floor(limit) || 1);
    const idle: T[] = [];
    const waiting: (() => void)[] = [];
    const live = new Set<T>();
    // Counted separately from `live`: a connection being established already occupies a slot,
    // otherwise a burst of borrowers would all pass the cap check while the first one connects.
    let opening = 0;
    let closed = false;

    const dispose = (connection: T) => {
        live.delete(connection);
        void disconnect(connection).catch(() => { });
    };

    /** Lets one waiting borrower retry - either a connection came back or a slot opened up. */
    const wake = () => waiting.shift()?.();

    async function acquire(): Promise<T> {
        for (; ;) {
            if (closed) throw new Error("The connection pool has been closed.");

            const candidate = idle.pop();
            if (candidate) {
                if (isAlive(candidate)) return candidate;
                dispose(candidate);
                continue;
            }

            if (live.size + opening < max) {
                opening++;
                try {
                    const created = await connect();
                    live.add(created);
                    return created;
                } finally {
                    opening--;
                    // Failing to connect frees the slot again, so a waiter can try in our place
                    // instead of waiting for a release that will never come.
                    if (!closed) wake();
                }
            }

            // At the limit with nothing free. Waiters re-run this loop when woken rather than
            // being handed a specific connection, so whatever is available then - a returned
            // connection or a freed slot - is used, and a connection that died in the meantime
            // does not strand the borrower that was promised it.
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
    }

    function release(connection: T): void {
        // Dropped here rather than left for the next borrower to discover, so the slot frees up
        // straight away. This is not what guarantees a dead connection is never reused - a
        // connection can also die while parked, which only the check in acquire() can catch.
        // After close() there is nothing to do: it has already disconnected everything.
        if (!closed) {
            if (isAlive(connection)) idle.push(connection);
            else dispose(connection);
        }
        wake();
    }

    return {
        async withConnection<R>(fn: (connection: T) => Promise<R>): Promise<R> {
            const connection = await acquire();
            try {
                return await fn(connection);
            } finally {
                release(connection);
            }
        },

        async close(): Promise<void> {
            closed = true;
            // Wake everyone before disconnecting: a waiter left in the queue would hang for the
            // lifetime of the process, since no release is coming.
            while (waiting.length) waiting.shift()!();
            const all = [...live];
            live.clear();
            idle.length = 0;
            await Promise.all(all.map((c) => disconnect(c).catch(() => { })));
        },

        openCount: () => live.size,
    };
}
