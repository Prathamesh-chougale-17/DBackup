/**
 * The helper container a group's volumes are read through.
 *
 * Created and never started. The archive endpoints read and write a created container's
 * mounts without a process ever running in it, which was verified before this was designed
 * around - so the image needs no shell, no entrypoint, and nothing that could fail to start.
 * It only has to exist locally.
 *
 * It also carries the run's bookkeeping in its labels, because that is the only place the
 * state survives a process that gets killed.
 */

import type { DockerEngine } from "./engine/types";
import { labelsFor } from "./labels";

/**
 * Volumes appear under `/vol/<name>`, one directory per volume, which is what lets a single
 * container serve a whole group.
 */
export function mountPathFor(volume: string): string {
    return `/vol/${volume}`;
}

export async function createHelper(
    engine: DockerEngine,
    volumes: readonly string[],
    image: string,
    sessionId: string,
    stoppedContainerIds: readonly string[]
): Promise<string> {
    try {
        return await engine.createMountContainer([...volumes], image, labelsFor(sessionId, stoppedContainerIds));
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        // The one requirement of the backup path that is not obvious from the outside, so it
        // is worth naming rather than passing the raw "No such image" through.
        throw new Error(
            `Could not create the helper container from image '${image}': ${message}. `
            + `The image only has to exist on the Docker host - it is never started - so pulling it once is enough.`
        );
    }
}

export async function removeHelper(engine: DockerEngine, containerId: string): Promise<void> {
    await engine.removeMountContainer(containerId);
}
