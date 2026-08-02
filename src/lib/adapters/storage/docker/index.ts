import { StorageAdapter, DirectoryBrowseEntry, FileInfo } from "@/lib/core/interfaces";
import { DockerVolumeSchema } from "@/lib/adapters/definitions/storage";
import { logger } from "@/lib/logging/logger";
import { wrapError, getErrorMessage } from "@/lib/logging/errors";
import { connectDocker } from "./engine/connect";
import type { DockerEngine } from "./engine/types";

const log = logger.child({ adapter: "docker-volume" });

export type DockerVolumeConfig = Record<string, unknown>;

/**
 * Docker volumes as a backup source.
 *
 * A volume is data with no other way out: a database inside a container can be dumped
 * through its own adapter, but the configuration, uploads and plugin state beside it are
 * reachable only through the container runtime. Until now the only way to back that up was
 * to have set the volume up as a bind mount in the first place.
 *
 * Source only. Writing archives into a container runtime is not a thing anyone wants, and
 * offering it as a destination would only let someone build a job that fails on its first
 * upload - see `supportedRoles` on the definition.
 */
export const DockerVolumeAdapter: StorageAdapter = {
    id: "docker-volume",
    type: "storage",
    name: "Docker Volumes",
    configSchema: DockerVolumeSchema,

    async test(config) {
        return withEngine<{ success: boolean; message: string; version?: string }>(
            config,
            async (engine) => {
                const { version, apiVersion } = await engine.version();
                const volumes = await engine.listVolumes();
                return {
                    success: true,
                    message: `Connected to Docker ${version} (API ${apiVersion}), ${volumes.length} volume(s) visible`,
                    version,
                };
            },
            (message) => ({ success: false, message }),
        );
    },

    async ping(config) {
        return withEngine<{ success: boolean; message: string }>(
            config,
            async (engine) => {
                const { version } = await engine.version();
                return { success: true, message: `Docker ${version}` };
            },
            (message) => ({ success: false, message }),
        );
    },

    /**
     * The volume list, shaped as directories so the existing folder picker in the job form
     * shows it with no new route and no new component. A volume has no children, so anything
     * below the root is empty.
     */
    async browseDirectories(config, subPath): Promise<DirectoryBrowseEntry[]> {
        if (subPath) return [];
        return withEngine(config, async (engine) => {
            const volumes = await engine.listVolumes();
            return volumes
                .map((volume) => ({ name: volume.name, path: volume.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }, (message) => {
            // Browsing is interactive: an unreachable host should leave the picker empty
            // with the error in the log, not throw into the dialog.
            log.warn("Could not list Docker volumes", {}, wrapError(new Error(message)));
            return [];
        });
    },

    /**
     * Present because StorageAdapter requires it, and answering with the volume itself is
     * the only honest thing it can say: the tree inside a volume is not readable without a
     * container, which is what the collection path builds. Nothing calls this for a Docker
     * source - the collection uses `downloadDirectory`, and the destination-facing callers
     * that use `list()` are all role-filtered to destinations.
     */
    async list(_config, remotePath): Promise<FileInfo[]> {
        void remotePath;
        return [];
    },

    async upload(): Promise<boolean> {
        throw new Error("Docker volumes cannot be used as a backup destination.");
    },

    async download(): Promise<boolean> {
        throw new Error("A Docker volume is collected as a directory, not as a single file.");
    },

    async delete(): Promise<boolean> {
        throw new Error("DBackup does not delete Docker volumes.");
    },
};

/**
 * Runs one operation against a freshly opened connection, and always closes it.
 *
 * Every call here is a standalone one - a connection test, a health check, a volume listing
 * for the job form. A backup holds a connection across a whole run instead, which is what
 * the session built on top of this is for.
 */
async function withEngine<T>(
    config: DockerVolumeConfig,
    fn: (engine: DockerEngine) => Promise<T>,
    onError: (message: string) => T,
): Promise<T> {
    const connection = connectDocker(config);
    try {
        return await fn(connection.engine);
    } catch (e: unknown) {
        return onError(describeFailure(e));
    } finally {
        await connection.close().catch(() => { });
    }
}

/**
 * Turns a connection failure into something an operator can act on.
 *
 * The raw errors here are unusually unhelpful: a missing socket surfaces as ENOENT on a path
 * nobody typed, and a daemon that is simply not running looks identical to one that is not
 * mounted into the container.
 */
function describeFailure(e: unknown): string {
    const message = getErrorMessage(e);
    const code = (e as { code?: string }).code;

    if (code === "ENOENT" || message.includes("ENOENT")) {
        return `${message}. The Docker socket was not found. Running DBackup in a container means mounting it, for example -v /var/run/docker.sock:/var/run/docker.sock.`;
    }
    if (code === "EACCES" || message.includes("EACCES")) {
        return `${message}. The Docker socket exists but is not readable by the user DBackup runs as.`;
    }
    if (code === "ECONNREFUSED") {
        return `${message}. Nothing is listening on the Docker socket - the daemon is most likely not running.`;
    }
    return message;
}
