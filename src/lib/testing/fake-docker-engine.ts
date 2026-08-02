import { Readable } from "node:stream";
import type { ContainerInfo, DockerEngine, VolumeInfo } from "@/lib/adapters/storage/docker/engine/types";

/**
 * An in-memory Docker daemon for unit tests.
 *
 * Typed as `DockerEngine` on purpose: adding a method to the port has to break this file at
 * compile time rather than leave every test running against a stale fake. This is the pay-off
 * the port was introduced for - the grouping, the stop bookkeeping and the orphan recovery
 * are all testable against fourteen plain methods instead of a mock reproducing dockerode's
 * `getVolume(...).remove()` and `container.getArchive()`.
 */

export interface FakeContainer {
    id: string;
    name: string;
    running: boolean;
    /** Volumes this container holds. */
    volumes: string[];
    labels?: Record<string, string>;
}

export interface FakeDockerOptions {
    volumes?: string[];
    containers?: FakeContainer[];
    /** Throws instead of doing the thing, keyed by method name. */
    failOn?: Partial<Record<keyof DockerEngine, Error>>;
}

export interface FakeDockerCalls {
    /** Every mutation in order, so a test can assert on sequence and not just on counts. */
    order: string[];
    stopped: string[];
    started: string[];
    created: Array<{ id: string; volumes: string[]; image: string; labels: Record<string, string> }>;
    removed: string[];
    exported: Array<{ containerId: string; path: string }>;
    emptied: string[];
    closed: number;
}

export interface FakeDockerEngine extends DockerEngine {
    readonly calls: FakeDockerCalls;
    /** Current state, for assertions about what the daemon ended up like. */
    readonly containers: FakeContainer[];
}

export function createFakeDockerEngine(options: FakeDockerOptions = {}): FakeDockerEngine {
    const containers: FakeContainer[] = (options.containers ?? []).map((c) => ({ ...c }));
    const volumes = new Set(options.volumes ?? []);
    let created = 0;

    const calls: FakeDockerCalls = {
        order: [], stopped: [], started: [], created: [], removed: [], exported: [], emptied: [], closed: 0,
    };

    const failIfAsked = (method: keyof DockerEngine) => {
        const failure = options.failOn?.[method];
        if (failure) throw failure;
    };

    const toInfo = (c: FakeContainer): ContainerInfo => ({
        id: c.id, name: c.name, running: c.running, labels: c.labels ?? {},
    });

    const engine: FakeDockerEngine = {
        label: "fake://docker",
        calls,
        containers,

        async version() {
            failIfAsked("version");
            return { version: "27.0.0", apiVersion: "1.46" };
        },

        async listVolumes(): Promise<VolumeInfo[]> {
            failIfAsked("listVolumes");
            return [...volumes].map((name) => ({ name, driver: "local", labels: {} }));
        },

        async inspectVolume(name) {
            failIfAsked("inspectVolume");
            return volumes.has(name) ? { name, driver: "local", labels: {} } : null;
        },

        async createVolume(name) {
            failIfAsked("createVolume");
            calls.order.push(`createVolume:${name}`);
            volumes.add(name);
        },

        async emptyVolume(name) {
            failIfAsked("emptyVolume");
            calls.order.push(`emptyVolume:${name}`);
            calls.emptied.push(name);
        },

        async containersUsingVolume(name) {
            failIfAsked("containersUsingVolume");
            return containers.filter((c) => c.volumes.includes(name)).map(toInfo);
        },

        async stopContainer(id) {
            failIfAsked("stopContainer");
            calls.order.push(`stop:${id}`);
            calls.stopped.push(id);
            const container = containers.find((c) => c.id === id);
            if (container) container.running = false;
        },

        async startContainer(id) {
            failIfAsked("startContainer");
            calls.order.push(`start:${id}`);
            calls.started.push(id);
            const container = containers.find((c) => c.id === id);
            if (container) container.running = true;
        },

        async createMountContainer(mounted, image, labels) {
            failIfAsked("createMountContainer");
            const id = `helper-${++created}`;
            calls.order.push(`create:${id}`);
            calls.created.push({ id, volumes: [...mounted], image, labels });
            containers.push({ id, name: id, running: false, volumes: [...mounted], labels });
            return id;
        },

        async removeMountContainer(id) {
            failIfAsked("removeMountContainer");
            calls.order.push(`remove:${id}`);
            calls.removed.push(id);
            const index = containers.findIndex((c) => c.id === id);
            if (index >= 0) containers.splice(index, 1);
        },

        async findLabelledContainers(labelKey) {
            failIfAsked("findLabelledContainers");
            return containers.filter((c) => c.labels?.[labelKey] !== undefined).map(toInfo);
        },

        async exportPath(containerId, path) {
            failIfAsked("exportPath");
            calls.exported.push({ containerId, path });
            return Readable.from([]);
        },

        async importPath() {
            failIfAsked("importPath");
        },

        async close() {
            calls.closed++;
        },
    };

    return engine;
}
