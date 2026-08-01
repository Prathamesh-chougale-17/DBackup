import { describe, it, expect, vi, beforeEach } from "vitest";

import { createFakeHost, type FakeHost } from "@/lib/testing/fake-host";
import { restore, prepareRestore } from "@/lib/adapters/database/sqlite/restore";
import type { HostKind } from "@/lib/transport/types";

const baseConfig = { mode: "local", path: "/data/app.sqlite" };

/** The sqlite3 dot command a recorded call issued, if any. */
function dotCommandOf(argv: string[]): string | undefined {
    return argv.find(a => a.startsWith("."));
}

function restoreHost(kind: HostKind, opts: { files?: Record<string, number>; code?: number; stderr?: string } = {}): FakeHost {
    return createFakeHost({
        kind,
        files: opts.files,
        onExec: (argv) => dotCommandOf(argv) ? { code: opts.code, stderr: opts.stderr } : { code: 0 },
    });
}

describe.each<HostKind>(["direct", "ssh"])("SQLite restore over a %s host", (kind) => {
    beforeEach(() => vi.clearAllMocks());

    it("needs no preparation", async () => {
        await expect(prepareRestore(baseConfig as never, [], createFakeHost({ kind })))
            .resolves.toBeUndefined();
    });

    it("restores through the .restore dot command", async () => {
        const host = restoreHost(kind);
        const result = await restore(baseConfig as never, "/tmp/in.sqlite", host);

        expect(result.success).toBe(true);
        const restoreCall = host.calls.exec.find(a => dotCommandOf(a)?.startsWith(".restore"))!;
        expect(restoreCall[1]).toBe("/data/app.sqlite");
    });

    it("moves an existing database aside before replacing it", async () => {
        const host = restoreHost(kind, { files: { "/data/app.sqlite": 4096 } });
        await restore(baseConfig as never, "/tmp/in.sqlite", host);

        const copy = host.calls.exec.find(a => a[0] === "cp")!;
        expect(copy[1]).toBe("/data/app.sqlite");
        expect(copy[2]).toMatch(/^\/data\/app\.sqlite\.bak-\d+$/);
        expect(host.calls.exec.some(a => a[0] === "rm")).toBe(true);
    });

    it("skips the safety copy when there is nothing to replace", async () => {
        const host = restoreHost(kind);
        await restore(baseConfig as never, "/tmp/in.sqlite", host);

        expect(host.calls.exec.some(a => a[0] === "cp")).toBe(false);
    });

    it("stops when the existing database cannot be moved aside", async () => {
        const host = createFakeHost({
            kind,
            files: { "/data/app.sqlite": 4096 },
            onExec: (argv) => argv[0] === "cp" ? { code: 1, stderr: "permission denied" } : { code: 0 },
        });

        const result = await restore(baseConfig as never, "/tmp/in.sqlite", host);

        expect(result.success).toBe(false);
        expect(result.error).toContain("permission denied");
        // The original must still be there: nothing was removed.
        expect(host.calls.exec.some(a => a[0] === "rm")).toBe(false);
    });

    it("fails when sqlite3 exits non-zero", async () => {
        const host = restoreHost(kind, { code: 1, stderr: "not a database" });
        const result = await restore(baseConfig as never, "/tmp/in.sqlite", host);

        expect(result.success).toBe(false);
        expect(result.error).toContain("not a database");
    });

    it("reports progress through to completion", async () => {
        const seen: number[] = [];
        await restore(baseConfig as never, "/tmp/in.sqlite", restoreHost(kind), undefined, (p) => seen.push(p));

        expect(seen).toContain(50);
        expect(seen).toContain(100);
    });

    it("rejects a call made without a transport", async () => {
        const result = await restore(baseConfig as never, "/tmp/in.sqlite", undefined as never);

        expect(result.success).toBe(false);
        expect(result.error).toContain("requires an execution host");
    });
});
