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
 * The reasoning for formats deliberately left off the list is not checked here, because it
 * is not in the guide - it lives as a comment in `src/lib/incompressible-formats.ts`, next
 * to the list it explains and in front of the only audience that needs it.
 *
 * Run with: pnpm test tests/unit/lint-guards/incompressible-formats-doc.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { INCOMPRESSIBLE_EXTENSIONS } from "@/lib/incompressible-formats";

const ROOT = path.resolve(__dirname, "../../..");
const DOC = path.join(ROOT, "docs/user-guide/security/compression.md");

const START = "### Formats stored as-is";
const END = "### Behaviour";

/**
 * Every backticked extension in the section's table.
 *
 * Only lines that are table rows are read, so the prose around the table can mention an
 * extension in backticks without being mistaken for an entry. Structural problems throw
 * rather than assert: a renamed heading is a broken guard rather than a failed expectation,
 * and it has to say so wherever it is called from.
 */
function documentedExtensions(): string[] {
    const doc = fs.readFileSync(DOC, "utf-8");
    const relative = path.relative(ROOT, DOC);

    const from = doc.indexOf(START);
    if (from === -1) throw new Error(`'${START}' is missing from ${relative}`);
    const to = doc.indexOf(END, from);
    if (to === -1) throw new Error(`'${END}' is missing after '${START}' in ${relative}`);

    return doc
        .slice(from, to)
        .split("\n")
        .filter((line) => line.trimStart().startsWith("|"))
        .flatMap((line) => {
            const cell = line.split("|")[2];
            return cell ? [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
        });
}

describe("lint guard: the documented format table matches the code", () => {
    it("finds the table in the document", () => {
        expect(documentedExtensions().length).toBeGreaterThan(0);
    });

    it("documents every extension the code skips", () => {
        const listed = documentedExtensions();
        const undocumented = [...INCOMPRESSIBLE_EXTENSIONS].filter((e) => !listed.includes(e)).sort();
        expect(undocumented, "add these to the table in compression.md").toEqual([]);
    });

    it("documents no extension the code does not skip", () => {
        const invented = documentedExtensions().filter((e) => !INCOMPRESSIBLE_EXTENSIONS.has(e)).sort();
        expect(invented, "these are in the table but not in INCOMPRESSIBLE_EXTENSIONS").toEqual([]);
    });

    it("lists each extension exactly once", () => {
        const listed = documentedExtensions();
        const duplicates = listed.filter((e, i) => listed.indexOf(e) !== i).sort();
        expect(duplicates).toEqual([]);
    });
});
