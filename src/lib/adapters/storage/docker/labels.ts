/**
 * Labels DBackup puts on the containers it creates.
 *
 * They are the only way a run that was killed - SIGKILL, a lost power cable, a container
 * host reboot - can be cleaned up afterwards. Nothing else survives: the session holding the
 * bookkeeping is gone with the process, so the state has to live on the Docker host itself.
 *
 * That is also why the pre-stop state of every container goes on here rather than only into
 * memory. Leaving a helper container behind wastes a little space. Leaving the user's
 * database stopped, with nothing anywhere recording that it used to be running, is the worst
 * thing this feature can do.
 */

/** Marks a container as ours. Present on every one we create. */
export const TEMP_CONTAINER_LABEL = "com.dbackup.temp";

/** Execution id that created it, so a concurrent run's containers are not touched. */
export const EXECUTION_LABEL = "com.dbackup.execution";

/** Comma-separated ids of containers this run stopped and has to start again. */
export const STOPPED_LABEL = "com.dbackup.stopped";

export function labelsFor(executionId: string, stoppedContainerIds: readonly string[]): Record<string, string> {
    return {
        [TEMP_CONTAINER_LABEL]: "1",
        [EXECUTION_LABEL]: executionId,
        // Empty when nothing was stopped, which is a real state and not a missing one: it is
        // what a group with the stop option turned off leaves behind.
        [STOPPED_LABEL]: stoppedContainerIds.join(","),
    };
}

/** The container ids a leftover helper says its run had stopped. */
export function stoppedContainersFrom(labels: Record<string, string>): string[] {
    return (labels[STOPPED_LABEL] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}
