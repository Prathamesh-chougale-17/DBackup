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
import { promisify } from "node:util";
import { registerAdapters } from "@/lib/adapters";
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
