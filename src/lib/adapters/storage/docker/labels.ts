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

/**
 * Containers this run stopped and has to start again, as `id|name` separated by commas.
 *
 * The name is carried alongside the id because this label is read by a *later* run, in the
 * one message where being vague costs the most: "an earlier run left these stopped". An id
 * alone leaves the operator to look up which of their services that was.
 *
 * A container name cannot contain `|` or `,` - Docker restricts them to
 * `[a-zA-Z0-9][a-zA-Z0-9_.-]*` - so neither separator can be ambiguous.
 */
export const STOPPED_LABEL = "com.dbackup.stopped";

/** A container an earlier run stopped, as read back off a leftover helper. */
export interface LabelledContainer {
    id: string;
    name: string;
}

export function labelsFor(
    executionId: string,
    stoppedContainers: readonly LabelledContainer[]
): Record<string, string> {
    return {
        [TEMP_CONTAINER_LABEL]: "1",
        [EXECUTION_LABEL]: executionId,
        // Empty when nothing was stopped, which is a real state and not a missing one: it is
        // what a group with the stop option turned off leaves behind.
        [STOPPED_LABEL]: stoppedContainers.map((c) => `${c.id}|${c.name}`).join(","),
    };
}

/**
 * The containers a leftover helper says its run had stopped.
 *
 * Reads a label written before names were carried, where each entry is a bare id. Such a
 * helper belongs to a run from an older version, and dropping it would leave exactly the
 * containers that version stopped down for good.
 */
export function stoppedContainersFrom(labels: Record<string, string>): LabelledContainer[] {
    return (labels[STOPPED_LABEL] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
            const separator = entry.indexOf("|");
            if (separator === -1) return { id: entry, name: "" };
            return { id: entry.slice(0, separator), name: entry.slice(separator + 1) };
        })
        .filter((c) => c.id.length > 0);
}
