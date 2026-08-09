import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOURLY_TIER,
  DEFAULT_RETENTION_CONFIG,
  RetentionConfigurationSchema,
} from "@/lib/core/retention";

describe("DEFAULT_RETENTION_CONFIG", () => {
  it("has mode NONE", () => {
    expect(DEFAULT_RETENTION_CONFIG.mode).toBe("NONE");
  });

  it("has no simple or smart policy by default", () => {
    expect(DEFAULT_RETENTION_CONFIG.simple).toBeUndefined();
    expect(DEFAULT_RETENTION_CONFIG.smart).toBeUndefined();
  });
});

describe("RetentionConfigurationSchema", () => {
  const smart = { daily: 7, weekly: 4, monthly: 12, yearly: 2 };

  it("accepts a smart policy without an hourly tier", () => {
    const parsed = RetentionConfigurationSchema.parse({ mode: "SMART", smart });

    expect(parsed.smart?.hourly).toBeUndefined();
    expect(parsed.smart?.daily).toBe(7);
  });

  it("accepts an hourly tier", () => {
    const parsed = RetentionConfigurationSchema.parse({
      mode: "SMART",
      smart: { ...smart, hourly: DEFAULT_HOURLY_TIER },
    });

    expect(parsed.smart?.hourly).toBe(24);
  });

  it("coerces a numeric string tier, since form and API input arrives as text", () => {
    const parsed = RetentionConfigurationSchema.parse({
      mode: "SMART",
      smart: { ...smart, hourly: "24" },
    });

    expect(parsed.smart?.hourly).toBe(24);
  });

  it("rejects a negative tier", () => {
    expect(() =>
      RetentionConfigurationSchema.parse({ mode: "SMART", smart: { ...smart, hourly: -1 } })
    ).toThrow();
  });

  it("rejects a fractional tier", () => {
    expect(() =>
      RetentionConfigurationSchema.parse({ mode: "SMART", smart: { ...smart, hourly: 1.5 } })
    ).toThrow();
  });

  it("rejects a non numeric tier", () => {
    expect(() =>
      RetentionConfigurationSchema.parse({ mode: "SMART", smart: { ...smart, daily: "many" } })
    ).toThrow();
  });

  it("rejects a keepCount below 1, which would delete every backup", () => {
    expect(() =>
      RetentionConfigurationSchema.parse({ mode: "SIMPLE", simple: { keepCount: 0 } })
    ).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() => RetentionConfigurationSchema.parse({ mode: "KEEP_LAST" })).toThrow();
  });
});
