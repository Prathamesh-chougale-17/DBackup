import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const { mockExecuteQuery, mockExecuteWithMessages, mockExecuteParameterized } = vi.hoisted(() => ({
    mockExecuteQuery: vi.fn(),
    mockExecuteWithMessages: vi.fn(),
    mockExecuteParameterized: vi.fn(),
}));

vi.mock("@/lib/adapters/database/mssql/connection", () => ({
    executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
    executeQueryWithMessages: (...args: unknown[]) => mockExecuteWithMessages(...args),
    executeParameterizedQuery: (...args: unknown[]) => mockExecuteParameterized(...args),
}));

import { createFakeHost, type FakeHost } from "@/lib/testing/fake-host";
import { restore, prepareRestore } from "@/lib/adapters/database/mssql/restore";
import { CompositeHost, DirectHost } from "@/lib/transport";

let mountDir: string;
let srcDir: string;

/** The queries that reached SQL Server. */
function restoreQueries(): string[] {
    return mockExecuteWithMessages.mock.calls.map(c => c[2] as string);
}

function config() {
    return {
        host: "sql.internal",
        port: 1433,
        user: "sa",
        password: "secret",
        database: "testdb",
        backupPath: "/var/opt/mssql/backup",
        localBackupPath: mountDir,
    };
}

beforeEach(async () => {
    vi.clearAllMocks();
    mountDir = await mkdtemp(join(os.tmpdir(), "dbackup-mssql-mount-"));
    srcDir = await mkdtemp(join(os.tmpdir(), "dbackup-mssql-src-"));

    mockExecuteParameterized.mockResolvedValue({ recordset: [{ state_desc: "ONLINE" }] });
    mockExecuteQuery.mockResolvedValue({
        recordset: [
            { LogicalName: "testdb", Type: "D", PhysicalName: "/var/opt/mssql/data/testdb.mdf" },
            { LogicalName: "testdb_log", Type: "L", PhysicalName: "/var/opt/mssql/data/testdb.ldf" },
        ],
    });
    mockExecuteWithMessages.mockResolvedValue({ result: {}, messages: [] });
});

afterEach(async () => {
    await rm(mountDir, { recursive: true, force: true });
    await rm(srcDir, { recursive: true, force: true });
});

async function makeBackupFile(): Promise<string> {
    const file = join(srcDir, "testdb.bak");
    await writeFile(file, "BAKDATA");
    return file;
}

describe("MSSQL prepareRestore", () => {
    it("accepts a database that is online", async () => {
        await expect(prepareRestore(config() as never, ["testdb"], createFakeHost({ kind: "direct" })))
            .resolves.toBeUndefined();
    });

    it("rejects a database that is not online", async () => {
        mockExecuteParameterized.mockResolvedValue({ recordset: [{ state_desc: "RESTORING" }] });

        await expect(prepareRestore(config() as never, ["testdb"], createFakeHost({ kind: "direct" })))
            .rejects.toThrow(/not online.*RESTORING/);
    });

    it("accepts a database that does not exist yet", async () => {
        mockExecuteParameterized.mockResolvedValue({ recordset: [] });

        await expect(prepareRestore(config() as never, ["newdb"], createFakeHost({ kind: "direct" })))
            .resolves.toBeUndefined();
    });
});

describe("MSSQL restore with a shared mount", () => {
    it("stages the backup into the mount and runs RESTORE", async () => {
        const host = createFakeHost({ kind: "direct" });
        const result = await restore(config() as never, await makeBackupFile(), host);

        expect(result.success).toBe(true);
        expect(restoreQueries()[0]).toContain("RESTORE DATABASE");
        expect(host.calls.putFile).toHaveLength(0);
        expect(await readdir(mountDir)).toHaveLength(1);
    });

    it("removes only the local copy, since both paths are one file", async () => {
        const host = createFakeHost({ kind: "direct" });
        await restore(config() as never, await makeBackupFile(), host);

        expect(host.calls.removed).toHaveLength(0);
    });

    it("reports a failing restore", async () => {
        mockExecuteWithMessages.mockRejectedValue(new Error("Cannot open backup device"));

        const result = await restore(config() as never, await makeBackupFile(), createFakeHost({ kind: "direct" }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("Cannot open backup device");
    });
});

describe.each([
    ["a full SSH connection", () => createFakeHost({ kind: "ssh" })],
    ["the legacy SSH file transfer", () => {
        const files = createFakeHost({ kind: "ssh" });
        const composite = new CompositeHost(new DirectHost(), files);
        Object.defineProperty(composite, "calls", { get: () => files.calls });
        return composite as unknown as FakeHost;
    }],
])("MSSQL restore over %s", (_label, makeHost) => {
    it("uploads the backup file to the server", async () => {
        const host = makeHost();
        const result = await restore(config() as never, await makeBackupFile(), host);

        expect(result.success).toBe(true);
        expect(host.calls.putFile).toHaveLength(1);
        expect(host.calls.putFile[0].hostPath).toContain("/var/opt/mssql/backup/");
    });

    it("removes the uploaded file afterwards", async () => {
        const host = makeHost();
        await restore(config() as never, await makeBackupFile(), host);

        expect(host.calls.removed.some(p => p.includes("/var/opt/mssql/backup/"))).toBe(true);
    });

    it("does not touch the mount directory", async () => {
        const host = makeHost();
        await restore(config() as never, await makeBackupFile(), host);

        expect(await readdir(mountDir)).toHaveLength(0);
    });
});
