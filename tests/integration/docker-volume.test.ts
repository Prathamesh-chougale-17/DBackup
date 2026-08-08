/**
 * Docker volume adapter against a real daemon.
 *
 * This suite exists for the chain no unit test can reach: standard transport resolution, a
 * DirectHost, `connectSocket`, the custom HTTP agent carrying dockerode over an arbitrary
 * stream, and the daemon itself. Every one of those is new, and mocking any of them proves
 * nothing about the others.
 *
 * Skips cleanly when no daemon is reachable rather than failing a suite that cannot run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { registerAdapters } from "@/lib/adapters";
import { dockerSshConfig, sshHostAvailable } from "./test-configs";
import { registry } from "@/lib/core/registry";
import { connectDocker } from "@/lib/adapters/storage/docker/engine/connect";
import { noopHost } from "@/lib/testing/fake-host";
import type { StorageAdapter } from "@/lib/core/interfaces";
import type { DockerEngine } from "@/lib/adapters/storage/docker/engine/types";

const execFileAsync = promisify(execFile);
registerAdapters();

const PREFIX = "dbackup-it";
const HELPER_IMAGE = "alpine:3";

/** Docker Desktop on macOS puts the socket under the user's home rather than /var/run. */
const SOCKET_PATH = process.env.DOCKER_SOCK
    ?? (process.platform === "darwin" ? `${process.env.HOME}/.docker/run/docker.sock` : "/var/run/docker.sock");

const config = { connectionMode: "direct", socketPath: SOCKET_PATH };
const adapter = () => registry.get("docker-volume") as StorageAdapter;

/**
 * Removing a volume goes through the CLI, not the engine.
 *
 * DBackup never deletes a user's volume, so `DockerEngine` has no method for it, and adding
 * one that only tests call would put a destructive operation into the port for the shape of
 * it. Cleanup is a test concern and uses a test tool.
 */
async function removeVolume(name: string): Promise<void> {
    await execFileAsync("docker", ["volume", "rm", "-f", name]).catch(() => { });
}

let available = false;
let engine: DockerEngine;
let closeEngine: () => Promise<void>;

beforeAll(async () => {
    const connection = connectDocker(config);
    engine = connection.engine;
    closeEngine = connection.close;
    try {
        await engine.version();
        available = true;
    } catch {
        available = false;
    }
});

afterAll(async () => {
    await closeEngine?.().catch(() => { });
});

describe("Docker volume adapter", () => {
    it("reports the engine version through test()", async () => {
        if (!available) return;

        const result = await adapter().test!(config, noopHost());

        expect(result.success).toBe(true);
        expect(result.message).toMatch(/Connected to Docker/);
        expect(result.version).toMatch(/^\d+\./);
    });

    it("answers ping() without listing anything", async () => {
        if (!available) return;

        const result = await adapter().ping!(config, noopHost());

        expect(result.success).toBe(true);
    });

    it("lists a volume through browseDirectories()", async () => {
        if (!available) return;
        const name = `${PREFIX}-browse`;
        await engine.createVolume(name);

        try {
            const entries = await adapter().browseDirectories!(config, "");

            expect(entries.map((e) => e.name)).toContain(name);
            // The path is what a job source stores, and for a volume it is the name itself.
            expect(entries.find((e) => e.name === name)?.path).toBe(name);
        } finally {
            await removeVolume(name);
        }
    });

    it("returns nothing below the root, because a volume has no children", async () => {
        if (!available) return;

        expect(await adapter().browseDirectories!(config, "some-volume")).toEqual([]);
    });

    it("reports an unreachable host when browsing, rather than an empty list", async () => {
        // These are the two answers a person most needs to tell apart, and returning [] for
        // both meant "this Docker host cannot be reached" was shown as "it has no volumes".
        await expect(adapter().browseDirectories!(
            { connectionMode: "direct", socketPath: "/tmp/definitely-not-a-docker-socket" },
            "",
        )).rejects.toThrow(/socket was not found|ENOENT/);
    });

    it("reports a bad socket as a failed test rather than throwing", async () => {
        // The health check runs this every minute and treats a rejection very differently
        // from `{ success: false }` - this is the line between "offline" and a crashed task.
        const result = await adapter().test!(
            { connectionMode: "direct", socketPath: "/tmp/definitely-not-a-docker-socket" },
            noopHost(),
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/socket was not found|ENOENT/);
    });
});

