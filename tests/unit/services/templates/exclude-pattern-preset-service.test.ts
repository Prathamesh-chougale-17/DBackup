/**
 * Exclude pattern presets, and what makes them different from the other templates.
 *
 * Two rules carry weight here. Several presets may be default at once - their patterns are
 * unioned, so starring one must not unstar another, unlike a naming template where exactly one
 * can win. And a built-in preset can be edited but never deleted, because it ships with the
 * product; unstarring is how a user opts out of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "@/lib/testing/prisma-mock";

vi.mock("@/lib/logging/logger", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  updateExcludePatternPreset,
  deleteExcludePatternPreset,
  getDefaultExcludePatternPresets,
} from "@/services/templates/exclude-pattern-preset-service";
import { ServiceError } from "@/lib/logging/errors";

const makePreset = (overrides: object = {}) => ({
  id: "preset-1",
  name: "System Junk Files",
  description: null,
  patterns: '[".DS_Store","Thumbs.db"]',
  isDefault: false,
  isSystem: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe("exclude pattern preset defaults", () => {
  it("stars a preset without touching the others", async () => {
    // A naming template clears the previous default; here several apply together, so nothing
    // else may be unstarred as a side effect.
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset() as never);
    prismaMock.excludePatternPreset.update.mockResolvedValue(makePreset({ isDefault: true }) as never);

    await updateExcludePatternPreset("preset-1", { isDefault: true });

    expect(prismaMock.excludePatternPreset.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "preset-1" }, data: expect.objectContaining({ isDefault: true }) })
    );
    expect(prismaMock.excludePatternPreset.updateMany).not.toHaveBeenCalled();
  });

  it("can unstar a preset again", async () => {
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset({ isDefault: true }) as never);
    prismaMock.excludePatternPreset.update.mockResolvedValue(makePreset() as never);

    await updateExcludePatternPreset("preset-1", { isDefault: false });

    expect(prismaMock.excludePatternPreset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: false }) })
    );
  });

  it("leaves the default flag alone when the update does not mention it", async () => {
    // Editing only the patterns must not silently clear the star.
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset({ isDefault: true }) as never);
    prismaMock.excludePatternPreset.update.mockResolvedValue(makePreset({ isDefault: true }) as never);

    await updateExcludePatternPreset("preset-1", { patterns: ["*.tmp"] });

    const data = prismaMock.excludePatternPreset.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("isDefault");
  });

  it("returns only the starred presets for pre-selection", async () => {
    prismaMock.excludePatternPreset.findMany.mockResolvedValue([makePreset({ isDefault: true })] as never);

    await getDefaultExcludePatternPresets();

    expect(prismaMock.excludePatternPreset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDefault: true } })
    );
  });
});

describe("built-in preset protection", () => {
  it("refuses to delete a system preset, naming the way out", async () => {
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset({ isSystem: true }) as never);

    await expect(deleteExcludePatternPreset("preset-1")).rejects.toThrow(ServiceError);
    expect(prismaMock.excludePatternPreset.delete).not.toHaveBeenCalled();
  });

  it("still allows editing a system preset's patterns", async () => {
    // The built-in list is a starting point, not a rule - a user may well want to add to it.
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset({ isSystem: true }) as never);
    prismaMock.excludePatternPreset.update.mockResolvedValue(makePreset({ isSystem: true }) as never);

    await expect(updateExcludePatternPreset("preset-1", { patterns: [".DS_Store", "*.swp"] })).resolves.toBeTruthy();
  });

  it("deletes an ordinary preset", async () => {
    prismaMock.excludePatternPreset.findUnique.mockResolvedValue(makePreset() as never);
    prismaMock.excludePatternPreset.delete.mockResolvedValue(makePreset() as never);

    await deleteExcludePatternPreset("preset-1");

    expect(prismaMock.excludePatternPreset.delete).toHaveBeenCalledWith({ where: { id: "preset-1" } });
  });
});
