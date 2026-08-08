/**
 * How the daemon socket is reached, when forwarding it is not an option.
 *
 * The direct way is a stream to the socket - `net.connect` locally, an
 * `openssh_forwardOutStreamLocal` channel over SSH. That is one round trip and needs nothing
 * installed on the target, so it stays the first choice.
 *
 * It is not always available. A mesh VPN that answers on port 22 with its own SSH server -
 * NetBird and Tailscale both do - has no such channel type, and neither does an sshd set to
 * `AllowStreamLocalForwarding no`. In those cases the host is perfectly reachable and the
 * daemon is perfectly willing; only the pipe between them is missing.
 *
 * `docker system dial-stdio` supplies that pipe. It is what the Docker CLI itself uses for
 * `DOCKER_HOST=ssh://`, it carries the whole HTTP API over stdin and stdout, and it needs
 * nothing more than the ability to run a command - which is the one thing every SSH server
 * can do.
 */

import { Duplex } from "node:stream";
import type { ExecutionHost } from "@/lib/transport";

/** Which pipe a connection settled on, for the log. */
export type ReachMode = "socket" | "dial-stdio";

/** Does this failure mean "this server has no such channel type"? */
function isStreamLocalUnsupported(e: unknown): boolean {
    return (e as { streamLocalUnsupported?: boolean } | null)?.streamLocalUnsupported === true;
}

/**
 * Runs `docker system dial-stdio` and hands back its stdio as one stream.
 *
 * Errors on stderr are collected rather than logged: the command says nothing on a healthy
 * run, and what it does say - "docker: command not found" above all - is the answer to why
 * the connection failed, so it belongs in the error rather than in a file nobody opens.
 */
async function dialStdio(host: ExecutionHost): Promise<Duplex> {
    const proc = await host.spawn(["docker", "system", "dial-stdio"], { stdin: true });
    if (!proc.stdin) throw new Error("Could not open a stdin stream to 'docker system dial-stdio'");
    const stdin = proc.stdin;

    // Awaited before the error is composed, not merely accumulated. A command that dies at
    // once - `docker: not found`, the very case this text exists for - resolves `exit()`
    // before the stderr data event has been delivered, so reading the buffer at that moment
    // finds it empty and throws away the one line that answers the question.
    let stderr = "";
    const stderrDone = new Promise<void>((resolve) => {
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.stderr.on("end", () => resolve());
        proc.stderr.on("error", () => resolve());
    });

    const channel = new Duplex({
        read() { },
        write(chunk, encoding, callback) { stdin.write(chunk, encoding, callback); },
        final(callback) { stdin.end(callback); },
        destroy(error, callback) { proc.kill(); callback(error); },
    });

    proc.stdout.on("data", (chunk: Buffer) => channel.push(chunk));
    proc.stdout.on("end", () => channel.push(null));
    proc.stdout.on("error", (e: Error) => channel.destroy(e));

    // A command that dies before answering leaves the HTTP client waiting on a stream that
    // will never produce anything, so the exit has to become an error on the stream.
    void proc.exit().then(async ({ code }) => {
        if (code === 0 || code === null) return;
        await stderrDone;
        channel.destroy(new Error(
            `'docker system dial-stdio' exited with ${code} on ${host.label}`
            + `${stderr.trim() ? `: ${stderr.trim()}` : ". Is the Docker CLI installed on that host?"}`
        ));
    });

    return channel;
}

export interface Reacher {
    /** Opens one stream to the daemon. Called once per API request. */
    open: () => Promise<Duplex>;
    /** Which pipe was chosen, once the first attempt has settled. */
    mode: () => ReachMode | undefined;
}

/**
 * Picks a pipe on the first attempt and keeps it for the rest of this connection.
 *
 * Decided once rather than per request, because the answer is a property of the server and
 * cannot change mid-connection - and retrying a forward that has already been refused would
 * pay for the round trip on every single API call.
 */
export function createReacher(
    host: ExecutionHost,
    socketPath: string,
    onFallback?: (reason: string) => void,
): Reacher {
    let chosen: ReachMode | undefined;

    const open = async (): Promise<Duplex> => {
        if (chosen === "dial-stdio") return dialStdio(host);
        if (chosen === "socket") return host.connectSocket(socketPath);

        try {
            const stream = await host.connectSocket(socketPath);
            chosen = "socket";
            return stream;
        } catch (e: unknown) {
            // Only for "no such channel type". A socket that is missing, or one this user
            // cannot open, is a real problem and must not be papered over with a second
            // route that would fail differently.
            if (!isStreamLocalUnsupported(e)) throw e;
            chosen = "dial-stdio";
            onFallback?.(e instanceof Error ? e.message : String(e));
            return dialStdio(host);
        }
    };

    return { open, mode: () => chosen };
}
