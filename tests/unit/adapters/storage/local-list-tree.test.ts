/**
 * The Local adapter's collection walker.
 *
 * Separate from `list()` on purpose, and these assertions pin that separation down: `list()`
 * also serves retention, integrity checks and the destination browser, where a symbolic link
 * has no meaning and where changing what comes back would change what retention deletes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { LocalFileSystemAdapter } from "@/lib/adapters/storage/local";

let root: string;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "local-tree-"));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

/** Sorted paths, so assertions do not depend on directory read order. */
function paths(files: { path: string }[]): string[] {
    return files.map((f) => f.path.replace(/\\/g, "/")).sort();
}

describe("LocalFileSystemAdapter.listTree", () => {
    it("records a file symlink with its raw target", async () => {
        await fs.mkdir(path.join(root, "archive"), { recursive: true });
        await fs.mkdir(path.join(root, "live"), { recursive: true });
        await fs.writeFile(path.join(root, "archive/cert1.pem"), "cert");
        await fs.symlink("../archive/cert1.pem", path.join(root, "live/cert.pem"));

        const { files } = await LocalFileSystemAdapter.listTree!({ basePath: root }, "");

        expect(paths(files)).toEqual(["archive/cert1.pem", "live/cert.pem"]);
        const link = files.find((f) => f.path.replace(/\\/g, "/") === "live/cert.pem")!;
        expect(link.linkTarget, "the target stays exactly as stored, still relative").toBe("../archive/cert1.pem");
        expect(link.size, "a link's own byte count says nothing about the backup").toBe(0);

        const real = files.find((f) => f.path.replace(/\\/g, "/") === "archive/cert1.pem")!;
        expect(real.linkTarget).toBeUndefined();
    });

    it("records a directory symlink without descending into it", async () => {
        await fs.mkdir(path.join(root, "real/nested"), { recursive: true });
        await fs.writeFile(path.join(root, "real/nested/inside.txt"), "x");
        await fs.symlink("real", path.join(root, "alias"));

        const { files } = await LocalFileSystemAdapter.listTree!({ basePath: root }, "");

        // The link is one entry. Walking through it would list the same bytes twice, under two
        // different paths, and turn a source that shares data into one that duplicates it.
        expect(paths(files)).toEqual(["alias", "real/nested/inside.txt"]);
        expect(files.find((f) => f.path === "alias")!.linkTarget).toBe("real");
    });

    it("keeps a dangling symlink", async () => {
        await fs.symlink("./gone.pem", path.join(root, "broken.pem"));

        const { files } = await LocalFileSystemAdapter.listTree!({ basePath: root }, "");

        // A broken link is part of the source's state. Dropping it would make the restored
        // tree differ from what was backed up.
        expect(paths(files)).toEqual(["broken.pem"]);
        expect(files[0].linkTarget).toBe("./gone.pem");
    });

    it("prunes an excluded directory instead of listing it", async () => {
        await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.writeFile(path.join(root, "node_modules/pkg/index.js"), "junk");
        await fs.writeFile(path.join(root, "src/app.ts"), "code");

        const { files, pruned } = await LocalFileSystemAdapter.listTree!(
            { basePath: root },
            "",
            { excludePatterns: ["node_modules/**"] }
        );

        expect(paths(files)).toEqual(["src/app.ts"]);
        expect(pruned).toEqual([{ path: "node_modules", pattern: "node_modules/**" }]);
    });

    it("leaves list() free of symlinks, since retention reads it too", async () => {
        await fs.writeFile(path.join(root, "backup.tar"), "data");
        await fs.symlink("backup.tar", path.join(root, "latest.tar"));

        const listed = await LocalFileSystemAdapter.list({ basePath: root }, "");

        expect(paths(listed)).toEqual(["backup.tar"]);
    });

    it("stops when the signal is aborted", async () => {
        await fs.writeFile(path.join(root, "a.txt"), "a");
        const controller = new AbortController();
        controller.abort();

        await expect(
            LocalFileSystemAdapter.listTree!({ basePath: root }, "", { signal: controller.signal })
        ).rejects.toThrow();
    });
});

describe("LocalFileSystemAdapter.createSymlink", () => {
    it("recreates a link with its target untouched", async () => {
        await LocalFileSystemAdapter.createSymlink!({ basePath: root }, "live/cert.pem", "../archive/cert1.pem");

        const created = path.join(root, "live/cert.pem");
        expect((await fs.lstat(created)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(created)).toBe("../archive/cert1.pem");
    });

    it("replaces an existing link without touching what it pointed at", async () => {
        await fs.writeFile(path.join(root, "old-target.txt"), "keep me");
        await fs.symlink("old-target.txt", path.join(root, "link"));

        await LocalFileSystemAdapter.createSymlink!({ basePath: root }, "link", "new-target.txt");

        expect(await fs.readlink(path.join(root, "link"))).toBe("new-target.txt");
        // Re-running a restore must never delete real data through a stale link.
        expect(await fs.readFile(path.join(root, "old-target.txt"), "utf-8")).toBe("keep me");
    });

    it("refuses a path that escapes the configured root", async () => {
        await expect(
            LocalFileSystemAdapter.createSymlink!({ basePath: root }, "../escaped", "whatever")
        ).rejects.toThrow(/Access denied/);
    });
});
