// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import path from "path";

// The kit's tool is CommonJS by design - it is dropped into a folder with no package.json.
const require_ = createRequire(import.meta.url);
const tool = require_(path.resolve(process.cwd(), "scripts/dbackup-recover.js")) as {
    fitRow: (marker: string, label: string, hint?: string) => { label: string; hint: string };
    looksLikeBackupContent: (chunk: Buffer, compression?: string) => boolean;
    defaultDecryptedName: (input: string, compression?: string | null) => string;
    keyFor: (keys: { name: string; hex: string; profileId?: string }[], profileId?: string) => { name: string } | null;
};

const originalColumns = process.stdout.columns;
afterEach(() => { process.stdout.columns = originalColumns; });

/** The full row as the menu writes it, which is what must not exceed the width. */
function renderedWidth(marker: string, label: string, hint?: string): number {
    const row = tool.fitRow(marker, label, hint);
    return `${marker}${row.label}${row.hint ? `  ${row.hint}` : ""}`.length;
}

describe("menu rows never wrap", () => {
    // The redraw walks back up one line per option. A row that wraps costs two, so the
    // cursor lands mid-menu and every keypress leaves a copy of the menu behind.
    it.each([40, 60, 80, 120])("fits a long row into %i columns", (columns) => {
        process.stdout.columns = columns;
        const width = renderedWidth(
            " > ",
            "chain-2026-07-26T13-47-30-820",
            "26.07.2026 15:47  939.4 MB  encrypted  2 database(s)  1 directory source(s)  incremental chain, 1 archive(s)"
        );
        expect(width).toBeLessThan(columns);
    });

    it("keeps a row that already fits exactly as it was", () => {
        process.stdout.columns = 100;
        expect(tool.fitRow("   ", "backup.tar", "12 MB")).toEqual({ label: "backup.tar", hint: "12 MB" });
    });

    it("gives up the hint before shortening the name", () => {
        // The label identifies the backup; the hint is only context.
        process.stdout.columns = 44;
        const row = tool.fitRow(" > ", "MyImportantBackup.tar", "26.07.2026  939.4 MB  encrypted");
        expect(row.label).toBe("MyImportantBackup.tar");
        expect(row.hint.length).toBeLessThan("26.07.2026  939.4 MB  encrypted".length);
    });

    it("survives a name longer than the whole terminal", () => {
        process.stdout.columns = 30;
        expect(renderedWidth(" > ", "x".repeat(200), "y".repeat(200))).toBeLessThan(30);
    });
});

describe("recognising decrypted content", () => {
    it.each([
        ["gzip", Buffer.from([0x1f, 0x8b, 0x08, 0x00]), undefined],
        ["a PostgreSQL custom dump", Buffer.from("PGDMP\x01\x0e"), undefined],
        ["a SQLite database", Buffer.from("SQLite format 3\0"), undefined],
        ["a Redis snapshot", Buffer.from("REDIS0011"), undefined],
        ["a SQL dump", Buffer.from("INSERT INTO users VALUES (1);\n".repeat(4)), undefined],
    ])("accepts %s", (_name, chunk, compression) => {
        expect(tool.looksLikeBackupContent(chunk, compression)).toBe(true);
    });

    it("accepts a multi-database TAR by its ustar magic", () => {
        const header = Buffer.alloc(512, 0);
        Buffer.from("manifest.json").copy(header, 0);
        Buffer.from("ustar").copy(header, 257);
        expect(tool.looksLikeBackupContent(header)).toBe(true);
    });

    it("rejects the binary noise a wrong key produces", () => {
        expect(tool.looksLikeBackupContent(Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)))).toBe(false);
    });

    it("rejects anything without the magic when gzip was promised", () => {
        expect(tool.looksLikeBackupContent(Buffer.from("plain text here"), "GZIP")).toBe(false);
    });
});

describe("naming the decrypted output", () => {
    it.each([
        ["backup.sql.gz.enc", "GZIP", "backup.sql"],
        ["backup.sql.br.enc", "BROTLI", "backup.sql"],
        ["backup.dump.enc", null, "backup.dump"],
        // Compressed but never encrypted: the .gz still has to come off.
        ["backup.sql.gz", "GZIP", "backup.sql"],
    ])("turns %s into %s", (input, compression, expected) => {
        expect(tool.defaultDecryptedName(input, compression)).toBe(expected);
    });

    it("never writes back over its own input", () => {
        expect(tool.defaultDecryptedName("backup.dump", null)).toBe("backup.dump.restored");
    });
});

describe("choosing a key", () => {
    const keys = [
        { name: "Production", hex: "ab".repeat(32), profileId: "p1" },
        { name: "Legacy", hex: "cd".repeat(32), profileId: "p2" },
    ];

    it("uses the profile the backup recorded", () => {
        expect(tool.keyFor(keys, "p2")?.name).toBe("Legacy");
    });

    it("takes the only key when there is just one", () => {
        expect(tool.keyFor([keys[0]], undefined)?.name).toBe("Production");
    });

    it("refuses to guess between several", () => {
        // Guessing would mean handing an unverified key to the decryption pipeline; the
        // caller tests candidates against the backup instead.
        expect(tool.keyFor(keys, "unknown-profile")).toBeNull();
    });
});
