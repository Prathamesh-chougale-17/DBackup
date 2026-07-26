/**
 * The rule that decides whether a file is worth compressing.
 *
 * The negative cases carry as much weight as the positive ones. Every extension asserted
 * false below was left off the list on purpose, and without a test saying so the next person
 * to read the list sees an oversight and "fixes" it - which silently stops compressing
 * things that compress by half or better.
 */
import { describe, it, expect } from "vitest";
import { isIncompressible, INCOMPRESSIBLE_EXTENSIONS } from "@/lib/incompressible-formats";

describe("already-compressed formats are recognised", () => {
    it("matches media, archives and zip containers", () => {
        for (const path of [
            "holiday/clip.mp4",
            "music/track.flac",
            "photos/IMG_0042.jpg",
            "photos/scan.heic",
            "releases/build.zip",
            "releases/app.apk",
            "reports/q3.xlsx",
            "fonts/inter.woff2",
            "secrets/vault.gpg",
        ]) {
            expect(isIncompressible(path), path).toBe(true);
        }
    });

    it("ignores case, so an uppercase extension is not a way past the rule", () => {
        expect(isIncompressible("DCIM/IMG_1234.JPG")).toBe(true);
        expect(isIncompressible("VIDEO.MP4")).toBe(true);
    });

    it("reads only the last extension", () => {
        expect(isIncompressible("backup/archive.tar.gz")).toBe(true);
        // The inner extension must not decide it - this one is a plain tar.
        expect(isIncompressible("backup/photos.jpg.tar")).toBe(false);
    });

    it("treats a dotfile as having no extension", () => {
        expect(isIncompressible(".gitignore")).toBe(false);
        expect(isIncompressible("project/.env")).toBe(false);
        // A dot directory must not lend its name to a file inside it either.
        expect(isIncompressible(".config/settings")).toBe(false);
    });

    it("handles paths without an extension at all", () => {
        expect(isIncompressible("bin/dbackup")).toBe(false);
        expect(isIncompressible("README")).toBe(false);
        expect(isIncompressible("")).toBe(false);
    });
});

describe("formats deliberately left off the list still compress", () => {
    it("keeps compressing formats that are only sometimes compressed", () => {
        // A PDF may hold uncompressed streams, and TIFF and BMP routinely do.
        for (const path of ["docs/contract.pdf", "scans/page.tiff", "scans/page.tif", "art/logo.bmp"]) {
            expect(isIncompressible(path), path).toBe(false);
        }
    });

    it("keeps compressing formats that compress extremely well", () => {
        // Uncompressed font tables, a page-oriented database file, and XML.
        for (const path of ["fonts/inter.ttf", "fonts/inter.otf", "data/app.sqlite", "data/app.db", "icons/logo.svg"]) {
            expect(isIncompressible(path), path).toBe(false);
        }
    });

    it("keeps compressing ASCII-armored ciphertext", () => {
        // Base64 of ciphertext still gives back roughly a quarter, unlike the raw .gpg.
        expect(isIncompressible("keys/public.asc")).toBe(false);
        expect(isIncompressible("keys/private.gpg")).toBe(true);
    });
});

describe("the list itself", () => {
    it("is stored lowercase and without leading dots, which is what the lookup assumes", () => {
        for (const extension of INCOMPRESSIBLE_EXTENSIONS) {
            expect(extension, extension).toBe(extension.toLowerCase());
            expect(extension.startsWith("."), extension).toBe(false);
        }
    });
});
