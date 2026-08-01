/**
 * Slash trimming, and the reason it is not a regex.
 *
 * `/^\/+/` and `/\/+$/` are quadratic on a run of slashes - CodeQL flags them as
 * `js/polynomial-redos`, and the alert is correct: a trailing quantifier is unanchored at
 * the start, so the engine restarts at every position and backtracks through the rest.
 */

import { describe, it, expect } from "vitest";
import { stripLeadingSlashes, stripSlashes, stripTrailingSlashes } from "@/lib/paths";

describe("slash trimming", () => {
    it("strips trailing slashes only", () => {
        expect(stripTrailingSlashes("/srv/backups///")).toBe("/srv/backups");
        expect(stripTrailingSlashes("/srv/backups")).toBe("/srv/backups");
        expect(stripTrailingSlashes("///")).toBe("");
        expect(stripTrailingSlashes("")).toBe("");
    });

    it("strips leading slashes only", () => {
        expect(stripLeadingSlashes("///srv/backups")).toBe("srv/backups");
        expect(stripLeadingSlashes("srv/backups")).toBe("srv/backups");
        expect(stripLeadingSlashes("///")).toBe("");
    });

    it("strips both ends", () => {
        expect(stripSlashes("//srv/backups//")).toBe("srv/backups");
        expect(stripSlashes("/")).toBe("");
        expect(stripSlashes("a")).toBe("a");
    });

    it("matches what the regex versions produced", () => {
        // The behaviour has to be identical, or replacing them changes path handling.
        for (const input of ["", "/", "//", "a/", "/a", "//a//", "a//b", "///a///b///"]) {
            expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
            expect(stripLeadingSlashes(input)).toBe(input.replace(/^\/+/, ""));
            expect(stripSlashes(input)).toBe(input.replace(/^\/+/, "").replace(/\/+$/, ""));
            // The storage adapters spelled it as one global alternation rather
            // than two passes, so parity is asserted against that form too.
            expect(stripSlashes(input)).toBe(input.replace(/^\/+|\/+$/g, ""));
        }
    });

    it("stays linear on a long run of slashes", () => {
        // The regex version takes roughly 0.8 s here and quadruples with every doubling.
        // A generous ceiling, so a slow CI machine does not make this flaky - it is four
        // orders of magnitude away from what the quadratic version costs.
        const pathological = "/".repeat(200_000) + "x";

        const started = performance.now();
        expect(stripTrailingSlashes(pathological)).toBe(pathological);
        expect(stripLeadingSlashes(pathological)).toBe("x");
        expect(performance.now() - started).toBeLessThan(500);
    });
});