describe("Docker engine primitives", () => {
    it("finds the containers using a volume, and whether they are running", async () => {
        if (!available) return;
        const name = `${PREFIX}-inuse`;
        await engine.createVolume(name);
        let containerId: string | undefined;

        try {
            // A created-but-never-started container still counts as using the volume, which
            // is what makes the stop bookkeeping possible at all.
            containerId = await engine.createMountContainer([name], HELPER_IMAGE, { "com.dbackup.test": "1" });

            const users = await engine.containersUsingVolume(name);

            expect(users.map((c) => c.id)).toContain(containerId);
            expect(users.find((c) => c.id === containerId)?.running).toBe(false);
        } finally {
            if (containerId) await engine.removeMountContainer(containerId).catch(() => { });
            await removeVolume(name);
        }
    });

    it("finds its own containers again by label, which is how a killed run recovers", async () => {
        if (!available) return;
        const name = `${PREFIX}-orphan`;
        await engine.createVolume(name);
        let containerId: string | undefined;

        try {
            containerId = await engine.createMountContainer([name], HELPER_IMAGE, {
                "com.dbackup.temp": "1",
                "com.dbackup.stopped": "abc,def",
            });

            const found = await engine.findLabelledContainers("com.dbackup.temp");

            const mine = found.find((c) => c.id === containerId);
            expect(mine).toBeDefined();
            // The pre-stop state has to survive on the host, because the process that knew
            // it may be gone.
            expect(mine!.labels["com.dbackup.stopped"]).toBe("abc,def");
        } finally {
            if (containerId) await engine.removeMountContainer(containerId).catch(() => { });
            await removeVolume(name);
        }
    });

    it("reports an absent volume as absent rather than failing", async () => {
        if (!available) return;

        expect(await engine.inspectVolume(`${PREFIX}-does-not-exist`)).toBeNull();
    });
});

