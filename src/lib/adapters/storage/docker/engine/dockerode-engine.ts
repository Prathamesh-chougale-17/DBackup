/**
 * The one file that talks to dockerode.
 *
 * A lint guard holds that line. Without it the client leaks back into the rest of the
 * adapter within a couple of changes, which is not a guess: `shellEscape` spread across
 * eighteen adapter files exactly that way.
 */

import Docker from "dockerode";
import { Writable, type Duplex } from "node:stream";
import http from "node:http";

import type { ContainerInfo, DockerEngine, VolumeInfo } from "./types";

/** Where the mounted volumes appear inside a helper container. */
export const MOUNT_ROOT = "/vol";

/**
 * An http.Agent whose connections come from somewhere else entirely.
 *
 * This is what lets one dockerode client work over a local socket and over SSH without the
 * adapter knowing which: the ExecutionHost hands back a stream, and the agent hands it to
 * Node's HTTP client as if it had dialled it itself. Verified against a Duplex with none of
 * net.Socket's own methods, which is what an ssh2 channel looks like from here.
 */
class HostAgent extends http.Agent {
    constructor(private readonly open: () => Promise<Duplex>) {
        // Connections are not reused. Docker hijacks the socket for streaming endpoints, so
        // a pooled one can come back in a state the next request cannot use.
        super({ keepAlive: false });
    }

    // Node's declaration says this returns a socket synchronously or delivers one to the
    // callback. Ours can only be awaited, so it takes the callback path and returns nothing -
    // which is why the return type has to be widened rather than matched.
    createConnection(
        _options: http.ClientRequestArgs,
        callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
        this.open().then(
            (stream) => callback?.(null, stream),
            (err: Error) => callback?.(err, undefined as unknown as Duplex),
        );
        return undefined;
    }
}

export interface DockerodeEngineOptions {
    /** Opens a fresh connection to the daemon socket. Called once per request. */
    connect: () => Promise<Duplex>;
    /** Loggable endpoint description. Never contains credentials. */
    label: string;
    /** Closed when the engine is. Lets the caller tear down whatever backs `connect`. */
    onClose?: () => Promise<void>;
}

export function createDockerodeEngine(options: DockerodeEngineOptions): DockerEngine {
    const agent = new HostAgent(options.connect);
    // host and port are never dialled - the agent decides where a connection goes. They only
    // have to be present so docker-modem can build a request URL.
    const docker = new Docker({ agent, protocol: "http", host: "localhost", port: 80 } as never);
    let closed = false;

    const toVolume = (raw: {
        Name: string; Driver: string; Mountpoint?: string; Labels?: Record<string, string> | null;
    }): VolumeInfo => ({
        name: raw.Name,
        driver: raw.Driver,
        ...(raw.Mountpoint ? { mountpoint: raw.Mountpoint } : {}),
        labels: raw.Labels ?? {},
    });

    const toContainer = (raw: {
        Id: string; Names?: string[]; State?: string; Labels?: Record<string, string> | null;
    }): ContainerInfo => ({
        id: raw.Id,
        // Docker reports names with a leading slash, which no user ever types.
        name: (raw.Names?.[0] ?? raw.Id).replace(/^\//, ""),
        running: raw.State === "running",
        labels: raw.Labels ?? {},
    });

    return {
        label: options.label,

        async version() {
            const v = await docker.version();
            return { version: v.Version, apiVersion: v.ApiVersion };
        },

        async listVolumes() {
            const result = await docker.listVolumes();
            return (result.Volumes ?? []).map(toVolume);
        },

        async inspectVolume(name) {
            try {
                return toVolume(await docker.getVolume(name).inspect());
            } catch (e: unknown) {
                // Absent is an answer, not a failure - the restore asks precisely to find
                // out whether it is creating or overwriting.
                if ((e as { statusCode?: number }).statusCode === 404) return null;
                throw e;
            }
        },

        async createVolume(name) {
            await docker.createVolume({ Name: name });
        },

        async emptyVolume(name, helperImage) {
            // The one operation needing a process: the archive endpoints write into a volume
            // but cannot delete from one. The globs cover dotfiles, which a bare `*` misses -
            // and a half-emptied data directory is worse than one left alone.
            const [output] = await docker.run(
                helperImage,
                ["sh", "-c", `rm -rf ${MOUNT_ROOT}/..?* ${MOUNT_ROOT}/.[!.]* ${MOUNT_ROOT}/* 2>/dev/null; exit 0`],
                // Discarded rather than sent anywhere. dockerode insists on a stream, the
                // helper says nothing worth keeping, and process.stdout here would be
                // console output by another name.
                new Writable({ write(_chunk, _enc, cb) { cb(); } }),
                { HostConfig: { Binds: [`${name}:${MOUNT_ROOT}`], AutoRemove: true } },
            );
            if (output?.StatusCode !== 0) {
                throw new Error(`Could not empty volume '${name}': helper exited with ${output?.StatusCode}`);
            }
        },

        async containersUsingVolume(name) {
            const list = await docker.listContainers({
                all: true,
                filters: { volume: [name] },
            });
            return list.map(toContainer);
        },

        async stopContainer(id) {
            try {
                await docker.getContainer(id).stop();
            } catch (e: unknown) {
                // 304 is "already stopped". Reaching that state is what was asked for.
                if ((e as { statusCode?: number }).statusCode === 304) return;
                throw e;
            }
        },

        async startContainer(id) {
            try {
                await docker.getContainer(id).start();
            } catch (e: unknown) {
                if ((e as { statusCode?: number }).statusCode === 304) return;
                throw e;
            }
        },

        async createMountContainer(volumes, image, labels) {
            const container = await docker.createContainer({
                Image: image,
                // Never run, so the command only has to exist. It is here because the API
                // rejects a container with neither Cmd nor an image entrypoint.
                Cmd: ["true"],
                Labels: labels,
                HostConfig: { Binds: volumes.map((name) => `${name}:${MOUNT_ROOT}/${name}`) },
            });
            return container.id;
        },

        async removeMountContainer(id) {
            await docker.getContainer(id).remove({ force: true, v: false });
        },

        async findLabelledContainers(labelKey) {
            const list = await docker.listContainers({ all: true, filters: { label: [labelKey] } });
            return list.map(toContainer);
        },

        async exportPath(containerId, path) {
            return await docker.getContainer(containerId).getArchive({ path });
        },

        async importPath(containerId, path, tar) {
            await docker.getContainer(containerId).putArchive(tar, { path });
        },

        async close() {
            if (closed) return;
            closed = true;
            agent.destroy();
            await options.onClose?.();
        },
    };
}
