/**
 * What a prepared group holds open, and how the collection finds it again.
 *
 * Storage adapters are handed a config and nothing else - `downloadDirectory` has no way to
 * receive an object. So the preparation registers itself here and puts its id into the
 * snapshot's `configOverride`, which the runner overlays onto the config the collection
 * reads through. That is what `configOverride` is for, and it is why nothing above this
 * needs to know a connection exists at all.
 *
 * **Lifetime is one group, not one run.** Connected components guarantee a container belongs
 * to exactly one group, so nothing has to be shared across them, and the only thing a
 * run-scoped session would save is a handshake per group - a second or so on a backup that
 * takes minutes. Per-group is bounded, self-cleaning, and has no way to tear down another
 * job's work.
 */

import { randomUUID } from "node:crypto";
import { connectDocker, type DockerConnection } from "./engine/connect";
import type { DockerEngine } from "./engine/types";

export interface DockerSession {
    readonly id: string;
    readonly engine: DockerEngine;
    /** Helper container holding this group's volumes, as `/vol/<name>`. */
    readonly containerId: string;
    /** Containers this session stopped and therefore has to start again. */
    readonly stoppedContainerIds: readonly string[];
    readonly volumes: readonly string[];
}

/** Key the runner overlays onto the config so the collection can find its session. */
export const SESSION_CONFIG_KEY = "__dockerSessionId";

const sessions = new Map<string, DockerSession>();
const connections = new Map<string, DockerConnection>();

/**
 * Helper containers this process is currently using.
 *
 * Orphan recovery has to tell a container left by a dead run from one a concurrent job is
 * using right now, and removing the latter would restart that job's containers underneath
 * it. DBackup runs its jobs in one process, so "live" is exactly "in this set" - there is no
 * second process whose containers could be mistaken for leftovers.
 */
const liveContainers = new Set<string>();

export function isLiveContainer(containerId: string): boolean {
    return liveContainers.has(containerId);
}

export function registerSession(session: Omit<DockerSession, "id">, connection: DockerConnection): DockerSession {
    const registered: DockerSession = { ...session, id: randomUUID() };
    sessions.set(registered.id, registered);
    connections.set(registered.id, connection);
    liveContainers.add(registered.containerId);
    return registered;
}

/**
 * The session a collection is reading through.
 *
 * Absent means the config was not overlaid with a prepared group, which for this adapter can
 * only happen if something called a collection method outside the runner's snapshot scope.
 */
export function sessionFromConfig(config: Record<string, unknown>): DockerSession {
    const id = config[SESSION_CONFIG_KEY];
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    if (!session) {
        throw new Error(
            "No prepared Docker session for this source. A volume can only be read through a helper container, "
            + "which the backup creates before the collection starts."
        );
    }
    return session;
}

/** The session with this id, or undefined once it has been disposed. */
export function getSession(sessionId: string): DockerSession | undefined {
    return sessions.get(sessionId);
}

/** Forgets a session and closes its connection. Safe to call twice. */
export async function disposeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (session) liveContainers.delete(session.containerId);
    sessions.delete(sessionId);

    const connection = connections.get(sessionId);
    connections.delete(sessionId);
    await connection?.close().catch(() => { });
}

/** Opens a connection for work that is not part of a prepared group. */
export function openConnection(config: Record<string, unknown>): DockerConnection {
    return connectDocker(config);
}
