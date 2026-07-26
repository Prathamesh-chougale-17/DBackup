import type { BulkResult } from "@/lib/core/bulk";

/**
 * Calls a bulk endpoint and unwraps its result.
 *
 * The split this enforces matters: a rejected promise means the *request* failed, so
 * nothing is known about any row and the caller keeps the selection for a retry. A
 * resolved `BulkResult` means the request was handled and the per-row outcomes inside it
 * are the answer, including when every row failed.
 */
export async function requestBulk(url: string, body: unknown): Promise<BulkResult> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok || !payload?.success || !payload?.data) {
        throw new Error(payload?.error || "The action could not be completed.");
    }

    return payload.data as BulkResult;
}

/**
 * Same contract as `requestBulk`, for the entities that go through a Server Action.
 *
 * Worth spelling out because the surrounding code has a habit of writing
 * `toast.promise(action, ...)`, which treats the resolved envelope as success and would
 * silently hide the failed half of a batch.
 */
export async function unwrapBulkAction(
    action: Promise<{ success: boolean; data?: BulkResult; error?: string }>
): Promise<BulkResult> {
    const result = await action;

    if (!result.success || !result.data) {
        throw new Error(result.error || "The action could not be completed.");
    }

    return result.data;
}
