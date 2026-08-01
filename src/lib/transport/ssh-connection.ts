import { Client, type ConnectConfig } from "ssh2";

import { normalizeSshPrivateKey } from "@/lib/ssh/pkcs8-compat";
import type { SshConnectionConfig } from "./types";

/** Handshake budget. Matches the previous SshClient so behaviour does not shift. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Translate a normalized SSH config into ssh2's ConnectConfig.
 *
 * Kept separate from SshHost so the auth handling, including the PKCS#8
 * workaround, can be tested without standing up a whole host.
 */
export function buildConnectConfig(config: SshConnectionConfig): ConnectConfig {
    const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
    };

    if (config.authType === "privateKey") {
        // ssh2 cannot read PKCS#8 encrypted keys (BEGIN ENCRYPTED PRIVATE KEY),
        // so those are decrypted in memory first.
        if (config.privateKey?.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
            if (!config.passphrase) {
                throw new Error("This private key is passphrase-protected. Please provide the passphrase.");
            }
            connectConfig.privateKey = normalizeSshPrivateKey(config.privateKey, config.passphrase);
        } else {
            connectConfig.privateKey = config.privateKey;
            if (config.passphrase) {
                connectConfig.passphrase = config.passphrase;
            }
        }
    } else if (config.authType === "agent") {
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
    } else {
        connectConfig.password = config.password;
    }

    return connectConfig;
}

/** Open an authenticated ssh2 client, or reject with the handshake error. */
export function openSshClient(config: SshConnectionConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
        let connectConfig: ConnectConfig;
        try {
            connectConfig = buildConnectConfig(config);
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }

        const client = new Client();
        const onError = (err: Error) => {
            client.removeListener("ready", onReady);
            reject(err);
        };
        const onReady = () => {
            client.removeListener("error", onError);
            resolve(client);
        };

        client.once("ready", onReady).once("error", onError).connect(connectConfig);
    });
}
