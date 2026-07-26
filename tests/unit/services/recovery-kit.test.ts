// @vitest-environment node
// AdmZip cannot read a zip back out of a Buffer under jsdom, and this test verifies
// the bytes a user actually downloads.
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { buildRecoveryKit, RECOVERY_TOOL } from "@/services/backup/recovery-kit";

const KEY_HEX = "ab".repeat(32);

async function buildKit() {
    const zip = new AdmZip(await buildRecoveryKit({
        profileName: "Production", masterKeyHex: KEY_HEX, generatedAt: "2026-07-26T12:00:00.000Z",
    }));
    return new Map(zip.getEntries().map((entry) => [entry.entryName, entry]));
}

/** Unix mode as an unzip tool reads it: the top 16 bits of the external attributes. */
function modeOf(entry: AdmZip.IZipEntry): number {
    return (entry.header.attr >>> 16) & 0o7777;
}

describe("recovery kit", () => {
    it("ships the tool, the key and a launcher for each platform", async () => {
        const entries = await buildKit();

        expect([...entries.keys()].sort()).toEqual([
            "README.txt", "START-Linux.sh", "START-Windows.bat", "START-macOS.command",
            RECOVERY_TOOL, "master.key",
        ].sort());
        expect(entries.get("master.key")!.getData().toString("utf-8")).toBe(KEY_HEX);
    });

    it("marks the launchers executable so they can actually be started", async () => {
        // The regression this guards: AdmZip masks the mode it is handed with 0xfff and
        // does the shifting itself, so a pre-shifted value silently produced mode 000 -
        // which macOS reports as "you do not have permission to open the document".
        const entries = await buildKit();

        expect(modeOf(entries.get("START-macOS.command")!)).toBe(0o755);
        expect(modeOf(entries.get("START-Linux.sh")!)).toBe(0o755);
        expect(modeOf(entries.get(RECOVERY_TOOL)!)).toBe(0o755);
    });

    it("leaves the key and the readme readable but not executable", async () => {
        const entries = await buildKit();

        expect(modeOf(entries.get("master.key")!)).toBe(0o644);
        expect(modeOf(entries.get("README.txt")!)).toBe(0o644);
    });

    it("ships the real tool, not a placeholder", async () => {
        // The tool is read off disk at request time, so a rename in scripts/ would
        // otherwise ship a kit whose only content is an apology.
        const entries = await buildKit();

        expect(entries.get(RECOVERY_TOOL)!.getData().toString("utf-8"))
            .toContain("DBackup Recovery Tool");
    });

    it("gives the terminal command for every platform, not only Linux", async () => {
        // A blocked or unclickable launcher must never be a dead end, and on macOS the
        // first double-click of a downloaded file usually is one.
        const readme = (await buildKit()).get("README.txt")!.getData().toString("utf-8");

        expect(readme).toContain(`node ${RECOVERY_TOOL}`);
        expect(readme).toMatch(/right-click/i);
        expect(readme).toMatch(/Command Prompt/);
        expect(readme).toMatch(/Terminal/);
        expect(readme).toMatch(/cd \/path\/to\/this\/folder/);
    });

    it("names the profile it belongs to", async () => {
        const readme = (await buildKit()).get("README.txt")!.getData().toString("utf-8");
        expect(readme).toContain("Production");
    });
});
