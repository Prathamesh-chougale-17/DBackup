import { describe, it, expect } from "vitest";
import { canPruneDirectory, matchesAnyExcludePattern, matchesExcludePattern } from "@/lib/exclude-patterns";

/**
 * The negative cases here are the load-bearing ones. Pruning a directory means never listing
 * it, so a wrong "yes" removes files from a backup without anything reporting it - the exact
 * failure nobody notices until a restore.
 */
describe("canPruneDirectory", () => {
    describe("prunes a directory whose entire contents are excluded", () => {
        const cases: [string, string][] = [
            ["node_modules/**", "node_modules"],
            ["**/node_modules/**", "node_modules"],
            ["**/node_modules/**", "packages/app/node_modules"],
            ["{cache,tmp}/**", "cache"],
            ["dir/**/*", "dir"],
            [".git/**", ".git"],
            ["**", "anything"],
        ];

        it.each(cases)("pattern %s prunes %s", (pattern, dir) => {
            expect(canPruneDirectory(dir, [pattern])).toBe(pattern);
        });
    });

    describe("refuses to prune when files below could still be wanted", () => {
        const cases: [string, string, string][] = [
            ["node_modules/*", "node_modules", "only direct children are excluded, deeper ones are not"],
            ["dir/**/*.log", "dir", "only log files are excluded, everything else is kept"],
            ["*.log", "somedir", "matches no file in this directory at all"],
            ["*.log", "foo.log", "matchBase matches the directory's own name, not its contents"],
            ["cache", "cache", "a bare name excludes nothing inside the directory it names"],
            ["node_modules", "node_modules", "same - this is why self-match must never prune"],
        ];

        it.each(cases)("pattern %s does not prune %s because it %s", (pattern, dir) => {
            expect(canPruneDirectory(dir, [pattern])).toBeUndefined();
        });
    });

    it("requires one single pattern to cover every depth", () => {
        // Between them these cover one and two levels down, but a file three levels deep is
        // still wanted. Accepting a different pattern per depth would drop it.
        expect(canPruneDirectory("dir", ["dir/*", "dir/*/*"])).toBeUndefined();
    });

    it("returns the pattern responsible, so the skip can be attributed", () => {
        expect(canPruneDirectory("node_modules", ["*.log", "node_modules/**"])).toBe("node_modules/**");
    });

    it("prunes nothing without patterns, and nothing at the root", () => {
        expect(canPruneDirectory("node_modules", [])).toBeUndefined();
        expect(canPruneDirectory("node_modules", undefined)).toBeUndefined();
        expect(canPruneDirectory("", ["**"])).toBeUndefined();
    });

    it("ignores blank patterns rather than treating them as match-everything", () => {
        expect(canPruneDirectory("anything", ["   "])).toBeUndefined();
    });

    it("agrees with the file matcher about what a bare directory name excludes", () => {
        // The premise behind refusing self-match: a bare "node_modules" genuinely does not
        // exclude the files inside it today. If this ever changes, pruning has to change too.
        expect(matchesAnyExcludePattern("node_modules/react/index.js", ["node_modules"])).toBe(false);
        expect(matchesAnyExcludePattern("node_modules/react/index.js", ["node_modules/**"])).toBe(true);
    });
});

describe("matchesExcludePattern", () => {
    it("matches a single pattern the same way the any-matcher does", () => {
        expect(matchesExcludePattern("logs/app.log", "*.log")).toBe(true);
        expect(matchesExcludePattern("logs/app.txt", "*.log")).toBe(false);
    });

    it("treats a blank pattern as matching nothing", () => {
        expect(matchesExcludePattern("anything", "  ")).toBe(false);
    });
});
