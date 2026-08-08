/**
 * How the Docker daemon is reached when its socket cannot be forwarded.
 *
 * Forwarding the socket is one round trip and needs nothing installed on the target, so it
 * stays the first choice. But a mesh VPN that answers on port 22 with its own SSH server -
 * NetBird and Tailscale both do - has no such channel type at all, and neither does an sshd
 * with `AllowStreamLocalForwarding no`. The host is reachable and the daemon is willing;
 * only the pipe is missing, and `docker system dial-stdio` supplies one over a plain command
 * channel, which is the single thing every SSH server can do.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { createReacher } from "@/lib/adapters/storage/docker/engine/reach";
import type { ExecutionHost, HostProcess } from "@/lib/transport";

/** The failure shape `SshHost.connectSocket` marks when the channel type is unknown. */
function unsupported(message = "Channel open failure: unsupported channel type"): Error {
    const error = new Error(message);
    (error as { streamLocalUnsupported?: boolean }).streamLocalUnsupported = true;
    return error;
}

function fakeHost(overrides: Partial<ExecutionHost> = {}) {
    const spawned: string[][] = [];
    const host = {
        label: "ssh://root@100.100.30.2:22",
        connectSocket: vi.fn(async () => new PassThrough()),
        spawn: vi.fn(async (argv: string[]) => {
            spawned.push(argv);
            return {
                stdout: Readable.from([]),
                stderr: Readable.from([]),
                stdin: new PassThrough(),
                exit: () => new Promise<{ code: number | null }>(() => { }),
                kill: vi.fn(),
            } as unknown as HostProcess;
        }),
        ...overrides,
    } as unknown as ExecutionHost;
    return { host, spawned };
}

describe("reaching the daemon", () => {
    it("forwards the socket when the server can", async () => {
        const { host, spawned } = fakeHost();
        const reacher = createReacher(host, "/var/run/docker.sock");

        await reacher.open();

        expect(host.connectSocket).toHaveBeenCalledWith("/var/run/docker.sock");
        expect(spawned).toEqual([]);
        expect(reacher.mode()).toBe("socket");
    });

    it("falls back to the Docker CLI when the server has no such channel type", async () => {
        const { host, spawned } = fakeHost({
            connectSocket: vi.fn(async () => { throw unsupported(); }),
        });
        const reacher = createReacher(host, "/var/run/docker.sock");

        await reacher.open();

        expect(spawned).toEqual([["docker", "system", "dial-stdio"]]);
        expect(reacher.mode()).toBe("dial-stdio");
    });

    it("says that it fell back, and why", async () => {
        // Which route a connection took explains a whole class of later behaviour - the
        // fallback needs the Docker CLI on the target - and finding that out from a stack
        // trace is an hour nobody should spend.
        const { host } = fakeHost({
            connectSocket: vi.fn(async () => { throw unsupported("Channel open failure: unsupported channel type"); }),
        });
        const onFallback = vi.fn();

        await createReacher(host, "/var/run/docker.sock", onFallback).open();

        expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("unsupported channel type"));
    });

    it("does not fall back when the socket is simply not there", async () => {
        // A missing socket, or one this user cannot open, is a real problem. Papering over it
        // with a second route would replace a precise error with a vaguer one.
        const { host, spawned } = fakeHost({
            connectSocket: vi.fn(async () => { throw new Error("connect ENOENT /var/run/docker.sock"); }),
        });

        await expect(createReacher(host, "/var/run/docker.sock").open()).rejects.toThrow(/ENOENT/);
        expect(spawned).toEqual([]);
    });

    it("decides once and keeps it for every later request", async () => {
        // The answer is a property of the server and cannot change mid-connection, so
        // retrying a refused forward would pay for the round trip on every API call - and
        // dockerode makes one connection per call.
        const connectSocket = vi.fn(async () => { throw unsupported(); });
        const { host, spawned } = fakeHost({ connectSocket });
        const reacher = createReacher(host, "/var/run/docker.sock");

        await reacher.open();
        await reacher.open();
        await reacher.open();

        expect(connectSocket).toHaveBeenCalledTimes(1);
        expect(spawned).toHaveLength(3);
    });

    it("keeps forwarding once that worked, without ever spawning anything", async () => {
        const { host, spawned } = fakeHost();
        const reacher = createReacher(host, "/var/run/docker.sock");

        await reacher.open();
        await reacher.open();

        expect(host.connectSocket).toHaveBeenCalledTimes(2);
        expect(spawned).toEqual([]);
    });

    it("turns a command that dies into an error on the stream", async () => {
        // Without this the HTTP client waits forever on a stream that will never produce
        // anything - the "docker: not found" case would look like a hang.
        const { host } = fakeHost({
            connectSocket: vi.fn(async () => { throw unsupported(); }),
            spawn: vi.fn(async () => ({
                stdout: Readable.from([]),
                stderr: Readable.from(["sh: docker: not found\n"]),
                stdin: new PassThrough(),
                exit: async () => ({ code: 127 }),
                kill: vi.fn(),
            }) as unknown as HostProcess),
        });

        const stream = await createReacher(host, "/var/run/docker.sock").open();

        const error = await new Promise<Error>((resolve) => stream.on("error", resolve));
        expect(error.message).toMatch(/exited with 127/);
        expect(error.message).toMatch(/docker: not found/);
    });
});
