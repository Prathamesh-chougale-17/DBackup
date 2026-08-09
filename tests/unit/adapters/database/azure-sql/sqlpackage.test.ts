import { describe, it, expect, vi } from "vitest";
import { createFakeHost } from "@/lib/testing/fake-host";
import { sqlpackageExporter } from "@/lib/adapters/database/azure-sql/exporter/sqlpackage";
import { buildConnectionString } from "@/lib/adapters/database/azure-sql/exporter/connection-string";

const config = {
    host: "myserver.database.windows.net",
    port: 1433,
    user: "backupadmin",
    password: "s3cret",
    database: "",
    requestTimeout: 300000,
} as never;

/** Collects what the adapter wrote to the run log. */
function collector() {
    const lines: { msg: string; level?: string }[] = [];
    const log = (msg: string, level?: string) => lines.push({ msg, level });
    return { lines, log: log as never };
}

describe("SqlPackage export", () => {
    it("builds the export argv SqlPackage expects", async () => {
        const host = createFakeHost({ kind: "direct" });
        const { log } = collector();

        await sqlpackageExporter.exportDatabase(config, "shop", "/tmp/shop.bacpac", host, log);

        expect(host.calls.spawn).toHaveLength(1);
        const argv = host.calls.spawn[0];
        expect(argv[0]).toBe("sqlpackage");
        expect(argv).toContain("/Action:Export");
        expect(argv).toContain("/TargetFile:/tmp/shop.bacpac");
        expect(argv).toContain("/OverwriteFiles:True");
    });

    it("passes the connection string as one argument, verbatim", async () => {
        // This assertion exists to hold a documented exception in place.
        //
        // The adapter rules say secrets belong in options.env, never in argv.
        // SqlPackage has no environment route and rejects
        // /SourceConnectionString:@file, so the exception was taken deliberately,
        // and it is bounded by this adapter having no SSH mode at all.
        //
        // If someone later moves the secret to env believing the rule was simply
        // missed, this fails and points them at the reasoning in sqlpackage.ts
        // rather than letting the change look correct.
        const host = createFakeHost({ kind: "direct" });
        const { log } = collector();

        await sqlpackageExporter.exportDatabase(config, "shop", "/tmp/shop.bacpac", host, log);

        const argv = host.calls.spawn[0];
        const expected = `/SourceConnectionString:${buildConnectionString(config, "shop")}`;
        expect(argv).toContain(expected);

        // One argument, not split on the semicolons inside the connection string.
        expect(argv.filter((a) => a.startsWith("/SourceConnectionString:"))).toHaveLength(1);
    });

    it("raises Ledger tables once, as a warning, in words a user can act on", async () => {
        // SqlPackage reports this per element and buries it among the rest. The
        // consequence is real: the history table and the generated-always columns
        // are dropped, which is exactly the tamper evidence Ledger exists for.
        const host = createFakeHost({
            kind: "direct",
            onSpawn: () => ({
                stdout: [
                    "Extracting schema",
                    "*** The ledger data in system views will not be captured in the resulting bacpac file.",
                    "*** Element [dbo].[x].[ledger_start_transaction_id] is a column with system-generated values in a ledger table.",
                    "Successfully exported database",
                ].join("\n"),
            }),
        });
        const { lines, log } = collector();

        await sqlpackageExporter.exportDatabase(config, "shop", "/tmp/shop.bacpac", host, log);

        const summaries = lines.filter((l) => l.msg.includes("tamper evidence is not part of this backup"));
        expect(summaries).toHaveLength(1);
        expect(summaries[0].level).toBe("warning");
    });

    it("reports the cause rather than the exit code when the export fails", async () => {
        // SqlPackage puts the actual reason on a *** line and then exits non-zero.
        // An error carrying only the code is what made the old MSSQL failures
        // unreadable.
        const host = createFakeHost({
            kind: "direct",
            onSpawn: () => ({
                stdout: "*** Error parsing connection string: Format of the initialization string does not conform.",
                code: 1,
            }),
        });
        const { log } = collector();

        await expect(sqlpackageExporter.exportDatabase(config, "shop", "/tmp/shop.bacpac", host, log))
            .rejects.toThrow(/Format of the initialization string/);
    });
});

describe("SqlPackage import", () => {
    it("builds the import argv against the target database", async () => {
        const host = createFakeHost({ kind: "direct" });
        const { log } = collector();

        await sqlpackageExporter.importDatabase(config, "/tmp/shop.bacpac", "shop_restored", host, log);

        const argv = host.calls.spawn[0];
        expect(argv).toContain("/Action:Import");
        expect(argv).toContain("/SourceFile:/tmp/shop.bacpac");
        expect(argv).toContain(`/TargetConnectionString:${buildConnectionString(config, "shop_restored")}`);
    });

    it("reports progress only at the phases SqlPackage actually announces", async () => {
        // No percentage of its own is emitted, so anything between these anchors
        // would be a guess presented as a measurement.
        const host = createFakeHost({
            kind: "direct",
            onSpawn: () => ({
                stdout: ["Initializing deployment", "Processing Import.", "Successfully imported"].join("\n"),
            }),
        });
        const { log } = collector();
        const onProgress = vi.fn();

        await sqlpackageExporter.importDatabase(config, "/tmp/x.bacpac", "shop", host, log, onProgress);

        expect(onProgress.mock.calls.map((c) => c[0])).toEqual([10, 40, 100]);
    });
});

describe("SqlPackage availability", () => {
    it("reports the version when the binary is present", async () => {
        const host = createFakeHost({
            kind: "direct",
            onExec: () => ({ stdout: "170.4.83.3\n", code: 0 }),
        });

        await expect(sqlpackageExporter.probe(config, host)).resolves.toEqual({
            ok: true,
            detail: "SqlPackage 170.4.83.3",
        });
    });

    it("explains a missing binary instead of throwing", async () => {
        // Surfaced through the connection test, so it costs one click rather than
        // a failed scheduled run at 03:00.
        const host = createFakeHost({ kind: "direct", onWhich: () => null });

        const result = await sqlpackageExporter.probe(config, host);

        expect(result.ok).toBe(false);
        // Names both places it can be missing. A development checkout has no image
        // at all, so blaming one there would send the reader after a phantom.
        expect(result.detail).toContain("custom or outdated image");
        expect(result.detail).toContain("setup-dev-macos.sh");
    });
});
