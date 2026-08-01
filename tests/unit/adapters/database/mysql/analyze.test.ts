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

import { analyzeDump } from "@/lib/adapters/database/mysql/analyze";

describe("MySQL analyzeDump()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // TAR archive paths
    // -------------------------------------------------------------------------

    it("returns database names from a TAR manifest", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue({
            databases: [{ name: "shop" }, { name: "analytics" }],
        });

        const result = await analyzeDump("/backups/multi.tar");

        expect(result).toEqual(["shop", "analytics"]);
    });

    it("returns an empty array for a TAR archive with a null manifest", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue(null);

        const result = await analyzeDump("/backups/broken.tar");

        expect(result).toEqual([]);
    });

    it("returns an empty array for a TAR archive with an empty databases list", async () => {
        mockIsMultiDbTar.mockResolvedValue(true);
        mockReadTarManifest.mockResolvedValue({ databases: [] });

        const result = await analyzeDump("/backups/empty.tar");

        expect(result).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // Single SQL file: grep-based parsing
    // -------------------------------------------------------------------------

    it("parses USE statements from grep output", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "USE `mydb`;\nUSE `otherdb`;\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual(expect.arrayContaining(["mydb", "otherdb"]));
        expect(result).toHaveLength(2);
    });

    it("parses CREATE DATABASE statements from grep output", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "CREATE DATABASE `shop`;\nCREATE DATABASE IF NOT EXISTS `analytics`;\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual(expect.arrayContaining(["shop", "analytics"]));
    });

    it("parses CREATE DATABASE with inline comment variant", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `legacy`;\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("legacy");
    });

    it("parses -- Current Database: comments from grep output", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "-- Current Database: `blog`\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toContain("blog");
    });

    it("deduplicates databases found by multiple patterns", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        mockExecFileAsync.mockResolvedValue({
            stdout: "USE `mydb`;\n-- Current Database: `mydb`\nCREATE DATABASE `mydb`;\n",
            stderr: "",
        });

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual(["mydb"]);
    });

    // -------------------------------------------------------------------------
    // grep exit code 1 = no matches (not an error)
    // -------------------------------------------------------------------------

    it("returns an empty array when grep finds no matches (exit code 1)", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        const noMatchError = Object.assign(new Error("grep: no matches"), { code: 1 });
        mockExecFileAsync.mockRejectedValue(noMatchError);

        const result = await analyzeDump("/backups/dump.sql");

        expect(result).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // grep other error (unexpected exit code)
    // -------------------------------------------------------------------------

    it("returns an empty array and logs the error for unexpected grep failures", async () => {
        mockIsMultiDbTar.mockResolvedValue(false);
        const unexpectedError = Object.assign(new Error("I/O error"), { code: 2 });
        mockExecFileAsync.mockRejectedValue(unexpectedError);

        const result = await analyzeDump("/backups/dump.sql");

        // No databases found, but function does not throw
        expect(result).toEqual([]);
    });
});
