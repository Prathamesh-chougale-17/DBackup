/**
 * Lint Guard: the published format table matches the code.
 *
 * `docs/user-guide/security/compression.md` lists every extension that is stored without
 * compression. A published list that has drifted is worse than none: someone reads it,
 * concludes their `.psd` archive is being recompressed for nothing, and changes a job
 * setting on the strength of a table that stopped being true two releases ago.
 *
 * The whole point of shipping the list as code is that a release can extend it. This guard
 * is what makes extending it also update the docs, instead of quietly leaving them behind.
 *
 * Run with: pnpm test tests/unit/lint-guards/incompressible-formats-doc.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { INCOMPRESSIBLE_EXTENSIONS, isIncompressible } from "@/lib/incompressible-formats";

const ROOT = path.resolve(__dirname, "../../..");
const DOC = path.join(ROOT, "docs/user-guide/security/compression.md");

const START = "### Formats stored as-is";
const OMITTED = "| Not on the list |";
const END = "### Behaviour";

/** Backticked values in one column of every table row, header and separator included. */
function extensionsInColumn(markdown: string, column: number): string[] {
    return markdown
        .split("\n")
        .filter((line) => line.trimStart().startsWith("|"))
        .flatMap((line) => {
            const cell = line.split("|")[column];
            return cell ? [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
        });
}

/**
 * Both tables of the section, parsed on first use.
 *
 * Structural problems throw rather than assert: this runs from inside a test, but a renamed
 * heading is a broken guard rather than a failed expectation, and it has to say so wherever
 * it is called from.
 */
function documentedSections(): { listed: string[]; omitted: string[] } {
    const doc = fs.readFileSync(DOC, "utf-8");
    const relative = path.relative(ROOT, DOC);

    const from = doc.indexOf(START);
    if (from === -1) throw new Error(`'${START}' is missing from ${relative}`);
    const to = doc.indexOf(END, from);
    if (to === -1) throw new Error(`'${END}' is missing after '${START}' in ${relative}`);

    const section = doc.slice(from, to);
    const split = section.indexOf(OMITTED);
    if (split === -1) throw new Error(`the '${OMITTED}' table is missing from ${relative}`);

    return {
        listed: extensionsInColumn(section.slice(0, split), 2),
        omitted: extensionsInColumn(section.slice(split), 1),
    };
}

describe("lint guard: the documented format table matches the code", () => {
    it("finds both tables in the document", () => {
        const { listed, omitted } = documentedSections();
        expect(listed.length).toBeGreaterThan(0);
        expect(omitted.length).toBeGreaterThan(0);
    });

    it("documents every extension the code skips", () => {
        const { listed } = documentedSections();
        const undocumented = [...INCOMPRESSIBLE_EXTENSIONS].filter((e) => !listed.includes(e)).sort();
        expect(undocumented, "add these to the table in compression.md").toEqual([]);
    });

    it("documents no extension the code does not skip", () => {
        const { listed } = documentedSections();
        const invented = listed.filter((e) => !INCOMPRESSIBLE_EXTENSIONS.has(e)).sort();
        expect(invented, "these are in the table but not in INCOMPRESSIBLE_EXTENSIONS").toEqual([]);
    });

    it("lists each extension exactly once", () => {
        const { listed } = documentedSections();
        const duplicates = listed.filter((e, i) => listed.indexOf(e) !== i).sort();
        expect(duplicates).toEqual([]);
    });

    it("keeps the two tables from contradicting each other", () => {
        // The second table explains why a format is NOT skipped. One appearing in both would
        // document the same extension as skipped and not skipped on the same page.
        const { omitted } = documentedSections();
        const contradictions = omitted.filter((e) => isIncompressible(`file.${e}`)).sort();
        expect(contradictions, "these are documented as compressed but the code skips them").toEqual([]);
    });
});
