/**
 * SSH keypair generation in OpenSSH format.
 *
 * Generation goes through ssh2's own keygen rather than a hand-written encoder. ssh2 is
 * already the library that parses these keys at connect time, so a key it writes is a key it
 * can read, and the output is the same canonical `-----BEGIN OPENSSH PRIVATE KEY-----` file
 * that `ssh-keygen` produces. The Rsync destination hands the key to the OpenSSH client
 * instead, which reads the same format.
 *
 * A passphrase is optional and produces the same `bcrypt` KDF plus `aes256-ctr` encryption
 * that `ssh-keygen` writes, so both readers accept it. The one place it does not work is the
 * Rsync destination, which runs the OpenSSH client with `BatchMode=yes` and never supplies a
 * passphrase. That is true of pasted encrypted keys as well, so the UI warns rather than
 * refusing.
 */

import { createHash } from "crypto";
import { utils as sshUtils } from "ssh2";
import type { SshKeyType } from "@/lib/core/credentials";

export interface GeneratedSshKey {
    /** Private key in OpenSSH format. Stored encrypted, never returned to a client. */
    privateKey: string;
    /** Public half as an `authorized_keys` line. */
    publicKey: string;
    /** `SHA256:...`, the same value `ssh-keygen -lf` prints. */
    fingerprint: string;
}

/** What ssh2's keygen returns, minus the fields this module does not use. */
type KeyPair = { private: string; public: string };

/**
 * Normalizes a key comment into something safe to write into an `authorized_keys` line.
 *
 * A newline here would end the line early, so a comment could smuggle a second entry into
 * the file a user pastes it into. Control characters go, whitespace collapses, and the
 * result is capped at a length that still fits on screen.
 */
export function sanitizeKeyComment(raw: string): string {
    return raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Generates a keypair of the requested type, encrypted with `passphrase` when one is given.
 *
 * Asynchronous because an RSA 4096 keypair takes seconds to produce, which would otherwise
 * block the event loop for every other request in the process.
 */
export async function generateSshKeyPair(
    keyType: SshKeyType,
    comment: string,
    passphrase?: string
): Promise<GeneratedSshKey> {
    const pair = await generatePair(keyType, sanitizeKeyComment(comment), passphrase);
    return {
        privateKey: pair.private,
        publicKey: pair.public,
        fingerprint: sshFingerprint(pair.public) ?? "",
    };
}

/**
 * Derives the public half of a private key.
 *
 * Used for keys that were pasted rather than generated, so the profile can show which key to
 * install on a host without anyone needing the reveal permission. Best effort by design: an
 * unparseable or passphrase-protected key returns null and the profile simply has no public
 * half on record.
 */
export function readPublicKey(
    privateKey: string,
    passphrase?: string
): { publicKey: string; fingerprint: string } | null {
    try {
        const parsed = passphrase
            ? sshUtils.parseKey(privateKey, passphrase)
            : sshUtils.parseKey(privateKey);
        if (parsed instanceof Error || Array.isArray(parsed)) return null;

        const blob = parsed.getPublicSSH();
        if (!blob?.length) return null;

        const comment = sanitizeKeyComment(parsed.comment ?? "");
        const line = `${parsed.type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
        return { publicKey: line, fingerprint: fingerprintOf(blob) };
    } catch {
        // Whatever was pasted is not a key this can read, which is not an error worth failing
        // the save over. The profile simply has no public half on record.
        return null;
    }
}

/**
 * Fingerprint of an `authorized_keys` line, or null if the line is not one.
 */
export function sshFingerprint(publicKeyLine: string): string | null {
    const blob = publicKeyLine.trim().split(/\s+/)[1];
    if (!blob) return null;
    try {
        const decoded = Buffer.from(blob, "base64");
        return decoded.length > 0 ? fingerprintOf(decoded) : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** OpenSSH prints the SHA-256 of the raw public key blob, base64 without padding. */
function fingerprintOf(publicBlob: Buffer): string {
    return `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`;
}

/**
 * What `ssh-keygen` itself writes for an encrypted key, so nothing downstream has to special
 * case ours. An empty passphrase means no encryption at all, not encryption with an empty key.
 */
function encryptionOptions(
    passphrase?: string
): { passphrase: string; cipher: string; rounds: number } | Record<string, never> {
    return passphrase ? { passphrase, cipher: "aes256-ctr", rounds: 16 } : {};
}

/**
 * The switch exists so each branch hits ssh2's typed overload for that algorithm. A single
 * call with a widened key type does not type-check, and the alternative is a cast.
 */
function generatePair(
    keyType: SshKeyType,
    comment: string,
    passphrase?: string
): Promise<KeyPair> {
    return new Promise((resolve, reject) => {
        const done = (err: Error | null, pair: KeyPair) => (err ? reject(err) : resolve(pair));
        const opts = { comment, ...encryptionOptions(passphrase) };
        switch (keyType) {
            case "rsa-4096":
                sshUtils.generateKeyPair("rsa", { bits: 4096, ...opts }, done);
                return;
            case "ecdsa-p256":
                sshUtils.generateKeyPair("ecdsa", { bits: 256, ...opts }, done);
                return;
            case "ecdsa-p384":
                sshUtils.generateKeyPair("ecdsa", { bits: 384, ...opts }, done);
                return;
            default:
                sshUtils.generateKeyPair("ed25519", opts, done);
        }
    });
}
