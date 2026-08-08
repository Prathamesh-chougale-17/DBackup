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
import { labelsFor, type LabelledContainer } from "./labels";

/**
 * Volumes appear under `/vol/<name>`, one directory per volume, which is what lets a single
 * container serve a whole group.
 */
export function mountPathFor(volume: string): string {
    return `/vol/${volume}`;
}

/**
 * What the helper runs when it is started, printing `<volume> <count>` per mounted volume.
 *
 * Fixed text with no user input in it - the only variable part is the shell's own glob over
 * the mount root. Counting all of a group's volumes in one start is what keeps this to a
 * single container run rather than one per volume.
 *
 * A helper is created with this command whether or not it is ever started. Exporting works
 * either way, so an image that cannot run it costs the progress denominator and nothing else.
 */
export const COUNT_COMMAND = [
    "sh", "-c",
    'for d in /vol/*; do [ -d "$d" ] || continue; printf "%s %s\\n" "${d##*/}" "$(find "$d" \\( -type f -o -type l \\) 2>/dev/null | wc -l)"; done',
];

export async function createHelper(
    engine: DockerEngine,
    volumes: readonly string[],
    image: string,
    sessionId: string,
    stoppedContainers: readonly LabelledContainer[]
): Promise<string> {
    try {
        // Pulled only when absent. The very first backup on a host would otherwise fail on a
        // missing image, for a setting most people will never touch.
        await engine.ensureImage(image);
        return await engine.createMountContainer([...volumes], image, labelsFor(sessionId, stoppedContainers));
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        // The one requirement of the backup path that is not obvious from the outside, so it
        // is worth naming rather than passing the raw "No such image" through.
        throw new Error(
            `Could not create the helper container from image '${image}': ${message}. `
            + `The image only has to exist on the Docker host - it is never started - so having it locally, or letting DBackup pull it once, is enough.`
        );
    }
}

export async function removeHelper(engine: DockerEngine, containerId: string): Promise<void> {
    await engine.removeMountContainer(containerId);
}
