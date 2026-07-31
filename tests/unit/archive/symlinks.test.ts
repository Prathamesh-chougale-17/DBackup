/**
 * Symbolic links through the archive format.
 *
 * The bug these cover (#135) was silence: links were dropped during collection, so a backup
 * reported success and was incomplete, and nobody found out until a restore. The assertions
 * are therefore about what survives a full round trip, not about internal shapes.
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { createArchive } from "@/lib/archive/writer";
import { extractArchive } from "@/lib/archive/extract";
import { carryForward, fileKey } from "@/lib/archive/chain";
import { browseLevel } from "@/lib/archive/browse";
import {
    ArchiveIndex,
    ArchiveSourceEntry,
    IndexFileLine,
    isSymlinkLine,
    partitionSymlinks,
    SourceFileEntry,
} from "@/lib/archive/types";

const execFileAsync = promisify(execFile);

const SRC = "job-source-1";
const CERT_TARGET = "../../archive/npm-10/fullchain1.pem";
const MASTER_KEY = Buffer.alloc(32, 7);

async function tempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * The reported layout: real certificates in `archive/`, links to them in `live/`. Nginx
 * Proxy Manager reads the links, which is why losing them stops it from starting.
 */
async function buildLetsEncryptTree(root: string): Promise<void> {
    await fs.mkdir(path.join(root, "archive/npm-10"), { recursive: true });
    await fs.mkdir(path.join(root, "live/npm-10"), { recursive: true });
    await fs.writeFile(path.join(root, "archive/npm-10/fullchain1.pem"), "cert-bytes");
    await fs.symlink(CERT_TARGET, path.join(root, "live/npm-10/fullchain.pem"));
}

function sourceEntry(localPath: string, files: SourceFileEntry[]): ArchiveSourceEntry[] {
    return [{ kind: "directory", jobSourceId: SRC, label: "npm", localPath, excludePatterns: [], files }];
}

const CERT_FILE: SourceFileEntry = {
    path: "archive/npm-10/fullchain1.pem",
    size: 10,
    mtime: "2026-07-31T00:00:00.000Z",
};

const CERT_LINK: SourceFileEntry = {
    path: "live/npm-10/fullchain.pem",
    size: 0,
    mtime: "2026-07-31T00:00:00.000Z",
    linkTarget: CERT_TARGET,
};

