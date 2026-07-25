import { describe, it, expect, vi } from "vitest";
import { createConnectionPool } from "@/lib/adapters/storage/common/connection-pool";

interface FakeConnection {
    id: number;
    alive: boolean;
}

function makePool(limit: number, connectDelayMs = 0) {
    let nextId = 0;
    const connect = vi.fn(async (): Promise<FakeConnection> => {
        if (connectDelayMs) await new Promise((r) => setTimeout(r, connectDelayMs));
        return { id: nextId++, alive: true };
    });
    const disconnect = vi.fn(async (c: FakeConnection) => { c.alive = false; });
    const pool = createConnectionPool<FakeConnection>({
        limit,
        connect,
        disconnect,
        isAlive: (c) => c.alive,
    });
    return { pool, connect, disconnect };
}

describe("createConnectionPool", () => {
    it("opens one connection and reuses it for sequential work", async () => {
        const { pool, connect } = makePool(4);

        for (let i = 0; i < 5; i++) await pool.withConnection(async () => undefined);

        expect(connect).toHaveBeenCalledTimes(1);
    });

    it("never opens more connections than the limit", async () => {
        // The whole point: 130 files through a pool of 4 must be 4 handshakes, not 130.
        const { pool, connect } = makePool(4);
        let inFlight = 0;
        let peak = 0;

        await Promise.all(Array.from({ length: 20 }, () => pool.withConnection(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
        })));

        expect(connect).toHaveBeenCalledTimes(4);
        expect(peak).toBe(4);
    });

    it("counts a connection being established against the limit", async () => {
        // Without that, a burst of borrowers all pass the cap check while the first one is still
        // connecting, and the pool quietly opens as many sockets as there are callers.
        const { pool, connect } = makePool(2, 10);

        await Promise.all(Array.from({ length: 8 }, () => pool.withConnection(async () => undefined)));

        expect(connect).toHaveBeenCalledTimes(2);
    });

    it("hands out each connection to only one borrower at a time", async () => {
        const { pool } = makePool(2);
        const held = new Set<number>();
        let overlapped = false;

        await Promise.all(Array.from({ length: 10 }, () => pool.withConnection(async (c) => {
            if (held.has(c.id)) overlapped = true;
            held.add(c.id);
            await new Promise((r) => setTimeout(r, 2));
            held.delete(c.id);
        })));

        expect(overlapped).toBe(false);
    });

    it("replaces a connection that died instead of handing it on", async () => {
        // Pooling makes one dead socket everybody's problem - an unpooled transfer would only
        // have failed for itself.
        const { pool, connect, disconnect } = makePool(1);

        await pool.withConnection(async (c) => { c.alive = false; });
        const second = await pool.withConnection(async (c) => c);

        expect(second.alive).toBe(true);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it("does not hand out a connection that died while sitting idle", async () => {
        // Servers close connections that idle too long. Nothing tells the pool at release time
        // about something that happens afterwards, so the check has to be on the way out too.
        const { pool, connect } = makePool(1);

        const first = await pool.withConnection(async (c) => c);
        first.alive = false;
        const second = await pool.withConnection(async (c) => c);

        expect(second).not.toBe(first);
        expect(connect).toHaveBeenCalledTimes(2);
    });

    it("disposes a dead connection as soon as it comes back", async () => {
        // Rather than leaving it parked until someone happens to ask for a connection - the slot
        // it occupies is what a waiting transfer needs.
        const { pool, disconnect } = makePool(2);

        await pool.withConnection(async (c) => { c.alive = false; });

        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it("returns the connection even when the borrowed work throws", async () => {
        const { pool, connect } = makePool(1);

        await expect(pool.withConnection(async () => { throw new Error("upload failed"); })).rejects.toThrow("upload failed");
        await pool.withConnection(async () => undefined);

        expect(connect).toHaveBeenCalledTimes(1);
    });

    it("frees the slot when connecting fails, so waiting borrowers can try", async () => {
        // Otherwise one refused handshake permanently shrinks the pool, and with limit 1 every
        // later transfer waits for a release that is never coming.
        let attempt = 0;
        const pool = createConnectionPool<FakeConnection>({
            limit: 1,
            connect: async () => {
                attempt++;
                if (attempt === 1) throw new Error("connection refused");
                return { id: attempt, alive: true };
            },
            disconnect: async () => { },
            isAlive: (c) => c.alive,
        });

        await expect(pool.withConnection(async () => undefined)).rejects.toThrow("connection refused");
        await expect(pool.withConnection(async (c) => c.id)).resolves.toBe(2);
    });

    it("closes every connection it opened", async () => {
        const { pool, disconnect } = makePool(3);

        await Promise.all(Array.from({ length: 6 }, () => pool.withConnection(async () => {
            await new Promise((r) => setTimeout(r, 5));
        })));
        await pool.close();

        expect(disconnect).toHaveBeenCalledTimes(3);
        expect(pool.openCount()).toBe(0);
    });

    it("rejects borrowers waiting at close instead of leaving them hanging", async () => {
        // A waiter still in the queue would never be woken again, hanging for the lifetime of
        // the process and taking the surrounding backup run with it. The transfer holding the
        // connection is deliberately left running: if the waiter is only freed once that one
        // returns its connection, close() is not the thing releasing it and a stuck transfer
        // would strand the waiter for good.
        const { pool } = makePool(1);
        let releaseFirst: () => void = () => { };
        const blocking = pool.withConnection(() => new Promise<void>((r) => { releaseFirst = r; }));
        const queued = pool.withConnection(async () => undefined);

        await new Promise((r) => setTimeout(r, 5));
        const closing = pool.close();

        await expect(queued).rejects.toThrow(/closed/i);
        releaseFirst();
        await blocking;
        await closing;
    });

    it("wakes a waiting borrower when a connection attempt fails", async () => {
        // The slot is only freed in the failing attempt's own cleanup, so without waking someone
        // the queued transfer waits for a release that cannot come - nobody ever held a
        // connection to give back.
        let attempt = 0;
        const pool = createConnectionPool<FakeConnection>({
            limit: 1,
            connect: async () => {
                attempt++;
                await new Promise((r) => setTimeout(r, 10));
                if (attempt === 1) throw new Error("connection refused");
                return { id: attempt, alive: true };
            },
            disconnect: async () => { },
            isAlive: (c) => c.alive,
        });

        const first = pool.withConnection(async () => "a");
        const second = pool.withConnection(async () => "b");

        await expect(first).rejects.toThrow("connection refused");
        await expect(second).resolves.toBe("b");
    });

    it("refuses new work once closed", async () => {
        const { pool } = makePool(2);
        await pool.close();

        await expect(pool.withConnection(async () => undefined)).rejects.toThrow(/closed/i);
    });
});
