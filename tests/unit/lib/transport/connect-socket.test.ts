import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("ssh2", () => ({ Client: vi.fn() }));

import { Client } from "ssh2";
import { DirectHost } from "@/lib/transport/direct-host";
import { SshHost } from "@/lib/transport/ssh-host";
import { CompositeHost } from "@/lib/transport/composite-host";
import type { SshConnectionConfig } from "@/lib/transport/types";

const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

const sshConfig: SshConnectionConfig = {
    host: "10.0.0.4",
    port: 2222,
    username: "ops",
    authType: "password",
    password: "hunter2",
};

/** Read everything a Duplex produces, then resolve. */
function drain(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
        let out = "";
        stream.on("data", (c: Buffer) => { out += c.toString(); });
        stream.on("end", () => resolve(out));
        stream.on("error", reject);
    });
}

describe("DirectHost.connectSocket", () => {
    let dir: string;
    let server: net.Server | null = null;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-sock-"));
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        server = null;
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("carries bytes both ways over a real unix socket", async () => {
        const socketPath = path.join(dir, "echo.sock");
        server = net.createServer((socket) => {
            socket.on("data", (chunk: Buffer) => socket.write(`echo:${chunk.toString()}`));
        });
        await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

        const host = new DirectHost();
        const stream = await host.connectSocket(socketPath);

        const received = new Promise<string>((resolve) => {
            stream.once("data", (c: Buffer) => resolve(c.toString()));
        });
        stream.write("ping");

        expect(await received).toBe("echo:ping");
        stream.destroy();
        await host.dispose();
    });

    it("rejects rather than hanging when the socket is not there", async () => {
        const host = new DirectHost();
        await expect(host.connectSocket(path.join(dir, "absent.sock"))).rejects.toThrow();
        await host.dispose();
    });
});

describe("SshHost.connectSocket", () => {
    let client: EventEmitter & {
        connect: ReturnType<typeof vi.fn>;
        exec: ReturnType<typeof vi.fn>;
        sftp: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        openssh_forwardOutStreamLocal: ReturnType<typeof vi.fn>;
    };
    let requested: string[];

    /** Installs a fake ssh2 Client whose stream-local forward behaves as told. */
    function mountClient(forward: (socketPath: string, cb: (err: Error | undefined, channel: unknown) => void) => void) {
        requested = [];
        client = Object.assign(new EventEmitter(), {
            connect: vi.fn(() => setImmediate(() => client.emit("ready"))),
            exec: vi.fn(),
            sftp: vi.fn(),
            end: vi.fn(),
            openssh_forwardOutStreamLocal: vi.fn((socketPath: string, cb) => {
                requested.push(socketPath);
                forward(socketPath, cb);
            }),
        }) as typeof client;
        MockClient.mockImplementation(function () {
            return client;
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opens a direct-streamlocal channel and hands back its stream", async () => {
        const channel = new PassThrough();
        mountClient((_p, cb) => setImmediate(() => cb(undefined, channel)));

        const host = new SshHost(sshConfig);
        const stream = await host.connectSocket("/var/run/docker.sock");

        expect(requested).toEqual(["/var/run/docker.sock"]);
        expect(stream).toBe(channel);

        // The stream has to be usable, not just returned.
        const read = drain(stream);
        channel.end("HTTP/1.1 200 OK");
        expect(await read).toBe("HTTP/1.1 200 OK");

        await host.dispose();
    });

    it("connects lazily, like every other operation on this host", async () => {
        mountClient((_p, cb) => setImmediate(() => cb(undefined, new PassThrough())));

        const host = new SshHost(sshConfig);
        expect(client.connect).not.toHaveBeenCalled();

        await host.connectSocket("/var/run/docker.sock");
        expect(client.connect).toHaveBeenCalledTimes(1);
        await host.dispose();
    });

    it("reuses one connection across many socket streams", async () => {
        mountClient((_p, cb) => setImmediate(() => cb(undefined, new PassThrough())));

        const host = new SshHost(sshConfig);
        // dockerode opens a connection per request, so this is the normal case
        // rather than an edge one.
        await Promise.all(Array.from({ length: 8 }, () => host.connectSocket("/var/run/docker.sock")));

        expect(requested).toHaveLength(8);
        expect(client.connect).toHaveBeenCalledTimes(1);
        await host.dispose();
    });

    it("does not queue behind the channel limiter", async () => {
        // Forwarding channels are not sessions, so OpenSSH does not count them
        // against MaxSessions. Were they to take a limiter slot, the 5th of these
        // would block forever because none of them ever closes.
        const opened: Array<(err: Error | undefined, channel: unknown) => void> = [];
        mountClient((_p, cb) => { opened.push(cb); });

        const host = new SshHost(sshConfig);
        const pending = Array.from({ length: 8 }, () => host.connectSocket("/var/run/docker.sock"));

        await vi.waitFor(() => expect(opened).toHaveLength(8));
        opened.forEach((cb) => cb(undefined, new PassThrough()));
        await Promise.all(pending);

        await host.dispose();
    });

    it("names the two causes when the server refuses to forward", async () => {
        // ssh2 reports this as a bare channel-open failure, which tells an
        // operator nothing about what to change on the server.
        mountClient((_p, cb) => setImmediate(() => cb(new Error("(SSH) Channel open failure: administratively prohibited"), null)));

        const host = new SshHost(sshConfig);
        const failure = host.connectSocket("/var/run/docker.sock");

        await expect(failure).rejects.toThrow(/AllowStreamLocalForwarding/);
        await expect(failure).rejects.toThrow(/OpenSSH 6\.7/);
        await expect(failure).rejects.toThrow(/\/var\/run\/docker\.sock/);
        await host.dispose();
    });

    it("keeps credentials out of the failure message", async () => {
        mountClient((_p, cb) => setImmediate(() => cb(new Error("refused"), null)));

        const host = new SshHost(sshConfig);
        await expect(host.connectSocket("/var/run/docker.sock")).rejects.toThrow(
            expect.objectContaining({ message: expect.not.stringContaining("hunter2") }) as Error,
        );
        await host.dispose();
    });

    it("rejects after disposal instead of reconnecting", async () => {
        mountClient((_p, cb) => setImmediate(() => cb(undefined, new PassThrough())));

        const host = new SshHost(sshConfig);
        await host.dispose();
        await expect(host.connectSocket("/var/run/docker.sock")).rejects.toThrow(/already been disposed/);
    });
});

describe("CompositeHost.connectSocket", () => {
    it("goes to the exec host, like every other connection", async () => {
        // MSSQL's legacy mode runs commands locally and moves files over SSH. A
        // socket belongs to whoever runs the commands, not to whoever holds the
        // file transport.
        const exec = { connectSocket: vi.fn(async () => new PassThrough()), dispose: vi.fn(async () => {}) };
        const files = { connectSocket: vi.fn(async () => new PassThrough()), dispose: vi.fn(async () => {}) };

        const host = new CompositeHost(
            exec as unknown as ConstructorParameters<typeof CompositeHost>[0],
            files as unknown as ConstructorParameters<typeof CompositeHost>[1],
        );
        await host.connectSocket("/var/run/docker.sock");

        expect(exec.connectSocket).toHaveBeenCalledWith("/var/run/docker.sock");
        expect(files.connectSocket).not.toHaveBeenCalled();
    });
});
