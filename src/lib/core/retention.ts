import { z } from "zod";

export type RetentionMode = "NONE" | "SIMPLE" | "SMART";

export interface SimpleRetentionPolicy {
  keepCount: number;
}

export interface SmartRetentionPolicy {
  /**
   * Keep one per hour for X hours.
   *
   * Optional because every policy written before this tier existed has no value for it,
   * and an absent tier has to behave exactly like a disabled one. Treat a missing value
   * as 0 rather than passing it through to a comparison.
   */
  hourly?: number;
  daily: number; // Keep one per day for X days
  weekly: number; // Keep one per week for X weeks
  monthly: number; // Keep one per month for X months
  yearly: number; // Keep one per year for X years
}

export interface RetentionConfiguration {
  mode: RetentionMode;
  simple?: SimpleRetentionPolicy;
  smart?: SmartRetentionPolicy;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfiguration = {
  mode: "NONE",
};

/** Value pre-filled when the hourly tier is switched on in the policy form. */
export const DEFAULT_HOURLY_TIER = 24;

/** A tier limit. 0 disables the tier, fractions and negatives are rejected. */
const tierLimit = z.coerce.number().int().min(0);

export const SimpleRetentionPolicySchema = z.object({
  keepCount: z.coerce.number().int().min(1),
});

export const SmartRetentionPolicySchema = z.object({
  hourly: tierLimit.optional(),
  daily: tierLimit,
  weekly: tierLimit,
  monthly: tierLimit,
  yearly: tierLimit,
});

/**
 * Validates a retention configuration before it is stored.
 *
 * Retention deletes files, so a config that reaches the engine has to be sound. Without
 * this a value written through the API, such as a negative or non numeric tier, lands in
 * the bucketing logic unchecked.
 */
export const RetentionConfigurationSchema = z.object({
  mode: z.enum(["NONE", "SIMPLE", "SMART"]),
  simple: SimpleRetentionPolicySchema.optional(),
  smart: SmartRetentionPolicySchema.optional(),
});
