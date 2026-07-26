"use client";

import { useCallback, useRef, useState } from "react";
import type { KeyResolutionResult } from "@/components/common/encryption-key-resolution-dialog";

/**
 * Client half of the key-required contract.
 *
 * Any request that opens an encrypted backup can come back with 422 and
 * `code: "ENCRYPTION_KEY_REQUIRED"`. The answer is always the same - ask for a key, then do
 * the same thing again - so it lives here once rather than being rebuilt in the storage
 * explorer, the restore page and the settings page.
 *
 * The retry is a plain repeat of the original request. Supplying a key through the dialog
 * puts it in the vault, so by the time the retry runs there is nothing special to pass.
 */
export function useEncryptionKeyRecovery() {
    const [open, setOpen] = useState(false);
    const [profileIdHint, setProfileIdHint] = useState("");
    const [loading, setLoading] = useState(false);
    const retryRef = useRef<((result: KeyResolutionResult) => void | Promise<void>) | null>(null);

    /**
     * Checks whether a response is asking for a key.
     *
     * @param response - The response to inspect. Read through a clone, so the caller's own
     * handling of the body is unaffected.
     * @param retry - Run once the user has supplied a key.
     * @returns true when the dialog has taken over and the caller should stop here.
     */
    const intercept = useCallback(async (
        response: Response,
        retry: (result: KeyResolutionResult) => void | Promise<void>
    ): Promise<boolean> => {
        if (response.status !== 422) return false;

        const payload: { code?: string; profileId?: string } =
            await response.clone().json().catch(() => ({}));
        if (payload.code !== "ENCRYPTION_KEY_REQUIRED") return false;

        retryRef.current = retry;
        setProfileIdHint(payload.profileId ?? "");
        setLoading(false);
        setOpen(true);
        return true;
    }, []);

    const onConfirm = useCallback(async (result: KeyResolutionResult) => {
        const retry = retryRef.current;
        if (!retry) return;

        setLoading(true);
        try {
            await retry(result);
            setOpen(false);
            retryRef.current = null;
        } catch {
            // Left open, and swallowed rather than rethrown: the dialog is not awaited by
            // its caller, so an escaping rejection would be unhandled. A retry that failed
            // reports its own reason, and the user can try another key here.
        } finally {
            setLoading(false);
        }
    }, []);

    const onOpenChange = useCallback((next: boolean) => {
        setOpen(next);
        if (!next) {
            retryRef.current = null;
            setProfileIdHint("");
        }
    }, []);

    return { open, profileIdHint, loading, intercept, onConfirm, onOpenChange };
}
