/**
 * Runs an async function over a list with a bounded number of calls in flight.
 *
 * Used to parallelise per-file work in the backup and restore paths, where processing one
 * file at a time is dominated by network round-trip latency. Results keep the input order
 * regardless of completion order, so callers that build an index or a manifest from the
 * results get a stable layout.
 *
 * A `limit` of 1 or less runs strictly sequentially - callers that must stay ordered (the
 * tar download stream) can pass 1 and take this path without a separate code branch. The
 * first item to reject aborts the whole call and no further items are started; callers that
 * want per-item failure handling (backup collection, storage restore) should catch inside
 * `fn` and return a result rather than throw.
 */
/**
 * A gate that lets at most `limit` calls run at once, shared across several loops.
 *
 * `mapWithConcurrency` bounds one list; this bounds work that arrives from more than one place
 * at the same time. The restore path needs that: entries are visited in parallel, and a bundle
 * entry then yields many small files which should also go out in parallel without the two
 * levels multiplying into an unbounded number of concurrent uploads.
 *
 * Callers must not acquire a second slot while holding one - the queue is FIFO and would
 * deadlock. Every use here releases before requesting again.
 */
export function createConcurrencyGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
    const max = Math.max(1, Math.floor(limit) || 1);
    let active = 0;
    const waiting: (() => void)[] = [];

    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
        active++;
        try {
            return await fn();
        } finally {
            active--;
            waiting.shift()?.();
        }
    };
}

/**
 * Settles as soon as the signal does, whatever the wrapped promise goes on to do.
 *
 * Cancelling a transfer cannot depend on that transfer reporting its own failure, because a
 * torn-down one does not always report anything. SFTP is the case that proved it: dropping the
 * connection under a running `fastGet` leaves its promise pending forever, because
 * ssh2-sftp-client suppresses the close event that would reject it once `end()` has been
 * called, and ssh2's own error path then waits on a CLOSE reply the dead connection will never
 * send. The transfer stopped, and the run went on waiting for it.
 *
 * The wait is therefore bounded here, above the adapter, where it holds for every adapter and
 * depends on none of their internals. An abandoned transfer keeps what it holds - a local file
 * descriptor, in practice - until the process collects it. That is the right trade against a
 * run that hangs until someone restarts the container.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });

        // Detached before settling, not after. The signal outlives every individual transfer,
        // so a listener released a microtask late is one still attached when the caller is
        // already looking at the result.
        const release = () => signal.removeEventListener("abort", onAbort);
        promise.then(
            (value) => { release(); resolve(value); },
            (error) => { release(); reject(error); }
        );
    });
}

export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    if (items.length === 0) return results;

    const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
        // Each worker pulls the next index until the list is exhausted. A shared cursor is
        // safe here because Node runs this single-threaded and the increment never spans an
        // await.
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await fn(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: workers }, runWorker));
    return results;
}
