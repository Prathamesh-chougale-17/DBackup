import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/adapters/database/mssql/connection", () => ({
    executeParameterizedQuery: vi.fn(),
}));

import { checkBackupPath } from "@/lib/adapters/database/mssql/preflight";
import { createFakeHost } from "@/lib/testing/fake-host";

function hostWithDirectory(path = "/var/opt/mssql/backup") {
    return createFakeHost({ kind: "ssh", directories: [path] });
}

describe("checkBackupPath", () => {
    it("puts the probe inside the backup directory", async () => {
        const host = hostWithDirectory();

        const result = await checkBackupPath(host, "/var/opt/mssql/backup");

        expect(result).toEqual({ readable: true, writable: true });
        expect(host.calls.exec[0]).toEqual(["touch", "/var/opt/mssql/backup/.dbackup_probe"]);
    });

    it("does not double the separator when the path ends in slashes", async () => {
        // Trailing slashes are stripped with the shared linear-time helper. The
        // obvious `/\/+$/` backtracks quadratically, and this path comes from a
        // stored config, so it is exactly the input CodeQL flags.
        //
        // The directory is registered under the spelling stat() receives, which
        // a real filesystem resolves to the same inode.
        const host = hostWithDirectory("/var/opt/mssql/backup///");

        await checkBackupPath(host, "/var/opt/mssql/backup///");

        expect(host.calls.exec[0]).toEqual(["touch", "/var/opt/mssql/backup/.dbackup_probe"]);
    });

    it("stays fast on a pathological run of slashes", async () => {
        // The slashes must NOT be at the end. `/\/+$/` is quick when the match
        // succeeds, because only one position starts a run - the blowup needs a
        // run that fails the `$` anchor, so the engine retries and backtracks
        // from every position in it.
        const pathological = "/".repeat(200_000) + "x";
        const host = hostWithDirectory(pathological);
        const start = performance.now();

        await checkBackupPath(host, pathological);

        expect(performance.now() - start).toBeLessThan(500);
    });

    it("reports a missing directory rather than probing it", async () => {
        const host = createFakeHost({ kind: "ssh" });

        const result = await checkBackupPath(host, "/var/opt/mssql/backup");

        expect(result.readable).toBe(false);
        expect(result.error).toContain("Path not found");
        expect(host.calls.exec).toEqual([]);
    });

    it("reports a directory it cannot write to", async () => {
        const host = createFakeHost({
            kind: "ssh",
            directories: ["/var/opt/mssql/backup"],
            onExec: () => ({ code: 1, stderr: "touch: cannot touch: Permission denied" }),
        });

        const result = await checkBackupPath(host, "/var/opt/mssql/backup");

        expect(result).toMatchObject({ readable: true, writable: false });
        expect(result.error).toContain("Permission denied");
    });
});
