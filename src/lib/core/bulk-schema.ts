import { z } from "zod";
import { BULK_REQUEST_LIMIT } from "./bulk";

/**
 * The id list every bulk entry point accepts.
 *
 * Separate from `bulk.ts` so that module stays free of a zod import, since it is also
 * pulled into client bundles through the table components.
 */
export const BulkIdsSchema = z.array(z.string().min(1)).min(1).max(BULK_REQUEST_LIMIT);
