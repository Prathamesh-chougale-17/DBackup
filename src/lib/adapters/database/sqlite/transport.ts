import { UNPREFIXED_SSH_KEYS, readSshConfig } from "@/lib/transport";
import type { TransportResolver } from "@/lib/transport";

/**
 * SQLite's transport convention.
 *
 * Every other adapter stores `connectionMode: "ssh"` plus prefixed `sshHost` /
 * `sshUsername` fields. SQLite stores `mode: "ssh"` plus unprefixed `host` /
 * `username`, and that is not an accident that can simply be renamed: the SSH
 * credential overlay in config-resolver.ts picks the unprefixed key map for any
 * adapter without a primary credential slot, which SQLite is. Changing the
 * stored shape would need a data migration of every existing SQLite source.
 *
 * So the shape stays exactly as it is on disk and is read here instead. This is
 * also the reason transport resolution is per adapter rather than one central
 * switch: RedisSchema has its own unrelated `mode` field.
 */
export const sqliteTransport: TransportResolver = (config) => {
    if (config.mode !== "ssh") {
        return { kind: "direct" };
    }

    const ssh = readSshConfig(config, UNPREFIXED_SSH_KEYS);
    if (!ssh) {
        throw new Error(
            "Connection mode is set to SSH but the SSH host or username is missing. " +
                "Check the source's SSH settings and its assigned SSH credential profile.",
        );
    }
    return { kind: "ssh", ssh };
};
