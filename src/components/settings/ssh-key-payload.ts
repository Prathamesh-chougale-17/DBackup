/**
 * Translation between the SSH credential form and the API payload.
 *
 * Kept apart from the fields component so it can be tested on its own, and because the form
 * carries state the API must never see: which key source is selected and what to generate.
 */

/** Form state of the credential dialog. Every value is a string, as the inputs produce them. */
export type SshFieldState = Record<string, string | undefined>;

/** Where the private key comes from when `authType` is `privateKey`. */
export type SshKeySource = "paste" | "generate";

/**
 * Builds the `SSH_KEY` payload for the API.
 *
 * Only the fields the selected auth method actually uses are sent, so a private key typed
 * before switching to password auth is not stored alongside the password. Generating sends a
 * `generate` request in place of key material, which the server answers by creating the key
 * where it is encrypted.
 */
export function buildSshPayload(
    data: SshFieldState,
    /** Used when the comment field was left blank. */
    defaultComment?: string
): Record<string, unknown> {
    const authType = data.authType || "password";
    const base: Record<string, unknown> = { username: data.username, authType };

    if (authType === "password") return prune({ ...base, password: data.password });
    if (authType === "agent") return prune(base);

    if ((data.keySource ?? "paste") === "generate") {
        return prune({
            ...base,
            generate: {
                keyType: data.keyType || "ed25519",
                comment: data.keyComment?.trim() || defaultComment || undefined,
                passphrase: data.passphrase || undefined,
            },
        });
    }

    return prune({ ...base, privateKey: data.privateKey, passphrase: data.passphrase });
}

/**
 * Whether the payload block holds anything worth sending.
 *
 * `authType` always has a value, so it cannot count towards this. Letting it count meant every
 * edit of an existing SSH profile submitted a payload of just that field and was rejected for
 * a missing username, which made renaming one impossible without retyping the secret.
 */
export function hasSshPayload(data: SshFieldState): boolean {
    if ((data.authType ?? "password") === "privateKey" && data.keySource === "generate") {
        return true;
    }
    return ["username", "password", "privateKey", "passphrase"].some((key) => !!data[key]);
}

function prune(payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== "") out[key] = value;
    }
    return out;
}
