import net from "node:net";
import type { Client, ClientChannel } from "ssh2";

import type { PortForward } from "./types";

/**
 * Local TCP listener that proxies every connection through an SSH channel.
 *
 * This is what lets a native driver reach a database that only listens on the
 * target machine's loopback. The driver dials 127.0.0.1 on a kernel-assigned
 * port and never learns that SSH is involved.
 *
 * Port 0 is deliberate: the kernel picks a free port, so there is no port-range
 * setting to configure and no race between choosing a port and binding it.
 */
export async function createPortForward(
    client: Client,
    remoteHost: string,
    remotePort: number,
): Promise<PortForward> {
    /**
     * Both halves of every live connection.
     *
     * The channel has to be tracked alongside the socket: destroying only the
     * socket leaves its SSH channel open, which holds a session slot on the
     * server until the whole connection goes away.
     */
    interface Pair {
        socket: net.Socket;
        channel: ClientChannel | null;
    }

    const live = new Set<Pair>();
    let lastError: Error | null = null;
    let closing = false;

    const teardown = (pair: Pair) => {
        pair.channel?.destroy();
        pair.socket.destroy();
        live.delete(pair);
    };

    const server = net.createServer((socket) => {
        if (closing) {
            socket.destroy();
            return;
        }
        const pair: Pair = { socket, channel: null };
        live.add(pair);
        socket.once("close", () => {
            pair.channel?.end();
            live.delete(pair);
        });
        // A forwarding failure is reported per connection and the driver only
        // sees a reset peer, so keep the cause for the error message.
        socket.on("error", (err) => {
            lastError ??= err;
            teardown(pair);
        });

        client.forwardOut(
            "127.0.0.1",
            socket.remotePort ?? 0,
            remoteHost,
            remotePort,
            (err: Error | undefined, channel: ClientChannel) => {
                if (err) {
                    lastError ??= err;
                    teardown(pair);
                    return;
                }
                pair.channel = channel;
                if (closing) {
                    teardown(pair);
                    return;
                }
                channel.on("error", (channelErr: Error) => {
                    lastError ??= channelErr;
                    teardown(pair);
                });
                socket.pipe(channel).pipe(socket);
                channel.once("close", () => socket.end());
            },
        );
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Failed to determine the local address of the SSH port forward.");
    }

    return {
        host: "127.0.0.1",
        port: address.port,
        forwarded: true,
        get lastError() {
            return lastError;
        },
        async close() {
            if (closing) return;
            closing = true;
            for (const pair of [...live]) teardown(pair);
            live.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
