/**
 * Preparing and releasing a group of Docker volumes.
 *
 * The order is the part that matters. Containers come down before the helper goes up and
 * back up after it comes down, and every failure in between still has to leave the user's
 * services running. The worst outcome this feature has is a database left stopped with
 * nothing recording that it used to be running, so most of what follows is about that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDockerEngine, type FakeContainer, type FakeDockerEngine } from "@/lib/testing/fake-docker-engine";

const connectDocker = vi.fn();
vi.mock("@/lib/adapters/storage/docker/engine/connect", () => ({
    connectDocker: (config: unknown) => connectDocker(config),
    DEFAULT_SOCKET_PATH: "/var/run/docker.sock",
}));

vi.mock("@/lib/logging/logger", () => ({
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const {
    createDockerSnapshot,
    releaseDockerSnapshot,
    findOrphanedDockerSnapshots,
} = await import("@/lib/adapters/storage/docker/snapshot");

const config = { connectionMode: "direct", helperImage: "alpine:3" };
const container = (id: string, volumes: string[], running = true, labels?: Record<string, string>): FakeContainer =>
    ({ id, name: id, running, volumes, ...(labels ? { labels } : {}) });

/** Points every connection at one fake daemon, and counts how many were opened. */
function useEngine(engine: FakeDockerEngine) {
    connectDocker.mockImplementation(() => ({ engine, close: async () => { await engine.close(); } }));
    return engine;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("createDockerSnapshot", () => {
    it("stops the containers before creating the helper", async () => {
        // A helper mounted while the database is still writing would read a torn volume,
        // which is the whole thing the stop exists to prevent.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"])],
        }));

        await createDockerSnapshot(config, ["v-web"], { stopContainers: true });

        expect(engine.calls.order).toEqual(["stop:web", "create:helper-1"]);
    });

    it("mounts every volume of the group into one helper", async () => {
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web", "v-cache"],
            containers: [container("web", ["v-web", "v-cache"])],
        }));

        await createDockerSnapshot(config, ["v-web", "v-cache"], { stopContainers: true });

        expect(engine.calls.created).toHaveLength(1);
        expect(engine.calls.created[0].volumes).toEqual(["v-web", "v-cache"]);
        expect(engine.calls.created[0].image).toBe("alpine:3");
    });

    it("stops a container holding two of the group's volumes exactly once", async () => {
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-a", "v-b"],
            containers: [container("web", ["v-a", "v-b"])],
        }));

        await createDockerSnapshot(config, ["v-a", "v-b"], { stopContainers: true });

        expect(engine.calls.stopped).toEqual(["web"]);
    });

    it("leaves a container that was already stopped alone", async () => {
        // It must still be stopped afterwards. Starting something the user switched off is
        // as wrong as leaving something down that they had running.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"], false)],
        }));

        const handle = await createDockerSnapshot(config, ["v-web"], { stopContainers: true });
        await releaseDockerSnapshot(config, handle);

        expect(engine.calls.stopped).toEqual([]);
        expect(engine.calls.started).toEqual([]);
    });

    it("stops nothing when the source forbids it, but still prepares the helper", async () => {
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-live"],
            containers: [container("web", ["v-live"])],
        }));

        await createDockerSnapshot(config, ["v-live"], { stopContainers: false });

        expect(engine.calls.stopped).toEqual([]);
        expect(engine.calls.created).toHaveLength(1);
    });

    it("starts the containers again when creating the helper fails", async () => {
        // The failure path that would otherwise leave a service down: everything stopped,
        // and then the one thing that needed it never got made.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"])],
            failOn: { createMountContainer: new Error("No such image: alpine:3") },
        }));

        await expect(createDockerSnapshot(config, ["v-web"], { stopContainers: true }))
            .rejects.toThrow(/only has to exist on the Docker host/);

        expect(engine.calls.started).toEqual(["web"]);
    });

    it("starts back what it already stopped when a later stop fails", async () => {
        const engine = createFakeDockerEngine({
            volumes: ["v-a", "v-b"],
            containers: [container("first", ["v-a"]), container("second", ["v-b"])],
        });
        let stops = 0;
        const realStop = engine.stopContainer.bind(engine);
        engine.stopContainer = async (id: string) => {
            if (++stops === 2) throw new Error("container is restarting");
            await realStop(id);
        };
        useEngine(engine);

        await expect(createDockerSnapshot(config, ["v-a", "v-b"], { stopContainers: true })).rejects.toThrow();

        expect(engine.calls.started).toEqual(["first"]);
    });
});

