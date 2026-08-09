import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const { mockExport, mockGetDatabases } = vi.hoisted(() => ({
    mockExport: vi.fn(),
    mockGetDatabases: vi.fn(),
}));

vi.mock("@/lib/adapters/database/azure-sql/exporter", () => ({
    resolveExporter: () => ({ id: "sqlpackage", exportDatabase: mockExport }),
}));

vi.mock("@/lib/adapters/database/azure-sql/connection", () => ({
    getDatabases: (...args: unknown[]) => mockGetDatabases(...args),
}));

import { createFakeHost } from "@/lib/testing/fake-host";
import { dump } from "@/lib/adapters/database/azure-sql/dump";
import { isMultiDbTar, readTarManifest } from "@/lib/adapters/database/common/tar-utils";

let outDir: string;

function config(database: string | string[] = "shop") {
    return {
        host: "myserver.database.windows.net",
        port: 1433,
        user: "backupadmin",
        password: "s3cret",
        database,
        requestTimeout: 300000,
    } as never;
}

/** Stand in for SqlPackage writing the BACPAC where it was told to. */
function exporterWritesBacpac() {
    mockExport.mockImplementation(async (_cfg, dbName: string, destPath: string) => {
        await writeFile(destPath, `BACPAC:${dbName}`);
    });
}

beforeEach(async () => {
    vi.clearAllMocks();
    outDir = await mkdtemp(join(os.tmpdir(), "dbackup-azure-out-"));
    exporterWritesBacpac();
});

afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
});

describe("Azure SQL dump", () => {
    it("writes a single database straight to the destination", async () => {
        // No TAR wrapper for one database, which is what lets the runner's
        // size-polling progress watch the file it already knows about.
        const out = join(outDir, "out.bacpac");

        const result = await dump(config("shop"), out, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(await readFile(out, "utf8")).toBe("BACPAC:shop");
        expect(await isMultiDbTar(out)).toBe(false);
    });

    it("packs several databases with a manifest naming each one", async () => {
        // A manifest, not filename parsing. Deriving names from filenames the way
        // the MSSQL adapter does breaks on any database whose name contains the
        // separator being parsed.
        const out = join(outDir, "out.bacpac");

        const result = await dump(config(["shop", "analytics"]), out, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(await isMultiDbTar(out)).toBe(true);

        const manifest = await readTarManifest(out);
        expect(manifest?.sourceType).toBe("azure-sql");
        expect(manifest?.databases.map((d) => d.name).sort()).toEqual(["analytics", "shop"]);
        expect(manifest?.databases.every((d) => d.format === "bacpac")).toBe(true);
    });

    it("warns about consistency before the export runs, not after it succeeds", async () => {
        // A caveat that only appears once the backup worked is a caveat nobody
        // reads until they have already lost something.
        const messages: string[] = [];
        mockExport.mockImplementation(async (_cfg, dbName: string, destPath: string) => {
            messages.push("EXPORT_STARTED");
            await writeFile(destPath, `BACPAC:${dbName}`);
        });

        await dump(config("shop"), join(outDir, "out.bacpac"), createFakeHost({ kind: "direct" }), (msg) => {
            messages.push(msg);
        });

        const noticeIndex = messages.findIndex((m) => m.includes("not transactionally consistent"));
        expect(noticeIndex).toBeGreaterThanOrEqual(0);
        expect(noticeIndex).toBeLessThan(messages.indexOf("EXPORT_STARTED"));
    });

    it("discovers every user database when the job selected none", async () => {
        mockGetDatabases.mockResolvedValue(["shop", "analytics"]);

        const result = await dump(config(""), join(outDir, "out.bacpac"), createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(mockGetDatabases).toHaveBeenCalled();
        expect(mockExport).toHaveBeenCalledTimes(2);
    });

    it("fails with a usable message when the server has no user databases", async () => {
        mockGetDatabases.mockResolvedValue([]);

        const result = await dump(config(""), join(outDir, "out.bacpac"), createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("No user databases found");
    });

    it("reports a small export in units a reader can use", async () => {
        // A BACPAC of a small database is a few kilobytes. Fixed MB reported that
        // as "0.00 MB", which reads like the backup failed.
        const messages: string[] = [];

        await dump(config("shop"), join(outDir, "out.bacpac"), createFakeHost({ kind: "direct" }), (msg) => {
            messages.push(msg);
        });

        const line = messages.find((m) => m.startsWith("Backup finished successfully"))!;
        expect(line).toContain("Bytes");
        expect(line).not.toContain("0.00 MB");
    });

    it("reports an export that produced nothing rather than declaring success", async () => {
        mockExport.mockImplementation(async (_cfg, _db, destPath: string) => {
            await writeFile(destPath, "");
        });

        const result = await dump(config("shop"), join(outDir, "out.bacpac"), createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("empty file");
    });
});
