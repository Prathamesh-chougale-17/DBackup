"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { CredentialField } from "./credential-field";
import type { SshFieldState, SshKeySource } from "./ssh-key-payload";
import { SSH_KEY_TYPES, type SshKeyType } from "@/lib/core/credentials";

const KEY_TYPE_LABELS: Record<SshKeyType, string> = {
    ed25519: "Ed25519 (recommended)",
    "rsa-4096": "RSA 4096",
    "ecdsa-p256": "ECDSA P-256",
    "ecdsa-p384": "ECDSA P-384",
};

/**
 * Payload fields of an `SSH_KEY` credential profile.
 *
 * Private-key auth can either take a pasted key or ask DBackup to generate one. The generate
 * path sends a `generate` request instead of key material, so the private key is created on
 * the server and never reaches the browser.
 */
export function SshKeyFields({
    data,
    update,
    showSecrets,
    defaultComment,
}: {
    data: SshFieldState;
    update: (key: string, value: string) => void;
    showSecrets: boolean;
    /** Suggested key comment, derived from the profile name. */
    defaultComment: string;
}) {
    const secret = showSecrets ? "text" : "password";
    const authType = data.authType ?? "password";
    const keySource = (data.keySource ?? "paste") as SshKeySource;

    return (
        <div className="space-y-3">
            <CredentialField
                label="Username"
                value={data.username ?? ""}
                onChange={(v) => update("username", v)}
            />

            <div className="space-y-1.5">
                <Label className="text-xs">Auth method</Label>
                <Select value={authType} onValueChange={(v) => update("authType", v)}>
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="password">Password</SelectItem>
                        <SelectItem value="privateKey">Private Key</SelectItem>
                        <SelectItem value="agent">SSH Agent</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {authType === "password" && (
                <CredentialField
                    label="Password"
                    type={secret}
                    value={data.password ?? ""}
                    onChange={(v) => update("password", v)}
                />
            )}

            {authType === "privateKey" && (
                <>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Private key</Label>
                        <Select value={keySource} onValueChange={(v) => update("keySource", v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="paste">Use an existing key</SelectItem>
                                <SelectItem value="generate">Generate a new keypair</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {keySource === "paste" ? (
                        <>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Private key (PEM)</Label>
                                <Textarea
                                    value={data.privateKey ?? ""}
                                    onChange={(e) => update("privateKey", e.target.value)}
                                    className="font-mono text-xs resize-y h-16 field-sizing-fixed"
                                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                    style={
                                        !showSecrets
                                            ? ({
                                                  WebkitTextSecurity: "disc",
                                                  textSecurity: "disc",
                                              } as React.CSSProperties)
                                            : undefined
                                    }
                                />
                                {(data.privateKey ?? "").includes("BEGIN ENCRYPTED PRIVATE KEY") && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400">
                                        PKCS#8 encrypted key detected. Make sure to fill in the
                                        passphrase field below.
                                    </p>
                                )}
                            </div>
                            <CredentialField
                                label="Key passphrase (optional)"
                                type={secret}
                                value={data.passphrase ?? ""}
                                onChange={(v) => update("passphrase", v)}
                            />
                        </>
                    ) : (
                        <>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Key type</Label>
                                <Select
                                    value={data.keyType ?? "ed25519"}
                                    onValueChange={(v) => update("keyType", v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {SSH_KEY_TYPES.map((t) => (
                                            <SelectItem key={t} value={t}>
                                                {KEY_TYPE_LABELS[t]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <CredentialField
                                label="Comment"
                                value={data.keyComment ?? ""}
                                onChange={(v) => update("keyComment", v)}
                                placeholder={defaultComment}
                            />
                            <CredentialField
                                label="Key passphrase (optional)"
                                type={secret}
                                value={data.passphrase ?? ""}
                                onChange={(v) => update("passphrase", v)}
                            />
                            {data.passphrase && (
                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                    A Rsync destination cannot use a passphrase-protected key.
                                    It runs the OpenSSH client in batch mode, which has no way
                                    to answer the prompt.
                                </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                The keypair is created on the server when you save. The private
                                key is stored encrypted and never shown. The public key is
                                displayed afterwards so you can install it on the host.
                            </p>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

