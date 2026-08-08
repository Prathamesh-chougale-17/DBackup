/**
 * Which names an adapter uses for its SSH identity fields.
 *
 * Two conventions exist. Most adapters spread `sshFields` and get `sshUsername`,
 * `sshPrivateKey` and so on, because they already have a `username` of their own for the
 * database. SQLite has no database login at all, so its schema reuses the plain names.
 *
 * The convention used to be inferred from "does this adapter have a primary credential
 * slot". That was never the actual rule - it was a proxy that happened to hold while SQLite
 * was the only adapter without a primary slot. Docker volumes broke it: no primary slot
 * either, because a Docker socket has no login, but prefixed field names because it spreads
 * `sshFields` like everything else. The result was a credential profile writing `username`
 * into a config whose transport reads `sshUsername`, so SSH mode could not connect at all.
 *
 * Asking the schema is the real question, and it cannot drift from what the schema says.
 */

/**
 * Only the shape is needed, so that is all this asks for.
 *
 * Typing it as a Zod object would drag zod's generics through every caller for a question
 * that is really just "does this schema have that key".
 */
type SchemaLike = { shape: Record<string, unknown> } | undefined;

/** What `sshFields` declares, and what `standardTransport` reads. */
export const PREFIXED_SSH_KEYS = [
    "sshUsername", "sshAuthType", "sshPassword", "sshPrivateKey", "sshPassphrase",
] as const;

/** SQLite's convention: no database login, so the plain names are free. */
export const UNPREFIXED_SSH_KEYS = [
    "username", "authType", "password", "privateKey", "passphrase",
] as const;

export function usesPrefixedSshKeys(schema: SchemaLike): boolean {
    return !!schema && "sshUsername" in schema.shape;
}

/**
 * The keys an assigned SSH credential profile owns for this adapter.
 *
 * Used both by the overlay that writes them into a resolved config and by the form that
 * hides them once a profile is picked. Those two must agree, which is the other reason this
 * is one function rather than two lists.
 */
export function sshManagedKeys(schema: SchemaLike): readonly string[] {
    return usesPrefixedSshKeys(schema) ? PREFIXED_SSH_KEYS : UNPREFIXED_SSH_KEYS;
}
