import { describe, it, expect, vi } from "vitest";
import { mapWithConcurrency, untilAborted } from "@/lib/concurrency";

/** A deferred promise plus its resolver, for controlling task completion order in a test. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
    it("never runs more than the limit at once", async () => {
        let inFlight = 0;
        let peak = 0;
        const items = Array.from({ length: 20 }, (_, i) => i);

        await mapWithConcurrency(items, 4, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return n;
        });

        expect(peak).toBe(4);
    });

    it("keeps results in input order regardless of completion order", async () => {
        // The last item resolves first, the first item last - order must still hold.
        const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
        const promise = mapWithConcurrency([0, 1, 2], 3, (n) => gates[n].promise);

        gates[2].resolve(22);
        gates[0].resolve(0);
        gates[1].resolve(11);

        expect(await promise).toEqual([0, 11, 22]);
    });

    it("runs strictly sequentially at limit 1", async () => {
        const order: string[] = [];
        await mapWithConcurrency([0, 1, 2], 1, async (n) => {
            order.push(`start-${n}`);
            await new Promise((r) => setTimeout(r, 1));
            order.push(`end-${n}`);
            return n;
        });

        // Never overlaps: each item ends before the next starts.
        expect(order).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
    });

    it("rejects on the first failing item", async () => {
        await expect(
            mapWithConcurrency([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error("boom");
                return n;
            })
        ).rejects.toThrow("boom");
    });

    it("handles an empty list", async () => {
        expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
    });

    it("passes the index to the worker", async () => {
        const seen = await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => `${i}:${item}`);
        expect(seen).toEqual(["0:a", "1:b", "2:c"]);
    });
});

describe("untilAborted", () => {
    it("stops waiting on a promise that never settles", async () => {
        // The whole reason it exists: a torn-down SFTP transfer settles neither way, so waiting
        // for it to report its own failure means waiting forever.
        const controller = new AbortController();
        const never = new Promise<string>(() => { });

        const waiting = untilAborted(never, controller.signal);
        controller.abort();

        await expect(waiting).rejects.toThrow();
    });

    it("passes a normal result straight through", async () => {
        const controller = new AbortController();
        await expect(untilAborted(Promise.resolve("done"), controller.signal)).resolves.toBe("done");
    });

    it("passes a rejection straight through", async () => {
        const controller = new AbortController();
        await expect(untilAborted(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow("boom");
    });

    it("rejects immediately when the signal has already fired", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(untilAborted(new Promise<void>(() => { }), controller.signal)).rejects.toThrow();
    });

    it("is a no-op without a signal", async () => {
        await expect(untilAborted(Promise.resolve(42), undefined)).resolves.toBe(42);
    });

    it("does not leave a listener behind once the promise settles", async () => {
        // One per file in flight otherwise, on a signal that lives for the whole run.
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

        await untilAborted(Promise.resolve("ok"), controller.signal);

        expect(removeSpy).toHaveBeenCalled();
    });
});
