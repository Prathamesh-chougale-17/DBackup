import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("ssh2", () => ({ Client: vi.fn() }));

import { Client } from "ssh2";
import { SshHost } from "@/lib/transport/ssh-host";
import type { SshConnectionConfig } from "@/lib/transport/types";

const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

/** A fake ssh2 exec channel: a Duplex that is stdout, with stderr on the side. */
class FakeChannel extends PassThrough {
    readonly stderr = new PassThrough();
    signal = vi.fn();
    close = vi.fn();

    finish(code: number, stdout = "", stderr = "") {
        if (stdout) this.write(stdout);
        if (stderr) this.stderr.write(stderr);
        this.end();
        this.stderr.end();
        this.emit("exit", code);
        this.emit("close");
    }
}

type FakeClient = EventEmitter & {
    connect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    sftp: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
};

const config: SshConnectionConfig = {
    host: "10.0.0.4",
    port: 2222,
    username: "ops",
    authType: "password",
    password: "hunter2",
};

describe("SshHost", () => {
    let client: FakeClient;
    let channels: FakeChannel[];
    let commands: string[];

    beforeEach(() => {
        vi.clearAllMocks();
        channels = [];
        commands = [];

        client = Object.assign(new EventEmitter(), {
            connect: vi.fn(() => setImmediate(() => client.emit("ready"))),
            exec: vi.fn((command: string, cb: (err: Error | undefined, ch: FakeChannel) => void) => {
                commands.push(command);
                const channel = new FakeChannel();
                channels.push(channel);
                setImmediate(() => cb(undefined, channel));
            }),
            sftp: vi.fn(),
            end: vi.fn(),
        }) as FakeClient;

        MockClient.mockImplementation(function () {
            return client;
        });
    });

    it("does not connect until an operation needs the connection", async () => {
        const host = new SshHost(config);
        expect(client.connect).not.toHaveBeenCalled();

        // Lazy connect is what keeps test() able to report a failed handshake as
        // { success: false } instead of throwing out of withHost.
        const pending = host.exec(["true"]);
        await vi.waitFor(() => expect(channels.length).toBe(1));
        expect(client.connect).toHaveBeenCalledTimes(1);
        channels[0].finish(0);
        await pending;
        await host.dispose();
    });

    it("reuses one connection across many commands", async () => {
        const host = new SshHost(config);
        const first = host.exec(["echo", "a"]);
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(0, "a\n");
        await first;

        const second = host.exec(["echo", "b"]);
        await vi.waitFor(() => expect(channels.length).toBe(2));
        channels[1].finish(0, "b\n");
        await second;

        expect(client.connect).toHaveBeenCalledTimes(1);
        await host.dispose();
    });

    it("renders argv through the shell escaper", async () => {
        const host = new SshHost(config);
        const pending = host.exec(["mysqldump", "--databases", "a'b"]);
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(0);
        await pending;

        expect(commands[0]).toBe("'mysqldump' '--databases' 'a'\\''b'");
        await host.dispose();
    });

    it("keeps secrets out of the command arguments", async () => {
        const host = new SshHost(config);
        const pending = host.exec(["mysqldump", "-h", "db"], { env: { MYSQL_PWD: "s3cr3t" } });
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(0);
        await pending;

        expect(commands[0]).toBe("export MYSQL_PWD='s3cr3t'; 'mysqldump' '-h' 'db'");
        // Everything after the exports is what shows up in the remote process list.
        expect(commands[0].slice(commands[0].indexOf("'mysqldump'"))).not.toContain("s3cr3t");
        await host.dispose();
    });

    it("returns a non-zero exit code without throwing", async () => {
        const host = new SshHost(config);
        const pending = host.exec(["false"]);
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(2, "", "denied");

        const result = await pending;
        expect(result.code).toBe(2);
        expect(result.stderr).toBe("denied");
        await host.dispose();
    });

    it("resolves a binary with command -v and memoizes the lookup", async () => {
        const host = new SshHost(config);
        const first = host.which("mariadb-dump", "mysqldump");
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(0, "/usr/bin/mariadb-dump\n");

        expect(await first).toBe("/usr/bin/mariadb-dump");
        expect(commands[0]).toBe("'command' '-v' 'mariadb-dump'");

        // The second call must not open another channel.
        expect(host.which("mariadb-dump", "mysqldump")).toBe(first);
        expect(channels.length).toBe(1);
        await host.dispose();
    });

    it("tries every candidate before giving up", async () => {
        const host = new SshHost(config);
        const pending = host.which("mariadb-dump", "mysqldump");

        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(1);
        await vi.waitFor(() => expect(channels.length).toBe(2));
        channels[1].finish(1);

        await expect(pending).rejects.toThrow(/mariadb-dump, mysqldump/);
        await host.dispose();
    });

    it("caps concurrent channels so the server session limit is not exhausted", async () => {
        // OpenSSH allows 10 sessions by default and SFTP claims one. Postgres
        // counts tables under Promise.all, so an uncapped fan-out is reachable.
        const host = new SshHost(config);
        const running = Array.from({ length: 10 }, (_, i) => host.exec(["echo", String(i)]));

        await vi.waitFor(() => expect(channels.length).toBe(4));
        expect(channels.length).toBe(4);

        channels[0].finish(0);
        await vi.waitFor(() => expect(channels.length).toBe(5));

        channels.slice(1).forEach((channel) => channel.finish(0));
        await Promise.all(running.slice(0, 5));
        await host.dispose();
    });

    it("closes the client on dispose and stays idempotent", async () => {
        const host = new SshHost(config);
        const pending = host.exec(["true"]);
        await vi.waitFor(() => expect(channels.length).toBe(1));
        channels[0].finish(0);
        await pending;

        await host.dispose();
        expect(client.end).toHaveBeenCalledTimes(1);

        await expect(host.dispose()).resolves.toBeUndefined();
        expect(client.end).toHaveBeenCalledTimes(1);
    });

    it("rejects further work after disposal", async () => {
        const host = new SshHost(config);
        await host.dispose();
        await expect(host.exec(["true"])).rejects.toThrow(/already been disposed/);
    });

    it("never puts credentials in the loggable label", () => {
        const host = new SshHost(config);
        expect(host.label).toBe("ssh://ops@10.0.0.4:2222");
        expect(host.label).not.toContain("hunter2");
    });
});

