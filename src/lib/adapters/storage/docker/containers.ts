/**
 * Stopping and starting the containers that hold a group's volumes.
 *
 * The rule the whole feature stands on: only containers that were running get started again.
 * A container the user had deliberately stopped must still be stopped afterwards, and one
 * that was running must be running afterwards - including when the backup fails partway.
 */

import type { ContainerInfo, DockerEngine } from "./engine/types";

type Log = (message: string, level?: "info" | "warning" | "error") => void;

/**
 * A container this run took down, and has to put back.
 *
 * The name travels with the id because that is what a person reads. An id is what Docker
 * needs; "Started container 'a49343f55d83' again" tells an operator nothing about which of
 * their services was down.
 */
export interface StoppedContainer {
    id: string;
    name: string;
}

/**
 * Stops every running container in the list and reports which ones were stopped.
 *
 * Only the returned ones are ever started again. A container that was already down is left
 * out, which is what stops a backup from starting something the user had switched off.
 *
 * A failure to stop is fatal for the group: reading a volume out from under a running
 * database is the inconsistent backup this option exists to prevent, and producing one
 * quietly would be worse than failing.
 */
export async function stopRunning(
    engine: DockerEngine,
    containers: readonly ContainerInfo[],
    log: Log
): Promise<StoppedContainer[]> {
    const running = containers.filter((container) => container.running);
    if (running.length === 0) return [];

    const stopped: StoppedContainer[] = [];
    try {
        for (const container of running) {
            await engine.stopContainer(container.id);
            stopped.push({ id: container.id, name: container.name });
            log(`Stopped container '${container.name}'`);
        }
    } catch (e: unknown) {
        // Whatever already went down has to come back up before the failure propagates, or
        // the run leaves the user's services in a state nobody asked for.
        await startAll(engine, stopped, log);
        throw e;
    }
    return stopped;
}

/**
 * Starts containers again, one failure at a time.
 *
 * Deliberately never throws. This runs while cleaning up, often while another error is on
 * its way out, and one container that refuses to start must not stop the other four from
 * coming back. What it cannot fix, it says loudly - a container left down is the worst
 * outcome this feature has, and it must not be silent.
 */
export async function startAll(
    engine: DockerEngine,
    containers: readonly StoppedContainer[],
    log: Log
): Promise<void> {
    for (const container of containers) {
        const label = container.name || short(container.id);
        try {
            await engine.startContainer(container.id);
            log(`Started container '${label}' again`);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            log(
                `Could not start container '${label}' again: ${message}. It was running before this backup and has to be started by hand.`,
                "error"
            );
        }
    }
}

/** Container ids read as a person would: the short form Docker itself prints. */
function short(id: string): string {
    return id.slice(0, 12);
}
