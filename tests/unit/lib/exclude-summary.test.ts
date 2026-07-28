/**
 * Reporting what exclude patterns kept out.
 *
 * The load-bearing property is that the output stays small: execution logs are stored as a
 * JSON string on the Execution row, so listing every excluded path would put megabytes into
 * the database for a source containing a `node_modules` - on every single run. Grouping by
 * pattern ties the size to the number of patterns, not the number of files, and still answers
 * the question a user has: did one of my patterns take more than I meant it to?
 */
import { describe, it, expect } from "vitest";
import { summariseExcluded, formatExcludeSummary } from "@/lib/exclude-summary";

const file = (path: string, size = 100) => ({ path, size });

describe("summariseExcluded", () => {
    it("groups files under the pattern that matched them", () => {
        const breakdown = summariseExcluded(
            [file("node_modules/a.js"), file("node_modules/b.js"), file("cache.tmp")],
            ["node_modules/**", "*.tmp"]
        );

        expect(breakdown.totalFiles).toBe(3);
        expect(breakdown.byPattern).toHaveLength(2);
        expect(breakdown.byPattern[0]).toMatchObject({ pattern: "node_modules/**", files: 2 });
        expect(breakdown.byPattern[1]).toMatchObject({ pattern: "*.tmp", files: 1 });
    });

    it("counts a file once even when two patterns match it", () => {
        // Otherwise the per-pattern counts would not add up to the total, and a user reading
        // the breakdown could not tell how much was actually left out.
        const breakdown = summariseExcluded([file("cache.tmp")], ["*.tmp", "cache.*"]);

        expect(breakdown.totalFiles).toBe(1);
        expect(breakdown.byPattern.reduce((sum, p) => sum + p.files, 0)).toBe(1);
    });

    it("sums the bytes so a large exclusion is visible as such", () => {
        const breakdown = summariseExcluded([file("a.tmp", 1000), file("b.tmp", 2000)], ["*.tmp"]);

        expect(breakdown.totalBytes).toBe(3000);
        expect(breakdown.byPattern[0].bytes).toBe(3000);
    });

    it("puts the biggest contributor first", () => {
        const breakdown = summariseExcluded(
            [file("one.tmp"), file("node_modules/a"), file("node_modules/b"), file("node_modules/c")],
            ["*.tmp", "node_modules/**"]
        );

        expect(breakdown.byPattern[0].pattern).toBe("node_modules/**");
    });

    it("keeps at most a handful of example paths per pattern", () => {
        // This is the cap that keeps the log small: 10.000 matches must not become 10.000 paths.
        const many = Array.from({ length: 10_000 }, (_, i) => file(`node_modules/pkg-${i}/index.js`));
        const breakdown = summariseExcluded(many, ["node_modules/**"]);

        expect(breakdown.byPattern[0].files).toBe(10_000);
        expect(breakdown.byPattern[0].samples.length).toBeLessThanOrEqual(5);
    });

    it("returns empty totals when nothing was excluded", () => {
        expect(summariseExcluded([], ["*.tmp"])).toMatchObject({ totalFiles: 0, totalBytes: 0, byPattern: [] });
    });

    it("still accounts for a file when no pattern explains it", () => {
        // Should not happen, but losing files from the count would be worse than an odd label.
        const breakdown = summariseExcluded([file("mystery.bin")], []);

        expect(breakdown.totalFiles).toBe(1);
        expect(breakdown.byPattern[0].files).toBe(1);
    });
});

describe("formatExcludeSummary", () => {
    it("states the totals in the message and the per-pattern figures in the details", () => {
        const { message, details } = formatExcludeSummary(
            summariseExcluded([file("a.tmp", 1024), file("node_modules/x", 2048)], ["*.tmp", "node_modules/**"])
        );

        expect(message).toContain("2 file(s) skipped by exclude patterns");
        expect(details).toContain("*.tmp");
        expect(details).toContain("node_modules/**");
    });

    it("says how many more matched instead of listing them", () => {
        const many = Array.from({ length: 500 }, (_, i) => file(`logs/${i}.log`));
        const { details } = formatExcludeSummary(summariseExcluded(many, ["logs/**"]));

        expect(details).toContain("and 495 more");
        // The whole point: the detail block stays a few lines regardless of the match count.
        expect(details.split("\n").length).toBeLessThan(10);
    });

    it("stays compact even with many patterns and huge match counts", () => {
        const patterns = Array.from({ length: 12 }, (_, i) => `dir${i}/**`);
        const files = patterns.flatMap((p, i) =>
            Array.from({ length: 5_000 }, (_, n) => file(`${p.replace("/**", "")}/f${n}`, 100 * (i + 1)))
        );

        const { details } = formatExcludeSummary(summariseExcluded(files, patterns));

        expect(files).toHaveLength(60_000);
        // 12 patterns * (1 header + 5 samples + 1 "and more") = 84 lines, not 60.000.
        expect(details.split("\n").length).toBeLessThanOrEqual(12 * 7);
    });

    describe("pruned directories", () => {
        it("reports directories that were skipped without being read", () => {
            // A pruned tree contributes no files, so without this the summary would say
            // nothing at all about the largest thing a pattern left out.
            const breakdown = summariseExcluded([], ["node_modules/**"], [
                { path: "node_modules", pattern: "node_modules/**" },
                { path: "packages/app/node_modules", pattern: "node_modules/**" },
            ]);

            expect(breakdown.prunedDirectories).toBe(2);
            expect(breakdown.byPattern[0]).toMatchObject({ pattern: "node_modules/**", prunedCount: 2 });

            const { message, details } = formatExcludeSummary(breakdown);
            expect(message).toContain("2 director(ies) not scanned");
            expect(details).toContain("packages/app/node_modules");
        });

        it("counts files and pruned directories for the same pattern together", () => {
            const breakdown = summariseExcluded(
                [file("cache/a.tmp", 10)],
                ["cache/**"],
                [{ path: "cache/deep", pattern: "cache/**" }]
            );

            expect(breakdown.byPattern).toHaveLength(1);
            expect(breakdown.byPattern[0]).toMatchObject({ files: 1, prunedCount: 1 });
        });

        it("says nothing about pruning when nothing was pruned", () => {
            const { message } = formatExcludeSummary(summariseExcluded([file("a.log", 5)], ["*.log"]));

            expect(message).not.toContain("not scanned");
        });
    });
});
