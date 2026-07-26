/**
 * Curated exclude groups and how a preset resolves against them.
 *
 * The reason groups live in code is that a release must be able to extend them without a
 * migration and without overwriting anything a user wrote. That only holds if a preset stores
 * a *reference* and the patterns are resolved at use time - which is what these pin, along
 * with the opt-out that keeps following a curated list from being all-or-nothing.
 */
import { describe, it, expect } from "vitest";
import {
    EXCLUDE_GROUPS,
    findExcludeGroup,
    resolveExcludePatterns,
    parseJsonStringArray,
} from "@/lib/exclude-groups";

describe("exclude group catalogue", () => {
    it("has unique ids", () => {
        const ids = EXCLUDE_GROUPS.map((g) => g.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every group a label and at least one pattern", () => {
        for (const group of EXCLUDE_GROUPS) {
            expect(group.label.length, group.id).toBeGreaterThan(0);
            expect(group.patterns.length, group.id).toBeGreaterThan(0);
        }
    });

    it("covers the files Dropbox refuses outright", () => {
        // .DS_Store is why this whole thing exists: Dropbox rejects it with
        // path/disallowed_name, so a restore carrying it can only fail.
        const all = EXCLUDE_GROUPS.flatMap((g) => g.patterns);
        expect(all).toContain(".DS_Store");
        expect(all).toContain("Thumbs.db");
        expect(all).toContain("desktop.ini");
    });

    it("returns nothing for an unknown id rather than throwing", () => {
        expect(findExcludeGroup("no-such-group")).toBeUndefined();
    });
});

describe("resolveExcludePatterns", () => {
    it("expands a referenced group into its patterns", () => {
        const resolved = resolveExcludePatterns({ groups: ["macos"] });
        expect(resolved).toContain(".DS_Store");
        expect(resolved).toContain("._*");
    });

    it("combines groups with the preset's own patterns", () => {
        const resolved = resolveExcludePatterns({ groups: ["macos"], patterns: ["*.iso"] });
        expect(resolved).toContain(".DS_Store");
        expect(resolved).toContain("*.iso");
    });

    it("drops a single pattern the preset opted out of, keeping the rest of the group", () => {
        // The point of the opt-out: following a curated list is not all-or-nothing.
        const resolved = resolveExcludePatterns({ groups: ["macos"], excludedGroupPatterns: [".Trashes"] });
        expect(resolved).not.toContain(".Trashes");
        expect(resolved).toContain(".DS_Store");
    });

    it("never drops the preset's own pattern, even when a group opt-out names it", () => {
        // Opting out applies to what a group contributes; writing it yourself is an explicit
        // decision that must win.
        const resolved = resolveExcludePatterns({
            groups: ["macos"],
            excludedGroupPatterns: [".DS_Store"],
            patterns: [".DS_Store"],
        });
        expect(resolved).toContain(".DS_Store");
    });

    it("deduplicates a pattern that a group and the preset both list", () => {
        const resolved = resolveExcludePatterns({ groups: ["macos"], patterns: [".DS_Store"] });
        expect(resolved.filter((p) => p === ".DS_Store")).toHaveLength(1);
    });

    it("skips a group id that no longer exists", () => {
        // A group removed in a later release must not break a preset still referencing it.
        const resolved = resolveExcludePatterns({ groups: ["macos", "retired-group"] });
        expect(resolved).toContain(".DS_Store");
    });

    it("returns an empty list when nothing is configured", () => {
        expect(resolveExcludePatterns({})).toEqual([]);
    });

    it("resolves fresh each time, so extending a group reaches existing presets", () => {
        // The property the whole design rests on: the preset stores ids, not a snapshot.
        const stored = { groups: ["windows"] };
        expect(resolveExcludePatterns(stored)).toEqual(findExcludeGroup("windows")!.patterns);
    });
});

describe("parseJsonStringArray", () => {
    it("reads a stored array", () => {
        expect(parseJsonStringArray('["a","b"]')).toEqual(["a", "b"]);
    });

    it("treats malformed or absent content as empty rather than throwing", () => {
        // A broken row must not take a backup run down; no exclusions is the safe direction.
        expect(parseJsonStringArray("not json")).toEqual([]);
        expect(parseJsonStringArray(null)).toEqual([]);
        expect(parseJsonStringArray('{"not":"an array"}')).toEqual([]);
    });

    it("drops non-string entries", () => {
        expect(parseJsonStringArray('["a",1,null,"b"]')).toEqual(["a", "b"]);
    });
});