describe("releaseDockerSnapshot", () => {
    it("removes the helper and then starts the containers", async () => {
        // Helper first: it holds nothing anyone is waiting for, and a container left down
        // is the failure that matters.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"])],
        }));

        const handle = await createDockerSnapshot(config, ["v-web"], { stopContainers: true });
        await releaseDockerSnapshot(config, handle);

        expect(engine.calls.order).toEqual(["stop:web", "create:helper-1", "remove:helper-1", "start:web"]);
    });

    it("starts the containers even when removing the helper fails", async () => {
        const engine = createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"])],
        });
        useEngine(engine);
        const handle = await createDockerSnapshot(config, ["v-web"], { stopContainers: true });
        engine.removeMountContainer = async () => { throw new Error("device or resource busy"); };

        await releaseDockerSnapshot(config, handle);

        expect(engine.calls.started).toEqual(["web"]);
    });

    it("does nothing on a second release", async () => {
        // The interface requires tolerating a snapshot that is already gone, and the runner
        // relies on it: the collection releases early and cleanup releases again.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"])],
        }));

        const handle = await createDockerSnapshot(config, ["v-web"], { stopContainers: true });
        await releaseDockerSnapshot(config, handle);
        await releaseDockerSnapshot(config, handle);

        expect(engine.calls.started).toEqual(["web"]);
        expect(engine.calls.removed).toEqual(["helper-1"]);
    });
});

describe("orphan recovery", () => {
    /** A helper container left behind by a run that was killed mid-backup. */
    const leftover = () => container("helper-old", ["v-web"], false, {
        "com.dbackup.temp": "1",
        "com.dbackup.execution": "old-run",
        "com.dbackup.stopped": "web",
    });

    it("starts the containers a dead run had stopped", async () => {
        // The only path that can undo a SIGKILL, and it works because the pre-stop state was
        // written onto the Docker host rather than kept in memory.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"], false), leftover()],
        }));

        await createDockerSnapshot(config, ["v-web"], { stopContainers: true });

        expect(engine.calls.started).toContain("web");
        expect(engine.calls.removed).toContain("helper-old");
    });

    it("starts them before removing the record of what to start", async () => {
        // Removing first and then failing to start would throw away the only note of what
        // has to come back up.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"], false), leftover()],
        }));

        await createDockerSnapshot(config, ["v-web"], { stopContainers: true });

        expect(engine.calls.order.indexOf("start:web")).toBeLessThan(engine.calls.order.indexOf("remove:helper-old"));
    });

    it("never touches a helper this process is currently using", async () => {
        // Two jobs can run at once. Treating the other one's helper as a leftover would
        // restart its containers underneath it - a cleanup causing the exact failure it
        // exists to repair.
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-a", "v-b"],
            containers: [container("a", ["v-a"]), container("b", ["v-b"])],
        }));

        const first = await createDockerSnapshot(config, ["v-a"], { stopContainers: true });
        await createDockerSnapshot(config, ["v-b"], { stopContainers: true });

        // The second preparation swept for orphans and must have left the first alone.
        expect(engine.calls.removed).not.toContain(first.id);
        expect(engine.calls.started).not.toContain("a");
    });

    it("reports leftovers as handles the runner can release", async () => {
        const engine = useEngine(createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"], false), leftover()],
        }));

        const handles = await findOrphanedDockerSnapshots(config);

        expect(handles.map((h) => h.id)).toEqual(["helper-old"]);
        await releaseDockerSnapshot(config, handles[0]);
        expect(engine.calls.started).toContain("web");
    });

    it("does not fail the backup when a leftover cannot be cleaned up", async () => {
        // A leftover helper is harmless. Refusing to back anything up because of one would
        // turn a cosmetic problem into a missed backup.
        const engine = createFakeDockerEngine({
            volumes: ["v-web"],
            containers: [container("web", ["v-web"]), leftover()],
        });
        engine.removeMountContainer = async (id: string) => {
            if (id === "helper-old") throw new Error("permission denied");
        };
        useEngine(engine);

        await expect(createDockerSnapshot(config, ["v-web"], { stopContainers: true })).resolves.toBeDefined();
    });
});
