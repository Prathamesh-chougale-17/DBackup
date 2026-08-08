import { describe, it, expect } from "vitest";
import { buildSshPayload, hasSshPayload } from "@/components/settings/ssh-key-payload";

/** The dialog's starting state for a new SSH profile, as `DEFAULTS.SSH_KEY` sets it. */
const EMPTY = {
    username: "",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
    keySource: "paste",
    keyType: "ed25519",
    keyComment: "",
};

describe("buildSshPayload", () => {
    it("sends only what password auth uses", () => {
        expect(
            buildSshPayload({ ...EMPTY, username: "backup", password: "pw" })
        ).toEqual({ username: "backup", authType: "password", password: "pw" });
    });

    it("drops a private key left over from a switch to password auth", () => {
        const payload = buildSshPayload({
            ...EMPTY,
            username: "backup",
            password: "pw",
            privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
            passphrase: "leftover",
        });

        expect(payload.privateKey).toBeUndefined();
        expect(payload.passphrase).toBeUndefined();
    });

    it("sends nothing but the identity for agent auth", () => {
        expect(
            buildSshPayload({ ...EMPTY, username: "backup", authType: "agent", password: "pw" })
        ).toEqual({ username: "backup", authType: "agent" });
    });

    it("sends a pasted key with its passphrase", () => {
        expect(
            buildSshPayload({
                ...EMPTY,
                username: "backup",
                authType: "privateKey",
                privateKey: "KEY",
                passphrase: "secret",
            })
        ).toEqual({
            username: "backup",
            authType: "privateKey",
            privateKey: "KEY",
            passphrase: "secret",
        });
    });

    it("asks the server to generate instead of sending key material", () => {
        expect(
            buildSshPayload({
                ...EMPTY,
                username: "backup",
                authType: "privateKey",
                keySource: "generate",
                keyType: "rsa-4096",
                keyComment: "  dbackup@prod  ",
                privateKey: "typed earlier",
            })
        ).toEqual({
            username: "backup",
            authType: "privateKey",
            generate: {
                keyType: "rsa-4096",
                comment: "dbackup@prod",
                passphrase: undefined,
            },
        });
    });

    it("passes a passphrase to the generator rather than storing it separately", () => {
        const payload = buildSshPayload({
            ...EMPTY,
            username: "backup",
            authType: "privateKey",
            keySource: "generate",
            passphrase: "correct horse",
        });

        expect(payload.generate).toEqual({
            keyType: "ed25519",
            comment: undefined,
            passphrase: "correct horse",
        });
        expect(payload.passphrase).toBeUndefined();
    });

    it("falls back to the suggested comment when the field is blank", () => {
        const form = {
            ...EMPTY,
            username: "backup",
            authType: "privateKey",
            keySource: "generate",
        };

        expect(buildSshPayload(form, "dbackup@prod-sftp").generate).toEqual({
            keyType: "ed25519",
            comment: "dbackup@prod-sftp",
        });
        expect(buildSshPayload(form).generate).toEqual({
            keyType: "ed25519",
            comment: undefined,
        });
    });

    it("keeps form-only fields out of every other payload", () => {
        const payload = buildSshPayload(
            { ...EMPTY, username: "backup", password: "pw" },
            "dbackup@prod"
        );

        expect(Object.keys(payload)).toEqual(["username", "authType", "password"]);
    });
});

describe("hasSshPayload", () => {
    it("reports nothing to send for an untouched form", () => {
        // Regression: `authType` always carries a value, so counting it made every edit of an
        // existing profile submit a payload of just that field, which the API rejects for a
        // missing username. Renaming a profile was impossible without retyping the secret.
        expect(hasSshPayload(EMPTY)).toBe(false);
    });

    it("reports a payload once a field is filled in", () => {
        expect(hasSshPayload({ ...EMPTY, username: "backup" })).toBe(true);
        expect(hasSshPayload({ ...EMPTY, password: "pw" })).toBe(true);
        expect(hasSshPayload({ ...EMPTY, privateKey: "KEY" })).toBe(true);
    });

    it("reports a payload when a keypair is to be generated", () => {
        expect(
            hasSshPayload({ ...EMPTY, authType: "privateKey", keySource: "generate" })
        ).toBe(true);
    });
});
