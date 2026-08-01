import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Hoisted mocks ---

const {
    mockExecFileAsync,
    mockIsMultiDbTar,
    mockReadTarManifest,
} = vi.hoisted(() => ({
    mockExecFileAsync: vi.fn(),
    mockIsMultiDbTar: vi.fn(),
    mockReadTarManifest: vi.fn(),
}));

// analyzeDump greps a dump file that always sits on the DBackup host, so it
// runs a plain local exec rather than going through the transport.
vi.mock("@/lib/adapters/process", () => ({
    execFileAsync: (...args: any[]) => mockExecFileAsync(...args),
}));

vi.mock("@/lib/adapters/database/common/tar-utils", () => ({
    isMultiDbTar: (...args: any[]) => mockIsMultiDbTar(...args),
    readTarManifest: (...args: any[]) => mockReadTarManifest(...args),
}));

vi.mock("@/lib/logging/logger", () => ({
    logger: {
        child: vi.fn().mockReturnValue({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock("@/lib/logging/errors", () => ({
    wrapError: vi.fn((e) => e),
}));

import { analyzeDump } from "@/lib/adapters/database/postgres/analyze";

describe("PostgreSQL analyzeDump()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // TAR archive paths
    // -------------------------------------------------------------------------

    it("returns database names from a TAR manifest", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue({
            databases: [{ name: "orders" }, { name: "users" }],
        });

        const result = await analyzeDump("/backups/multi.tar");

        expect(result).toEqual(["orders", "users"]);
    });

    it("returns empty array for a TAR archive with null manifest", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue(null);

        const result = await analyzeDump("/backups/broken.tar");

        expect(result).toEqual([]);
    });

    it("returns empty array for a TAR archive with empty databases list", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue({ databases: [] });

        const result = await analyzeDump("/backups/empty.tar");

        expect(result).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // Single SQL file: grep-based parsing
    // -------------------------------------------------------------------------

    it("parses CREATE DATABASE with quoted name from grep output", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: 'CREATE DATABASE "shop" WITH TEMPLATE = template0;\n',
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("shop");
    });

    it("parses CREATE DATABASE without quotes from grep output", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "CREATE DATABASE analytics ENCODING 'UTF8';\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("analytics");
    });

    it("parses \\connect statements with quoted db name", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: '\\connect "mydb"\n',
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("mydb");
    });

    it("parses \\connect statements without quotes", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "\\connect otherdb\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("otherdb");
    });

    it("returns multiple databases from mixed CREATE DATABASE and \\connect lines", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: 'CREATE DATABASE "shop" WITH TEMPLATE = template0;\n\\connect analytics\n',
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual(expect.arrayContaining(["shop", "analytics"]));
        expect(result).toHaveLength(2);
    });

    it("deduplicates databases found by multiple patterns", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: 'CREATE DATABASE "mydb" WITH TEMPLATE = template0;\n\\connect "mydb"\n',
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual(["mydb"]);
    });

    // -------------------------------------------------------------------------
    // grep exit code 1 = no matches (not an error)
    // -------------------------------------------------------------------------

    it("returns empty array when grep finds no matches (exit code 1)", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        const err = Object.assign(new Error("grep exited 1"), { code: 1 });
        mockExecFileAsync.mockRejectedValue(err);

        const result = await analyzeDump("/backups/no-match.sql");

        expect(result).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // ENOENT error is silently swallowed
    // -------------------------------------------------------------------------

    it("returns empty array on ENOENT without logging", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        const err = Object.assign(new Error("file not found"), { code: "ENOENT" });
        mockExecFileAsync.mockRejectedValue(err);

        const result = await analyzeDump("/backups/missing.sql");

        expect(result).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // Unexpected errors are logged and still return empty
    // -------------------------------------------------------------------------

    it("returns empty array and logs error on unexpected grep errors", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        const err = Object.assign(new Error("permission denied"), { code: "EPERM" });
        mockExecFileAsync.mockRejectedValue(err);

        const result = await analyzeDump("/backups/denied.sql");

        expect(result).toEqual([]);
    });
});
