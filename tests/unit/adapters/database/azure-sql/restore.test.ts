import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const { mockPool, mockQuery, PoolCtor, mockImport } = vi.hoisted(() => {
    const mockQuery = vi.fn();
    const mockRequest = vi.fn(() => ({ query: mockQuery, input: vi.fn().mockReturnThis(), on: vi.fn() }));
    const mockPool = { connect: vi.fn(), close: vi.fn(), request: mockRequest };
    const PoolCtor = vi.fn(function () { return mockPool; });
    return { mockPool, mockQuery, PoolCtor, mockImport: vi.fn() };
});

vi.mock("mssql", () => ({
    default: { ConnectionPool: PoolCtor, NVarChar: "nvarchar" },
    ConnectionPool: PoolCtor,
    NVarChar: "nvarchar",
}));

vi.mock("@/lib/adapters/database/azure-sql/exporter", () => ({
    resolveExporter: () => ({ id: "sqlpackage", importDatabase: mockImport }),
}));

import { createFakeHost } from "@/lib/testing/fake-host";
import { restore } from "@/lib/adapters/database/azure-sql/restore";
import { prepareRestore } from "@/lib/adapters/database/azure-sql/preflight";
import { createMultiDbTar } from "@/lib/adapters/database/common/tar-utils";

let workDir: string;

function config(extra: Record<string, unknown> = {}) {
    return {
        host: "myserver.database.windows.net",
        port: 1433,
        user: "backupadmin",
        password: "s3cret",
        database: "shop",
        requestTimeout: 300000,
        ...extra,
    } as never;
}

/** Which databases importDatabase was asked to create, in call order. */
function importedTargets(): string[] {
    return mockImport.mock.calls.map((c) => c[2] as string);
}

/** Every statement that reached the server. */
function statements(): string[] {
    return mockQuery.mock.calls.map((c) => c[0] as string);
}

async function makeArchive(names: string[]): Promise<string> {
    const files = [];
    for (const name of names) {
        const path = join(workDir, `${name}.bacpac`);
        await writeFile(path, `BACPAC:${name}`);
        files.push({ name: `${name}.bacpac`, path, dbName: name, format: "bacpac" as const });
    }
    const archive = join(workDir, "archive.tar");
    await createMultiDbTar(files, archive, { sourceType: "azure-sql" });
    return archive;
}

beforeEach(async () => {
    vi.clearAllMocks();
    workDir = await mkdtemp(join(os.tmpdir(), "dbackup-azure-restore-"));
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ recordset: [] });
    mockImport.mockResolvedValue(undefined);
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("Azure SQL restore preflight", () => {
    it("accepts a target that does not exist yet", async () => {
        await expect(prepareRestore(config(), ["newdb"], createFakeHost({ kind: "direct" })))
            .resolves.toBeUndefined();
    });

    it("accepts a target that already exists, because a restore replaces it", async () => {
        // Every other adapter replaces what it restores over, and the restore
        // dialog already had the user choose overwrite over rename. Refusing here
        // would break a decision that was made deliberately two screens earlier.
        mockQuery.mockResolvedValue({ recordset: [{ name: "shop" }] });

        await expect(prepareRestore(config(), ["shop"], createFakeHost({ kind: "direct" })))
            .resolves.toBeUndefined();
    });

    it("rejects a name SQL Server itself could not hold", async () => {
        await expect(prepareRestore(config(), ["x".repeat(129)], createFakeHost({ kind: "direct" })))
            .rejects.toThrow(/Invalid database name/);
    });
});

describe("Azure SQL restore", () => {
    it("imports a single BACPAC into the configured database", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");

        const result = await restore(config(), file, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(importedTargets()).toEqual(["shop"]);
    });

    it("drops an existing target first, since an import cannot overwrite in place", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");
        mockQuery.mockResolvedValue({ recordset: [{ name: "shop" }] });

        const result = await restore(config(), file, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(true);
        expect(statements()).toContainEqual(expect.stringContaining("DROP DATABASE [shop]"));
        expect(importedTargets()).toEqual(["shop"]);
    });

    it("issues no DROP when the target does not exist", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");
        mockQuery.mockResolvedValue({ recordset: [] });

        await restore(config(), file, createFakeHost({ kind: "direct" }));

        expect(statements().some((q) => q.includes("DROP DATABASE"))).toBe(false);
    });

    it("bracket-escapes a target name before dropping it", async () => {
        // The name comes from the restore dialog, so it is user input reaching a
        // statement that cannot be parameterised.
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");
        mockQuery.mockResolvedValue({ recordset: [{ name: "we]ird" }] });

        await restore(
            config({ databaseMapping: [{ originalName: "shop", targetName: "we]ird", selected: true }] }),
            file,
            createFakeHost({ kind: "direct" }),
        );

        expect(statements()).toContainEqual(expect.stringContaining("DROP DATABASE [we]]ird]"));
    });

    it("warns in the run log before dropping anything", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");
        mockQuery.mockResolvedValue({ recordset: [{ name: "shop" }] });
        const logged: { msg: string; level?: string }[] = [];

        await restore(config(), file, createFakeHost({ kind: "direct" }), (msg, level) => {
            logged.push({ msg, level });
        });

        const warning = logged.find((l) => l.msg.includes("Dropping the existing database shop"));
        expect(warning?.level).toBe("warning");
        // Names the way back, because Azure does keep dropped databases recoverable.
        expect(warning?.msg).toContain("Deleted databases");
    });

    it("honours a rename from the restore dialog", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");

        await restore(
            config({ databaseMapping: [{ originalName: "shop", targetName: "shop_copy", selected: true }] }),
            file,
            createFakeHost({ kind: "direct" }),
        );

        expect(importedTargets()).toEqual(["shop_copy"]);
    });

    it("restores only the databases selected out of an archive", async () => {
        const archive = await makeArchive(["shop", "analytics"]);

        await restore(
            config({
                databaseMapping: [
                    { originalName: "shop", targetName: "shop", selected: true },
                    { originalName: "analytics", targetName: "analytics", selected: false },
                ],
            }),
            archive,
            createFakeHost({ kind: "direct" }),
        );

        expect(importedTargets()).toEqual(["shop"]);
    });

    it("maps each extracted file to its own target, not to the first one", async () => {
        // Matched through the manifest by filename. Pairing by array position would
        // silently restore one database's contents under another's name once an
        // entry has been skipped.
        const archive = await makeArchive(["shop", "analytics"]);

        await restore(
            config({
                databaseMapping: [
                    { originalName: "shop", targetName: "shop_new", selected: true },
                    { originalName: "analytics", targetName: "analytics_new", selected: true },
                ],
            }),
            archive,
            createFakeHost({ kind: "direct" }),
        );

        expect(importedTargets().sort()).toEqual(["analytics_new", "shop_new"]);
    });

    it("connects with the privileged credentials when the restore supplies them", async () => {
        // They arrive nested and are never flattened by the pipeline, so the
        // adapter has to apply them itself.
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");

        await restore(
            config({ privilegedAuth: { user: "admin", password: "adminpw" } }),
            file,
            createFakeHost({ kind: "direct" }),
        );

        const usedConfig = mockImport.mock.calls[0][0] as { user: string; password: string };
        expect(usedConfig.user).toBe("admin");
        expect(usedConfig.password).toBe("adminpw");
    });

    it("reports a failed import instead of claiming success", async () => {
        const file = join(workDir, "shop.bacpac");
        await writeFile(file, "BACPAC:shop");
        mockImport.mockRejectedValue(new Error("Could not import package"));

        const result = await restore(config(), file, createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("Could not import package");
    });
});