/**
 * Channel event timing.
 *
 * ssh2 delivers a short command's output, exit status and close in the same
 * batch. Anything the caller does after an `await` therefore happens too late
 * to observe them, which is what these two tests pin down. The bugs they cover
 * both looked the same from the outside: a command that plainly succeeded was
 * reported as a failure.
 */
describe("SshHost channel timing", () => {
    let client: FakeClient;

    function mountClient(exec: FakeClient["exec"]) {
        client = Object.assign(new EventEmitter(), {
            connect: vi.fn(() => setImmediate(() => client.emit("ready"))),
            exec,
            sftp: vi.fn(),
            end: vi.fn(),
        }) as FakeClient;
        MockClient.mockImplementation(function () {
            return client;
        });
    }

    it("keeps the exit status when it arrives inside the exec callback", async () => {
        // The exit status is emitted before an awaiting caller could resume.
        // Losing it left exec() reporting `code: null` for a successful
        // command, which every `code !== 0` check in the adapters reads as a
        // failure - it surfaced as "binary not found" for a binary that exists.
        mountClient(vi.fn((_command: string, cb: (err: undefined, ch: FakeChannel) => void) => {
            const channel = new FakeChannel();
            setImmediate(() => {
                cb(undefined, channel);
                channel.write('/usr/bin/psql\n');
                channel.emit('exit', 0);
                setImmediate(() => {
                    channel.end();
                    channel.emit('close');
                });
            });
        }));

        const host = new SshHost(config);
        const result = await host.exec(['command', '-v', 'psql']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe('/usr/bin/psql\n');
    });

    it("does not hang when a stream closes without ever ending", async () => {
        // `close` was observed arriving before `end`, so the output is read
        // only after the streams settle. That wait has to stay bounded: a
        // channel's stderr can close without ever ending, and kill() leaves a
        // destroyed stream behind. Waiting for `end` unconditionally would
        // deadlock every command that hits either case.
        mountClient(vi.fn((_command: string, cb: (err: undefined, ch: FakeChannel) => void) => {
            const channel = new FakeChannel();
            setImmediate(() => {
                cb(undefined, channel);
                channel.write('one\ntwo\nthree\n');
                channel.emit('exit', 0);
                // Only `close`, and stderr is left dangling on purpose.
                setImmediate(() => channel.emit('close'));
            });
        }));

        const host = new SshHost(config);
        const result = await host.exec(['mysql', '-e', 'SHOW DATABASES']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe('one\ntwo\nthree\n');
    });
});
