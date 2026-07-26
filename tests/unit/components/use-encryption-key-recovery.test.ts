// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useEncryptionKeyRecovery, keyOverrideBody } from "@/hooks/use-encryption-key-recovery";

/** A 422 shaped like the one every key-required route returns. */
function keyRequired(message = "Encryption profile p is missing, and no other profile could decrypt this file.") {
    return new Response(
        JSON.stringify({ success: false, error: message, code: "ENCRYPTION_KEY_REQUIRED", profileId: "p" }),
        { status: 422, headers: { "Content-Type": "application/json" } }
    );
}

describe("keyOverrideBody", () => {
    it("carries a chosen profile", () => {
        expect(keyOverrideBody({ type: "profile", profileId: "vault-1" })).toEqual({ profileIdOverride: "vault-1" });
    });

    it("puts no raw key on the wire", () => {
        // A typed key is checked and imported before it gets here, so it should never
        // travel with an ordinary request.
        expect(keyOverrideBody({ type: "rawKey", keyHex: "ab".repeat(32) })).toEqual({});
    });

    it("carries nothing when there was no prompt", () => {
        expect(keyOverrideBody(undefined)).toEqual({});
    });
});

describe("useEncryptionKeyRecovery", () => {
    it("ignores a response that is not a key prompt", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());

        let handled = true;
        await act(async () => {
            handled = await result.current.intercept(new Response("{}", { status: 500 }), vi.fn());
        });

        expect(handled).toBe(false);
        expect(result.current.open).toBe(false);
    });

    it("opens the dialog and names the profile the backup wanted", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());

        await act(async () => { await result.current.intercept(keyRequired(), vi.fn()); });

        expect(result.current.open).toBe(true);
        expect(result.current.profileIdHint).toBe("p");
    });

    it("closes and remembers the answer once the retry gets through", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());
        const retry = vi.fn().mockResolvedValue(undefined);

        await act(async () => { await result.current.intercept(keyRequired(), retry); });
        await act(async () => { await result.current.onConfirm({ type: "profile", profileId: "vault-1" }); });

        expect(retry).toHaveBeenCalledWith({ type: "profile", profileId: "vault-1" });
        await waitFor(() => expect(result.current.open).toBe(false));
        // Every later request of the page needs the same answer, not just the one that asked.
        expect(result.current.override).toEqual({ profileIdOverride: "vault-1" });
    });

    it("stays open and says why when the chosen profile does not fit either", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());

        // What a real retry does: run the request again, and be told the same thing again.
        const retry = vi.fn(async () => {
            await result.current.intercept(keyRequired("The supplied key does not open this backup."), retry);
        });

        await act(async () => { await result.current.intercept(keyRequired(), retry); });
        await act(async () => { await result.current.onConfirm({ type: "profile", profileId: "wrong" }); });

        // Closing here would look exactly like success, which is the bug this guards.
        expect(result.current.open).toBe(true);
        expect(result.current.error).toBe("The supplied key does not open this backup.");
        expect(result.current.override).toBeUndefined();
    });

    it("stays open when the retry throws", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());
        const retry = vi.fn().mockRejectedValue(new Error("network down"));

        await act(async () => { await result.current.intercept(keyRequired(), retry); });
        await act(async () => { await result.current.onConfirm({ type: "profile", profileId: "vault-1" }); });

        expect(result.current.open).toBe(true);
        expect(result.current.error).toBe("network down");
    });

    it("forgets the pending retry when the dialog is dismissed", async () => {
        const { result } = renderHook(() => useEncryptionKeyRecovery());
        const retry = vi.fn();

        await act(async () => { await result.current.intercept(keyRequired(), retry); });
        act(() => { result.current.onOpenChange(false); });
        await act(async () => { await result.current.onConfirm({ type: "profile", profileId: "vault-1" }); });

        expect(retry).not.toHaveBeenCalled();
    });
});
