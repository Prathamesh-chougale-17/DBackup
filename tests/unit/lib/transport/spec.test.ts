import { describe, it, expect } from "vitest";

import {
    PREFIXED_SSH_KEYS,
    UNPREFIXED_SSH_KEYS,
    readSshConfig,
    resolveTransport,
    standardTransport,
} from "@/lib/transport/spec";
import { ConfigurationError } from "@/lib/logging/errors";
import type { TransportResolver } from "@/lib/transport/types";

const fullSsh = {
    connectionMode: "ssh",
    sshHost: "10.0.0.4",
    sshPort: 2222,
    sshUsername: "ops",
    sshAuthType: "privateKey",
    sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    sshPassphrase: "secret",
};

describe("standardTransport", () => {
    it("treats an absent connectionMode as direct", () => {
        // resolveAdapterConfig returns decrypted JSON without running Zod, so the
        // schema's .default("direct") never applies at runtime. The default has to
        // live in code or stored rows would take an unintended branch.
        expect(standardTransport({})).toEqual({ kind: "direct" });
    });

    it("treats an explicit direct mode as direct", () => {
        expect(standardTransport({ connectionMode: "direct" })).toEqual({ kind: "direct" });
    });

    it("does not mistake the Redis mode field for a transport setting", () => {
        // RedisSchema has its own `mode` with values standalone / sentinel. A
        // generic reader sniffing config.mode would route Redis over SSH by accident.
        expect(standardTransport({ mode: "sentinel", host: "redis" })).toEqual({ kind: "direct" });
        expect(standardTransport({ mode: "ssh", host: "redis" })).toEqual({ kind: "direct" });
    });

    it("builds an ssh spec from the prefixed fields", () => {
        expect(standardTransport(fullSsh)).toEqual({
            kind: "ssh",
            ssh: {
                host: "10.0.0.4",
                port: 2222,
                username: "ops",
                authType: "privateKey",
                password: undefined,
                privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
                passphrase: "secret",
            },
        });
    });

    it("throws instead of silently falling back when SSH fields are incomplete", () => {
        // Falling back to direct here would connect to a different machine than
        // the user configured, and report it as healthy.
        expect(() => standardTransport({ connectionMode: "ssh", sshUsername: "ops" }))
            .toThrow(/SSH host or username is missing/);
        expect(() => standardTransport({ connectionMode: "ssh", sshHost: "10.0.0.4" }))
            .toThrow(/SSH host or username is missing/);
    });
});

describe("readSshConfig", () => {
    it("defaults the port to 22", () => {
        const ssh = readSshConfig({ sshHost: "h", sshUsername: "u" }, PREFIXED_SSH_KEYS);
        expect(ssh?.port).toBe(22);
    });

    it("coerces a port arriving as a string from a form", () => {
        const ssh = readSshConfig({ sshHost: "h", sshUsername: "u", sshPort: "2222" }, PREFIXED_SSH_KEYS);
        expect(ssh?.port).toBe(2222);
    });

    it("falls back to password for an unknown auth type", () => {
        const ssh = readSshConfig({ sshHost: "h", sshUsername: "u", sshAuthType: "kerberos" }, PREFIXED_SSH_KEYS);
        expect(ssh?.authType).toBe("password");
    });

    it("reads SQLite's unprefixed convention", () => {
        const ssh = readSshConfig(
            { host: "nas.local", port: 22, username: "pi", authType: "password", password: "pw" },
            UNPREFIXED_SSH_KEYS,
        );
        expect(ssh).toEqual({
            host: "nas.local",
            port: 22,
            username: "pi",
            authType: "password",
            password: "pw",
            privateKey: undefined,
            passphrase: undefined,
        });
    });

    it("returns null when host or username is missing", () => {
        expect(readSshConfig({ sshUsername: "u" }, PREFIXED_SSH_KEYS)).toBeNull();
        expect(readSshConfig({ sshHost: "h" }, PREFIXED_SSH_KEYS)).toBeNull();
        expect(readSshConfig({}, PREFIXED_SSH_KEYS)).toBeNull();
    });

    it("supports MSSQL's fallback from sshHost to the database host", () => {
        // MssqlSshTransfer used `config.sshHost || config.host`, which the standard
        // resolver does not do. The behaviour has to survive the migration.
        const ssh = readSshConfig(
            { host: "sql.internal", sshUsername: "ops" },
            PREFIXED_SSH_KEYS,
            { hostFallbackKey: "host" },
        );
        expect(ssh?.host).toBe("sql.internal");
    });

    it("prefers an explicit sshHost over the fallback", () => {
        const ssh = readSshConfig(
            { host: "sql.internal", sshHost: "jump.internal", sshUsername: "ops" },
            PREFIXED_SSH_KEYS,
            { hostFallbackKey: "host" },
        );
        expect(ssh?.host).toBe("jump.internal");
    });

    it("ignores empty strings, which is how cleared form fields arrive", () => {
        expect(readSshConfig({ sshHost: "", sshUsername: "u" }, PREFIXED_SSH_KEYS)).toBeNull();
    });
});

describe("resolveTransport", () => {
    it("uses the standard convention when the adapter declares no resolver", () => {
        expect(resolveTransport({ id: "mysql" }, { connectionMode: "direct" })).toEqual({ kind: "direct" });
    });

    it("uses the adapter's own resolver when present", () => {
        const sqliteTransport: TransportResolver = (config) =>
            config.mode === "ssh"
                ? { kind: "ssh", ssh: readSshConfig(config, UNPREFIXED_SSH_KEYS)! }
                : { kind: "direct" };

        const spec = resolveTransport(
            { id: "sqlite", transport: sqliteTransport },
            { mode: "ssh", host: "nas", username: "pi" },
        );
        expect(spec).toMatchObject({ kind: "ssh", ssh: { host: "nas", username: "pi" } });
    });

    it("tolerates a null or undefined config", () => {
        expect(resolveTransport({ id: "mysql" }, null)).toEqual({ kind: "direct" });
        expect(resolveTransport({ id: "mysql" }, undefined)).toEqual({ kind: "direct" });
    });

    it("rewraps a resolver failure so the message names the adapter", () => {
        expect(() => resolveTransport({ id: "postgres" }, { connectionMode: "ssh" }))
            .toThrow(ConfigurationError);
        expect(() => resolveTransport({ id: "postgres" }, { connectionMode: "ssh" }))
            .toThrow(/\[postgres\]/);
    });
});