describe("collecting a volume", () => {
    /** Fills a volume with the things that decide whether a restore is usable. */
    async function seed(name: string): Promise<void> {
        await engine.createVolume(name);
        await execFileAsync("docker", [
            "run", "--rm", "-v", `${name}:/vol`, HELPER_IMAGE, "sh", "-c",
            "mkdir -p /vol/sub /vol/skipme && "
            + "echo hello > /vol/plain.txt && "
            + "echo secret > /vol/sub/private.txt && chmod 0600 /vol/sub/private.txt && "
            + "echo owned > /vol/sub/owned.txt && chown 1234:5678 /vol/sub/owned.txt && "
            + "echo junk > /vol/skipme/cache.tmp && "
            + "ln -s plain.txt /vol/link",
        ]);
    }

    /** Prepares the volume the way a backup does, collects it, and always cleans up. */
    async function collect(
        name: string,
        localPath: string,
        excludePatterns?: string[],
        options?: Parameters<NonNullable<StorageAdapter["downloadDirectory"]>>[6],
        helperImage?: string,
    ) {
        const runConfig = helperImage ? { ...config, helperImage } : config;
        const handle = await adapter().createSnapshot!(runConfig, [name], { stopContainers: true });
        try {
            return await adapter().downloadDirectory!(
                { ...runConfig, ...handle.configOverride },
                name, localPath, excludePatterns, undefined, undefined, options,
            );
        } finally {
            await adapter().releaseSnapshot!(runConfig, handle);
        }
    }

    it("collects files, permissions, owners and symlinks", async () => {
        // The whole reason this feature needed the archive format extended: a data directory
        // restored without its mode and owner is one PostgreSQL will not start on.
        if (!available) return;
        const name = `${PREFIX}-collect`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-collect-"));
        await seed(name);

        try {
            const result = await collect(name, localPath);

            const byPath = new Map(result.entries.map((e) => [e.relativePath, e]));
            expect([...byPath.keys()].sort()).toEqual(
                ["link", "plain.txt", "skipme/cache.tmp", "sub/owned.txt", "sub/private.txt"],
            );

            expect(byPath.get("sub/private.txt")).toMatchObject({ mode: 0o600, uid: 0, gid: 0 });
            expect(byPath.get("sub/owned.txt")).toMatchObject({ uid: 1234, gid: 5678 });
            expect(byPath.get("link")).toMatchObject({ linkTarget: "plain.txt", size: 0 });

            // And the bytes really landed, under the path without the mount prefix.
            expect(await fs.readFile(path.join(localPath, "sub", "private.txt"), "utf8")).toBe("secret\n");
            expect(result.failures).toEqual([]);
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(name);
        }
    });

    it("does not write a symlink's target as a file", async () => {
        if (!available) return;
        const name = `${PREFIX}-links`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-links-"));
        await seed(name);

        try {
            await collect(name, localPath);
            // The index carries the target; nothing is collected under the link's own path.
            await expect(fs.lstat(path.join(localPath, "link"))).rejects.toThrow();
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(name);
        }
    });

    it("honours exclude patterns", async () => {
        if (!available) return;
        const name = `${PREFIX}-exclude`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-exclude-"));
        await seed(name);

        try {
            const result = await collect(name, localPath, ["*.tmp"]);

            expect(result.entries.map((e) => e.relativePath)).not.toContain("skipme/cache.tmp");
            expect(result.entries.map((e) => e.relativePath)).toContain("plain.txt");
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(name);
        }
    });

    it("marks a file as unchanged instead of storing it again", async () => {
        // An incremental run still has to describe the whole tree, so the entry is reported
        // with `unchanged` rather than left out - that is what carries it forward.
        if (!available) return;
        const name = `${PREFIX}-incremental`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-incremental-"));
        await seed(name);

        try {
            const result = await collect(name, localPath, undefined, {
                shouldDownload: (entry) => entry.relativePath !== "plain.txt",
            });

            const plain = result.entries.find((e) => e.relativePath === "plain.txt");
            expect(plain?.unchanged).toBe(true);
            await expect(fs.access(path.join(localPath, "plain.txt"))).rejects.toThrow();
            // Everything else did land.
            expect(await fs.readFile(path.join(localPath, "sub", "owned.txt"), "utf8")).toBe("owned\n");
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(name);
        }
    });

    it("counts the files before transferring, so progress has a denominator", async () => {
        // The helper is started once to count, and stays readable afterwards - a container
        // that has run and exited exports exactly like one that never started. Measured at
        // roughly 160 ms for 20,000 files against a three-second export of the same volume.
        if (!available) return;
        const name = `${PREFIX}-count`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-count-"));
        await seed(name);
        const seen: Array<{ processedFiles: number; totalFiles: number }> = [];

        try {
            const handle = await adapter().createSnapshot!(config, [name], { stopContainers: true });
            try {
                await adapter().downloadDirectory!(
                    { ...config, ...handle.configOverride }, name, localPath, undefined,
                    (_pb, _tb, processedFiles, totalFiles) => seen.push({ processedFiles, totalFiles }),
                );
            } finally {
                await adapter().releaseSnapshot!(config, handle);
            }

            // Four files and one symlink were seeded; the count includes links.
            expect(seen.at(-1)?.totalFiles).toBe(5);
            expect(seen.at(-1)!.processedFiles).toBeGreaterThan(0);
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(name);
        }
    });

    it("restores a volume so that its contents, permissions and owners come back", async () => {
        // The acceptance test for the whole feature. A data directory restored without its
        // mode and owner is one a database will not start on, so this is the assertion the
        // archive format was extended for.
        if (!available) return;
        const source = `${PREFIX}-rt-src`;
        const target = `${PREFIX}-rt-dst`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-roundtrip-"));
        await seed(source);

        try {
            const collected = await collect(source, localPath);

            const session = await adapter().openSession!(config);
            try {
                for (const entry of collected.entries) {
                    if (entry.linkTarget !== undefined) continue;
                    await session.upload(
                        path.join(localPath, entry.relativePath),
                        `${target}/${entry.relativePath}`,
                        undefined, undefined,
                        { mode: entry.mode, uid: entry.uid, gid: entry.gid },
                    );
                }
                // Nothing here restores the symlink: the adapter declares no createSymlink,
                // so the restore reports links as skipped. See the assertion below.
            } finally {
                await session.close();
            }

            const listing = await execFileAsync("docker", [
                "run", "--rm", "-v", `${target}:/vol`, HELPER_IMAGE, "sh", "-c",
                // No `readlink` here: the link is deliberately not restored, so asking for it
                // would fail the command rather than the assertion.
                "cd /vol && ls -lnR . && echo '---' && cat sub/private.txt",
            ]);

            expect(listing.stdout).toMatch(/-rw-------\s+1\s+0\s+0\s+.*private\.txt/);
            expect(listing.stdout).toMatch(/-rw-r--r--\s+1\s+1234\s+5678\s+.*owned\.txt/);
            expect(listing.stdout).toContain("secret");
            expect(listing.stdout).toContain("plain.txt");
            // The symlink was collected - it is in the backup and restores to a local path
            // or over SFTP - but a Docker volume declares it cannot hold one, so nothing was
            // written for it here. Matched on the arrow `ls -l` prints for a link, so this
            // cannot pass by accident on a name that appears elsewhere in the listing.
            expect(collected.entries.some((e) => e.linkTarget !== undefined)).toBe(true);
            expect(listing.stdout).not.toMatch(/link -> /);
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(source);
            await removeVolume(target);
        }
    });

    it("empties an existing volume before restoring into it", async () => {
        // "Overwrite" has to mean the backup's state, not a merge of two. For a database a
        // leftover file from the old contents is not a stale file, it is a corrupt directory.
        if (!available) return;
        const target = `${PREFIX}-rt-wipe`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-wipe-"));

        try {
            await engine.createVolume(target);
            await execFileAsync("docker", [
                "run", "--rm", "-v", `${target}:/vol`, HELPER_IMAGE, "sh", "-c",
                "echo stale > /vol/leftover.txt && mkdir -p /vol/olddir && echo x > /vol/olddir/y.txt",
            ]);
            await fs.writeFile(path.join(localPath, "fresh.txt"), "new\n");

            const session = await adapter().openSession!(config);
            try {
                await session.upload(path.join(localPath, "fresh.txt"), `${target}/fresh.txt`);
            } finally {
                await session.close();
            }

            const listing = await execFileAsync("docker", [
                "run", "--rm", "-v", `${target}:/vol`, HELPER_IMAGE, "sh", "-c", "ls -A /vol",
            ]);
            expect(listing.stdout.trim().split("\n").sort()).toEqual(["fresh.txt"]);
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(target);
        }
    });

    it("creates a volume that does not exist yet", async () => {
        if (!available) return;
        const target = `${PREFIX}-rt-new`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-new-"));

        try {
            await fs.writeFile(path.join(localPath, "a.txt"), "hello\n");
            const session = await adapter().openSession!(config);
            try {
                await session.upload(path.join(localPath, "a.txt"), `${target}/nested/a.txt`);
            } finally {
                await session.close();
            }

            expect(await engine.inspectVolume(target)).not.toBeNull();
            const listing = await execFileAsync("docker", [
                "run", "--rm", "-v", `${target}:/vol`, HELPER_IMAGE, "cat", "/vol/nested/a.txt",
            ]);
            expect(listing.stdout).toBe("hello\n");
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(target);
        }
    });

    it("reports an existing volume as occupied and an absent one as empty", async () => {
        // What the restore's overwrite warning is built on.
        if (!available) return;
        const name = `${PREFIX}-rt-check`;
        await engine.createVolume(name);

        try {
            expect(await adapter().list(config, name)).toHaveLength(1);
            expect(await adapter().list(config, `${PREFIX}-rt-absent`)).toEqual([]);
        } finally {
            await removeVolume(name);
        }
    });

    it("refuses a per-file upload outside a session", async () => {
        // The fallback path in the restore would otherwise empty the volume before every write.
        if (!available) return;

        await expect(adapter().upload(config, "/tmp/x", "vol/x.txt"))
            .rejects.toThrow(/only be restored through a restore session/);
    });

    it("does the same round trip over SSH", async () => {
        // The only automated coverage of `connectSocket` over SSH against a real server.
        // Everything else on that path is tested with a mocked ssh2, which proves the call
        // is made and nothing about whether the daemon answers through an ssh2 channel.
        //
        // The ssh-host container has the test environment's own socket mounted, so this
        // drives the same daemon - the topology of a Docker host on another machine.
        if (!available || !sshHostAvailable) return;
        const source = `${PREFIX}-ssh-src`;
        const target = `${PREFIX}-ssh-dst`;
        const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-ssh-"));
        await seed(source);

        try {
            const test = await adapter().test!(dockerSshConfig, noopHost());
            expect(test.success).toBe(true);

            const handle = await adapter().createSnapshot!(dockerSshConfig, [source], { stopContainers: true });
            let collected;
            try {
                collected = await adapter().downloadDirectory!(
                    { ...dockerSshConfig, ...handle.configOverride }, source, localPath,
                );
            } finally {
                await adapter().releaseSnapshot!(dockerSshConfig, handle);
            }

            expect(collected.entries.map((e) => e.relativePath).sort()).toContain("sub/private.txt");

            const session = await adapter().openSession!(dockerSshConfig);
            try {
                for (const e of collected.entries) {
                    if (e.linkTarget !== undefined) continue;
                    await session.upload(
                        path.join(localPath, e.relativePath), `${target}/${e.relativePath}`,
                        undefined, undefined, { mode: e.mode, uid: e.uid, gid: e.gid },
                    );
                }
            } finally {
                await session.close();
            }

            const listing = await execFileAsync("docker", [
                "run", "--rm", "-v", `${target}:/vol`, HELPER_IMAGE, "sh", "-c", "ls -lnR /vol && cat /vol/sub/private.txt",
            ]);
            expect(listing.stdout).toMatch(/-rw-------\s+1\s+0\s+0\s+.*private\.txt/);
            expect(listing.stdout).toMatch(/-rw-r--r--\s+1\s+1234\s+5678\s+.*owned\.txt/);
            expect(listing.stdout).toContain("secret");
        } finally {
            await fs.rm(localPath, { recursive: true, force: true });
            await removeVolume(source);
            await removeVolume(target);
        }
    });

    it("refuses to collect a source with no prepared session", async () => {
        // A volume is only readable through a helper container. Reaching this without one
        // means something called the collection outside the runner's snapshot scope.
        if (!available) return;

        await expect(adapter().downloadDirectory!(config, "any-volume", "/tmp/nowhere"))
            .rejects.toThrow(/No prepared Docker session/);
    });

    it("reads a volume out of a container that was never started", async () => {
        // The finding the whole backup path rests on. If this ever stops holding, reading a
        // volume needs a startable image and a running process instead.
        if (!available) return;
        const name = `${PREFIX}-export`;
        await engine.createVolume(name);
        let containerId: string | undefined;

        try {
            await execFileAsync("docker", [
                "run", "--rm", "-v", `${name}:/vol`, HELPER_IMAGE,
                "sh", "-c", "echo hello > /vol/file.txt && chmod 0600 /vol/file.txt",
            ]);

            containerId = await engine.createMountContainer([name], HELPER_IMAGE, {});
            const stream = await engine.exportPath(containerId, `/vol/${name}`);

            const bytes = await new Promise<number>((resolve, reject) => {
                let total = 0;
                stream.on("data", (chunk: Buffer) => { total += chunk.length; });
                stream.on("end", () => resolve(total));
                stream.on("error", reject);
            });
            expect(bytes).toBeGreaterThan(0);
        } finally {
            if (containerId) await engine.removeMountContainer(containerId).catch(() => { });
            await removeVolume(name);
        }
    });
});