describe("symbolic links in the archive format", () => {
    it("survives an unencrypted round trip and is readable by a foreign tar", async () => {
        const tmp = await tempDir("sym-plain-");
        const source = path.join(tmp, "src");
        await buildLetsEncryptTree(source);
        const archivePath = path.join(tmp, "backup.tar");

        const { manifest, index } = await createArchive(
            sourceEntry(source, [CERT_FILE, CERT_LINK]),
            archivePath,
            { sourceType: "directory-only" }
        );

        expect(manifest.counts.symlinks).toBe(1);
        expect(manifest.counts.files, "a link is one of the source's files").toBe(2);

        const link = index.files.find((f) => f.p === CERT_LINK.path)!;
        expect(link.lnk).toBe(CERT_TARGET);
        expect(link.s).toBe(0);
        expect(link.n, "a link has no payload, so it points at no entry").toBeUndefined();

        // The promise that an unencrypted archive needs no DBackup to unpack has to hold for
        // links too, or `tar -xf` produces a tree that is missing them.
        const { stdout } = await execFileAsync("tar", ["-tvf", archivePath]);
        expect(stdout).toMatch(
            new RegExp(`^l.*live/npm-10/fullchain\\.pem -> ${CERT_TARGET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m")
        );

        const out = path.join(tmp, "out");
        await extractArchive(archivePath, out);
        const restored = path.join(out, "sources", SRC, CERT_LINK.path);

        expect((await fs.lstat(restored)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(restored), "a relative target has to stay relative").toBe(CERT_TARGET);
        expect(await fs.readFile(restored, "utf-8"), "and still resolve to the real file").toBe("cert-bytes");
    });

    it("keeps the target out of the clear in an encrypted archive", async () => {
        const tmp = await tempDir("sym-enc-");
        const source = path.join(tmp, "src");
        await buildLetsEncryptTree(source);
        const archivePath = path.join(tmp, "backup.tar");

        await createArchive(sourceEntry(source, [CERT_FILE, CERT_LINK]), archivePath, {
            sourceType: "directory-only",
            encryption: { masterKey: MASTER_KEY, profileId: "p1" },
        });

        // A link target is a path, and a tar header is cleartext. Writing one there would
        // publish user data right next to the entries that exist to hide exactly that.
        const raw = await fs.readFile(archivePath);
        expect(raw.includes(Buffer.from(CERT_TARGET)), "the target must live only in the sealed index").toBe(false);
        expect(raw.includes(Buffer.from("live/npm-10")), "member names stay opaque as well").toBe(false);

        const out = path.join(tmp, "out");
        await extractArchive(archivePath, out, { masterKey: MASTER_KEY });
        expect(await fs.readlink(path.join(out, "sources", SRC, CERT_LINK.path))).toBe(CERT_TARGET);
    });

    it("stores a link to a directory without descending into it", async () => {
        const tmp = await tempDir("sym-dir-");
        const source = path.join(tmp, "src");
        await fs.mkdir(path.join(source, "real"), { recursive: true });
        await fs.writeFile(path.join(source, "real/inside.txt"), "x");
        await fs.symlink("real", path.join(source, "alias"));

        const archivePath = path.join(tmp, "backup.tar");
        await createArchive(
            sourceEntry(source, [
                { path: "real/inside.txt", size: 1, mtime: "2026-07-31T00:00:00.000Z" },
                { path: "alias", size: 0, mtime: "2026-07-31T00:00:00.000Z", linkTarget: "real" },
            ]),
            archivePath,
            { sourceType: "directory-only" }
        );

        const out = path.join(tmp, "out");
        await extractArchive(archivePath, out);
        const root = path.join(out, "sources", SRC);

        expect((await fs.lstat(path.join(root, "alias"))).isSymbolicLink()).toBe(true);
        // Stored once, as a link. Following it would have written the target's bytes a second
        // time under the link's own path.
        expect(await fs.readFile(path.join(root, "alias/inside.txt"), "utf-8")).toBe("x");
    });

    it("preserves a dangling link rather than dropping it", async () => {
        const tmp = await tempDir("sym-dangling-");
        const source = path.join(tmp, "src");
        await fs.mkdir(source, { recursive: true });
        await fs.symlink("./gone.pem", path.join(source, "broken.pem"));

        const archivePath = path.join(tmp, "backup.tar");
        await createArchive(
            sourceEntry(source, [
                { path: "broken.pem", size: 0, mtime: "2026-07-31T00:00:00.000Z", linkTarget: "./gone.pem" },
            ]),
            archivePath,
            { sourceType: "directory-only" }
        );

        const out = path.join(tmp, "out");
        await extractArchive(archivePath, out);
        const restored = path.join(out, "sources", SRC, "broken.pem");

        // A broken link is part of the source's state. Silently repairing or omitting it would
        // make the restore differ from what was backed up.
        expect((await fs.lstat(restored)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(restored)).toBe("./gone.pem");
    });

    it("does not let a link redirect a file write outside the output directory", async () => {
        const tmp = await tempDir("sym-traversal-");
        const source = path.join(tmp, "src");
        const escapeTarget = path.join(tmp, "escaped");
        await fs.mkdir(path.join(source, "foo"), { recursive: true });
        await fs.mkdir(escapeTarget, { recursive: true });
        await fs.writeFile(path.join(source, "foo/x"), "payload");

        // The classic tar symlink traversal: a link aimed outside, followed by a file written
        // "underneath" it. Both paths pass a string-based containment check.
        const archivePath = path.join(tmp, "backup.tar");
        await createArchive(
            sourceEntry(source, [
                { path: "foo", size: 0, mtime: "2026-07-31T00:00:00.000Z", linkTarget: escapeTarget },
                { path: "foo/x", size: 7, mtime: "2026-07-31T00:00:00.000Z" },
            ]),
            archivePath,
            { sourceType: "directory-only" }
        );

        const out = path.join(tmp, "out");
        const result = await extractArchive(archivePath, out);

        // Links are created only after every regular file, so at the moment `foo/x` was
        // written no link existed for it to travel through.
        expect(
            await fs.readdir(escapeTarget),
            "nothing may be written outside the extraction root"
        ).toEqual([]);
        expect(await fs.readFile(path.join(out, "sources", SRC, "foo/x"), "utf-8")).toBe("payload");

        // The link then collides with the real directory the file created. Restored data wins,
        // the link is reported, and the rest of the extraction is unaffected.
        expect(result.skippedSymlinks).toEqual([
            { path: "foo", reason: "a file or directory was restored to that path" },
        ]);
    });

    it("keeps extracting when one link cannot be created", async () => {
        const tmp = await tempDir("sym-partial-");
        const source = path.join(tmp, "src");
        await fs.mkdir(path.join(source, "dir"), { recursive: true });
        await fs.writeFile(path.join(source, "dir/keep.txt"), "kept");

        const archivePath = path.join(tmp, "backup.tar");
        await createArchive(
            sourceEntry(source, [
                { path: "dir/keep.txt", size: 4, mtime: "2026-07-31T00:00:00.000Z" },
                // Collides with the directory above, so this one cannot be created.
                { path: "dir", size: 0, mtime: "2026-07-31T00:00:00.000Z", linkTarget: "./elsewhere" },
                { path: "ok.pem", size: 0, mtime: "2026-07-31T00:00:00.000Z", linkTarget: "./dir/keep.txt" },
            ]),
            archivePath,
            { sourceType: "directory-only" }
        );

        const out = path.join(tmp, "out");
        const result = await extractArchive(archivePath, out);
        const root = path.join(out, "sources", SRC);

        expect(result.skippedSymlinks.map((s) => s.path)).toEqual(["dir"]);
        expect(await fs.readFile(path.join(root, "dir/keep.txt"), "utf-8")).toBe("kept");
        expect(await fs.readlink(path.join(root, "ok.pem")), "later links still get created").toBe("./dir/keep.txt");
    });

    it("restates links in an incremental chain instead of carrying them forward", () => {
        const linkLine: IndexFileLine = {
            k: "f", src: SRC, p: CERT_LINK.path, s: 0, m: CERT_LINK.mtime, lnk: CERT_TARGET,
        };
        const fileLine: IndexFileLine = {
            k: "f", src: SRC, p: CERT_FILE.path, s: 10, m: CERT_FILE.mtime, h: "abc", n: 1,
        };

        const previous: ArchiveIndex = {
            header: { k: "h", v: 2, createdAt: CERT_FILE.mtime, archive: "full-000.tar" },
            entries: new Map([["#1", { k: "e", n: 1, member: "d/000001", off: 1024, size: 10 }]]),
            databases: [],
            directories: [{ k: "d", src: SRC, label: "npm", fileCount: 2, totalSize: 10, excludePatterns: [] }],
            files: [fileLine, linkLine],
            deps: [],
        };

        // Both are asked for. Only the file may come back: a link has no bytes anywhere to
        // point at, and looking one up would resolve ordinal `undefined`.
        const keep = new Set([fileKey(SRC, CERT_FILE.path), fileKey(SRC, CERT_LINK.path)]);
        const carried = carryForward(previous, "full-000.tar", keep);

        expect(carried.files.map((f) => f.p)).toEqual([CERT_FILE.path]);
        expect(carried.entries).toHaveLength(1);
    });

    it("separates links from payload lines for the restore paths", () => {
        const link: IndexFileLine = { k: "f", src: SRC, p: "a", s: 0, m: CERT_FILE.mtime, lnk: "./b" };
        const file: IndexFileLine = { k: "f", src: SRC, p: "b", s: 2, m: CERT_FILE.mtime, n: 1 };

        expect(isSymlinkLine(link)).toBe(true);
        expect(isSymlinkLine(file)).toBe(false);

        const { payloads, symlinks } = partitionSymlinks([{ file: link, src: SRC }, { file, src: SRC }]);
        expect(payloads.map((p) => p.file.p)).toEqual(["b"]);
        expect(symlinks.map((s) => s.file.lnk)).toEqual(["./b"]);
    });

    it("shows a link in the browse tree with its target", () => {
        const index = {
            files: [
                { k: "f", src: SRC, p: "live/cert.pem", s: 0, m: CERT_FILE.mtime, lnk: CERT_TARGET },
                { k: "f", src: SRC, p: "live/real.pem", s: 12, m: CERT_FILE.mtime, n: 1 },
            ],
        } as ArchiveIndex;

        const entries = browseLevel(index, SRC, "live");
        expect(entries.find((e) => e.name === "cert.pem")?.link).toBe(CERT_TARGET);
        expect(entries.find((e) => e.name === "real.pem")?.link).toBeUndefined();
    });
});
