/**
 * What DBackup needs from a container runtime, in DBackup's words.
 *
 * Everything above this line talks volumes, containers and archives. Everything below it -
 * exactly one file, `dockerode-engine.ts` - talks to dockerode. Without that seam the client
 * would be reached for from all eleven files of this adapter, which is structurally the same
 * spread that made the old SSH mode unmaintainable, just with a different library.
 *
 * The two reasons the seam earns its keep are not "the agent will need a second
 * implementation" - it almost certainly will not, since an agent can expose the same API
 * socket over its own channel and `ExecutionHost.connectSocket` already covers that:
 *
 *  - The logic worth testing (grouping, refcounts, orphan recovery) is testable against a
 *    fake with fourteen methods, instead of a mock reproducing `getVolume(...).remove()`
 *    and `container.getArchive()`.
 *  - If reading a volume ever has to work differently, it is a swap rather than a rewrite.
 *
 * If this ever collapses into `type DockerEngine = Dockerode`, it is worthless and should
 * be deleted rather than kept for the shape of it.
 */

export interface VolumeInfo {
    name: string;
    /** Volume driver, "local" for anything Docker manages itself. */
    driver: string;
    /** Host path the volume's contents live at. Only the local driver reports one. */
    mountpoint?: string;
    labels: Record<string, string>;
}

export interface ContainerInfo {
    id: string;
    /** Leading slash stripped, as a user would write it. */
    name: string;
    /** True only for a container that is actually running now. */
    running: boolean;
    labels: Record<string, string>;
}

export interface DockerEngine {
    /** Loggable description of the endpoint. Never contains credentials. */
    readonly label: string;

    version(): Promise<{ version: string; apiVersion: string }>;

    listVolumes(): Promise<VolumeInfo[]>;
    inspectVolume(name: string): Promise<VolumeInfo | null>;
    createVolume(name: string): Promise<void>;
    /**
     * Removes everything inside a volume without removing the volume itself.
     *
     * Needs a startable image with a shell, unlike everything else here: the archive
     * endpoints can write into a volume but not delete from one, so emptying is the single
     * operation that cannot be done with a container that is only created.
     */
    emptyVolume(name: string, helperImage: string): Promise<void>;

    /** Every container referencing the volume, running or not. */
    containersUsingVolume(name: string): Promise<ContainerInfo[]>;
    stopContainer(id: string): Promise<void>;
    startContainer(id: string): Promise<void>;

    /**
     * Creates - but does not start - a container with the given volumes mounted under
     * `/vol/<name>`, carrying our labels so a run killed before cleanup can be found again.
     *
     * Not starting it is deliberate and verified: the archive endpoints read and write a
     * created container's mounts without a process ever running in it, so this needs no
     * shell, no entrypoint and no image that could fail to start.
     */
    createMountContainer(volumes: string[], image: string, labels: Record<string, string>): Promise<string>;
    removeMountContainer(id: string): Promise<void>;
    /** Containers carrying a label key, for finding what an interrupted run left behind. */
    findLabelledContainers(labelKey: string): Promise<ContainerInfo[]>;

    /**
     * Tar stream of a path inside a container.
     *
     * Every member is prefixed with the basename of the requested path, so a caller reading
     * `/vol/data` gets `data/...` and has to strip one leading component. Modes, owners and
     * symlinks come through intact.
     */
    exportPath(containerId: string, path: string): Promise<NodeJS.ReadableStream>;
    /**
     * Unpacks a tar stream into a path inside a container, applying the modes and owners in
     * its headers.
     *
     * The stream must come from our own packer. A tar produced by a host tool can carry
     * extended attributes the daemon cannot apply, and it fails the whole call over one -
     * macOS `bsdtar` stamps `com.apple.provenance` onto every file, which is exactly how
     * that was found.
     */
    importPath(containerId: string, path: string, tar: NodeJS.ReadableStream): Promise<void>;

    /** Idempotent. Closes the connection and anything holding it open. */
    close(): Promise<void>;
}
