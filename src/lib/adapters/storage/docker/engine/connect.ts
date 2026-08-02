/**
 * Builds a DockerEngine on top of an ExecutionHost.
 *
 * This is the entire transport story of the adapter. `connectSocket` returns a stream to the
 * daemon socket as reachable from that host - a plain `net.connect` locally, an
 * `openssh_forwardOutStreamLocal` channel over SSH - and nothing here or anywhere above
 * needs to know which. No local listener, no port, no `host.kind` check.
 */

import { createHost, standardTransport, type ExecutionHost } from "@/lib/transport";
import { createDockerodeEngine } from "./dockerode-engine";
import type { DockerEngine } from "./types";

export const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";

export interface DockerConnection {
    engine: DockerEngine;
    /** Closes the engine and disposes the transport underneath it. Idempotent. */
    close: () => Promise<void>;
}

/**
 * Opens a connection to the daemon a config points at.
 *
 * The host is created here rather than handed in because storage adapters are not given one:
 * `upload`, `list` and `downloadDirectory` take a config and nothing else. Whatever is
 * created here therefore has to be closed by whoever called, which is what the session
 * above this exists to guarantee.
 *
 * `standardTransport` is called directly rather than through `resolveTransport`, because the
 * per-adapter resolver hangs off `DatabaseAdapter` and this is a storage adapter - the first
 * one to use an ExecutionHost at all, since SFTP and rsync bring their own SSH client.
 * Widening the storage interface for a single adapter that follows the standard
 * `connectionMode` convention exactly would add surface for nothing.
 */
export function connectDocker(config: Record<string, unknown>): DockerConnection {
    const host: ExecutionHost = createHost(standardTransport(config));
    const socketPath = typeof config.socketPath === "string" && config.socketPath.length > 0
        ? config.socketPath
        : DEFAULT_SOCKET_PATH;

    const engine = createDockerodeEngine({
        // One connection per request, as dockerode asks for. Over SSH each is a channel on
        // the one already-open connection, so this costs a channel and not a handshake.
        connect: () => host.connectSocket(socketPath),
        label: `${host.label} ${socketPath}`,
        onClose: () => host.dispose(),
    });

    return { engine, close: () => engine.close() };
}
