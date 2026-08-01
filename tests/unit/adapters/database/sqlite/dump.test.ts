import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFsStat } = vi.hoisted(() => ({ mockFsStat: vi.fn() }));

vi.mock("fs/promises", () => ({
    default: { stat: (...args: unknown[]) => mockFsStat(...args) },
    stat: (...args: unknown[]) => mockFsStat(...args),
}));

import { createFakeHost, type FakeHost } from "@/lib/testing/fake-host";
import { dump } from "@/lib/adapters/database/sqlite/dump";
import type { HostKind } from "@/lib/transport/types";

const baseConfig = { mode: "local", path: "/data/app.sqlite" };

function dumpHost(kind: HostKind, opts: { code?: number; stderr?: string } = {}): FakeHost {
    return createFakeHost({ kind, onExec: () => opts });
}

describe.each<HostKind>(["direct", "ssh"])("SQLite dump over a %s host", (kind) => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFsStat.mockResolvedValue({ size: 4096 });
    });

    it("takes an online snapshot and reports the size", async () => {
        const result = await dump(baseConfig as never, "/tmp/out.sqlite", dumpHost(kind));

        expect(result.success).toBe(true);
        expect(result.size).toBe(4096);
        expect(result.path).toBe("/tmp/out.sqlite");
    });

    it("uses the .backup dot command rather than dumping SQL text", async () => {
        const host = dumpHost(kind);
        await dump(baseConfig as never, "/tmp/out.sqlite", host);

        const argv = host.calls.exec[0];
        expect(argv[0]).toBe("sqlite3");
        expect(argv[1]).toBe("/data/app.sqlite");
        expect(argv[2]).toMatch(/^\.backup /);
    });

    it("fails when sqlite3 exits non-zero", async () => {
        const result = await dump(
            baseConfig as never,
            "/tmp/out.sqlite",
            dumpHost(kind, { code: 1, stderr: "unable to open database file" }),
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("unable to open database file");
    });

    it("reports full progress on success", async () => {
        const seen: number[] = [];
        await dump(baseConfig as never, "/tmp/out.sqlite", dumpHost(kind), undefined, (p) => seen.push(p));

        expect(seen).toContain(100);
    });

    it("rejects a call made without a transport", async () => {
        const result = await dump(baseConfig as never, "/tmp/out.sqlite", undefined as never);

        expect(result.success).toBe(false);
        expect(result.error).toContain("requires an execution host");
    });
});
