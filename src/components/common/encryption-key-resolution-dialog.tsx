"use client";

import { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { getEncryptionProfiles, recoverEncryptionKeyAction } from "@/app/actions/backup/encryption";

export type KeyResolutionResult =
    | { type: "profile"; profileId: string }
    | { type: "rawKey"; keyHex: string };

/**
 * Where the backup lives, when it is one the server can reach.
 *
 * Present means a typed key can be checked against the backup itself and then kept in the
 * vault, which is what makes the next step - and anything running unattended later - work
 * without asking again. Absent (an uploaded file) leaves the key in play for this one
 * operation, because there is no stored backup left to test it against.
 */
export interface RecoverableBackup {
    storageConfigId: string;
    file: string;
}

interface EncryptionKeyResolutionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The profile ID from the backup metadata (shown as hint). */
    profileIdHint?: string;
    /** Enables checking a typed key against the backup and saving it to the vault. */
    backup?: RecoverableBackup;
    /** Whether this user may create vault profiles. Without it, only picking one is offered. */
    canManageVault?: boolean;
    /** Called when the user confirms a key selection. */
    onConfirm: (result: KeyResolutionResult) => void;
    /** Shows a spinner on the confirm button while the parent is processing. */
    loading?: boolean;
    /** Why the last attempt did not work. Keeps the dialog usable for a second try. */
    error?: string;
}

export function EncryptionKeyResolutionDialog({
    open,
    onOpenChange,
    profileIdHint,
    backup,
    canManageVault = true,
    onConfirm,
    loading = false,
    error,
}: EncryptionKeyResolutionDialogProps) {
    const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
    const [selectedProfileId, setSelectedProfileId] = useState<string>("");
    const [rawKeyHex, setRawKeyHex] = useState("");
    const [profileName, setProfileName] = useState("");
    const [rawKeyError, setRawKeyError] = useState("");
    const [recovering, setRecovering] = useState(false);
    const [activeTab, setActiveTab] = useState<"profile" | "rawKey">("profile");

    // A typed key is only offered where it can lead somewhere: the server must be able to
    // reach the backup to test it, and the user must be allowed to create the profile.
    const canUseRawKey = !backup || canManageVault;
    const savesToVault = Boolean(backup) && canManageVault;

    // Fetch profiles when dialog opens; auto-switch to raw key tab if vault is empty
    useEffect(() => {
        if (!open) return;
        getEncryptionProfiles().then((res) => {
            if (res.success && res.data) {
                const mapped = res.data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
                setProfiles(mapped);
                setActiveTab(mapped.length === 0 && canUseRawKey ? "rawKey" : "profile");
            } else if (canUseRawKey) {
                setActiveTab("rawKey");
            }
        }).catch(() => { if (canUseRawKey) setActiveTab("rawKey"); });
    }, [open, canUseRawKey]);

    const handleConfirm = async () => {
        if (activeTab === "profile") {
            if (!selectedProfileId) return;
            onConfirm({ type: "profile", profileId: selectedProfileId });
            return;
        }

        const clean = rawKeyHex.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
            setRawKeyError("Must be a 64-character hex string (32 bytes).");
            return;
        }
        setRawKeyError("");

        if (!savesToVault) {
            // No stored backup to test against - the operation itself is the check.
            onConfirm({ type: "rawKey", keyHex: clean });
            return;
        }

        setRecovering(true);
        try {
            const res = await recoverEncryptionKeyAction(backup!.storageConfigId, backup!.file, clean, profileName.trim() || undefined);
            if (!res.success || !res.data?.profileId) {
                setRawKeyError(res.error ?? "This key does not open this backup.");
                return;
            }

            toast.success(
                res.data.status === "existing"
                    ? `That key is already in the vault as "${res.data.profileName}".`
                    : `Key saved to the vault as "${res.data.profileName}".`
            );
            // From here it is an ordinary profile, so the retry needs nothing special.
            onConfirm({ type: "profile", profileId: res.data.profileId });
        } catch (e: unknown) {
            setRawKeyError(e instanceof Error ? e.message : "Could not check this key.");
        } finally {
            setRecovering(false);
        }
    };

    const busy = loading || recovering;
    const isConfirmDisabled =
        busy ||
        (activeTab === "profile" && !selectedProfileId) ||
        (activeTab === "rawKey" && rawKeyHex.trim().length === 0);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <div className="flex items-center gap-2">
                        <KeyRound className="h-5 w-5 text-amber-500" />
                        <DialogTitle>Encryption Key Required</DialogTitle>
                    </div>
                    <DialogDescription>
                        The encryption key for this backup could not be resolved automatically.
                        Please specify the key to use for decryption.
                    </DialogDescription>
                </DialogHeader>

                {profileIdHint && (
                    <Alert variant="default" className="bg-muted">
                        <ShieldAlert className="h-4 w-4" />
                        <AlertDescription className="text-xs font-mono break-all">
                            Expected profile ID: {profileIdHint}
                        </AlertDescription>
                    </Alert>
                )}

                {error && (
                    <Alert variant="destructive">
                        <ShieldAlert className="h-4 w-4" />
                        <AlertDescription className="text-sm">{error}</AlertDescription>
                    </Alert>
                )}

                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "profile" | "rawKey")}>
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="profile">Select Profile</TabsTrigger>
                        <TabsTrigger value="rawKey" disabled={!canUseRawKey}>Enter Raw Key</TabsTrigger>
                    </TabsList>

                    <TabsContent value="profile" className="space-y-3 pt-2">
                        <div className="space-y-2">
                            <Label>Encryption Profile (Vault)</Label>
                            {profiles.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {canUseRawKey
                                        ? "No encryption profiles found in this vault. Import the original key first, or use the raw key tab."
                                        : "No encryption profiles found in this vault. Ask a vault administrator to import the original key."}
                                </p>
                            ) : (
                                <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select a vault profile..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {profiles.map((p) => (
                                            <SelectItem key={p.id} value={p.id}>
                                                {p.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="rawKey" className="space-y-3 pt-2">
                        <div className="space-y-2">
                            <Label htmlFor="rawKeyHex">Master Key (64-char hex)</Label>
                            <Input
                                id="rawKeyHex"
                                value={rawKeyHex}
                                onChange={(e) => {
                                    setRawKeyHex(e.target.value);
                                    setRawKeyError("");
                                }}
                                placeholder="e.g. a3f9c1..."
                                className="font-mono text-sm"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            {rawKeyError && (
                                <p className="text-xs text-destructive">{rawKeyError}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {savesToVault
                                    ? "The raw 32-byte AES-256-GCM key exported from Security Vault. It is checked against this backup and then saved as a new vault profile, so every later step - including anything running in the background - can use it."
                                    : "The raw 32-byte AES-256-GCM key exported from Security Vault. This key is used once for decryption and is not stored."}
                            </p>
                        </div>

                        {savesToVault && (
                            <div className="space-y-2">
                                <Label htmlFor="recoveredProfileName">Save as (optional)</Label>
                                <Input
                                    id="recoveredProfileName"
                                    value={profileName}
                                    onChange={(e) => setProfileName(e.target.value)}
                                    placeholder="Named after this backup's job when left empty"
                                    autoComplete="off"
                                />
                            </div>
                        )}
                    </TabsContent>
                </Tabs>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={isConfirmDisabled}>
                        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {recovering ? "Checking key..." : loading ? "Decrypting..." : "Decrypt"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
