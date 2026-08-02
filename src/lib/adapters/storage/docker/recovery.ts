/**
 * Cleaning up after a run that never got to clean up after itself.
 *
 * A backup stops the user's containers. If the process is killed between stopping them and
 * starting them again - SIGKILL, a host reboot, a pulled plug - nothing in memory survives
 * to put them back. This is the only path that can, and it works because the pre-stop state
 * was written onto the Docker host itself, as labels on the helper container.
 *
 * That makes this the most important file in the adapter. A leftover helper container wastes
 * a few kilobytes. A user's database left stopped, with nothing anywhere recording that it
 * used to be running, is the worst thing this feature can do.
 */

import type { DockerEngine } from "./engine/types";
import { startAll } from "./containers";
import { TEMP_CONTAINER_LABEL, stoppedContainersFrom } from "./labels";
import { isLiveContainer } from "./session";

type Log = (message: string, level?: "info" | "warning" | "error") => void;

export interface OrphanedHelper {
    containerId: string;
    /** Containers the dead run had stopped, read back off the helper's labels. */
    stoppedContainerIds: string[];
    label: string;
}

/**
 * Helper containers left behind by an earlier run.
 *
 * Containers this process is using right now are excluded. Two jobs can run at once, and
 * removing the other one's helper would restart its containers underneath it - turning a
 * cleanup into the exact failure it exists to repair.
 */
export async function findOrphanedHelpers(engine: DockerEngine): Promise<OrphanedHelper[]> {
    const found = await engine.findLabelledContainers(TEMP_CONTAINER_LABEL);
    return found
        .filter((container) => !isLiveContainer(container.id))
        .map((container) => ({
            containerId: container.id,
            stoppedContainerIds: stoppedContainersFrom(container.labels),
            label: `helper container ${container.id.slice(0, 12)}`,
        }));
}

/**
 * Puts back what an interrupted run left.
 *
 * Containers are started **before** the helper is removed. If removal fails, the helper is
 * still there for the next attempt, so the recovery can be retried - whereas removing first
 * and failing to start would throw away the only record of what has to come back up.
 */
export async function releaseOrphanedHelper(
    engine: DockerEngine,
    orphan: OrphanedHelper,
    log: Log
): Promise<void> {
    if (orphan.stoppedContainerIds.length > 0) {
        log(
            `Found ${orphan.label} from an interrupted run, with ${orphan.stoppedContainerIds.length} container(s) it had stopped. Starting them again.`,
            "warning"
        );
        await startAll(engine, orphan.stoppedContainerIds, log);
    }
    await engine.removeMountContainer(orphan.containerId);
}
