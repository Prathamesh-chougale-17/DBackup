/**
 * The picker for an adapter whose browse has no level below its root.
 *
 * A Docker volume is a name, not a folder. The tree used to offer an expand control at every
 * row that revealed "No subfolders", and a "back up everything" checkbox that stored the
 * adapter's root path - which for a volume source is a mount with no volume name, so it
 * could not have worked at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectoryTree, type DirectoryTreeRow } from "@/components/dashboard/jobs/directory-tree";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const VOLUMES = ["app-data", "web-config", "web-content"];

function mockBrowse(entries: string[] = VOLUMES) {
    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
            success: true,
            supported: true,
            data: { path: "", entries: entries.map((name) => ({ name, path: name })) },
        }),
    }) as never;
}

/** Renders the tree and hands back the latest row list it produced. */
function renderTree(initial: DirectoryTreeRow[] = []) {
    const state = { rows: initial };
    const onRowsChange = vi.fn((rows: DirectoryTreeRow[]) => { state.rows = rows; });
    const view = render(
        <DirectoryTree
            configId="cfg-1"
            rows={state.rows}
            onRowsChange={onRowsChange}
            flat
            itemNoun="volume"
        />
    );
    return { state, onRowsChange, view };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse();
});

describe("the picker for a flat adapter", () => {
    it("offers no expand control, because there is nothing below a volume", async () => {
        renderTree();
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        // One checkbox per volume plus the top row, and no buttons at all - the expand
        // control was the only button the tree rendered per row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(VOLUMES.length + 1);
        expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("says what the top row actually does", async () => {
        renderTree();

        await waitFor(() => expect(screen.getByText("Every volume on this host")).toBeTruthy());
    });

    it("ticks every volume individually instead of storing a root path", async () => {
        // The bug this replaces: the old root checkbox stored "/" as one row, which the
        // adapter turned into a mount with no volume name.
        const { onRowsChange } = renderTree();
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        await userEvent.click(screen.getAllByRole("checkbox")[0]);

        const rows = onRowsChange.mock.calls.at(-1)![0];
        expect(rows.map((r) => r.path).sort()).toEqual([...VOLUMES].sort());
        expect(rows.map((r) => r.path)).not.toContain("/");
        expect(rows.map((r) => r.path)).not.toContain("");
    });

    it("clears them all again when they are already all selected", async () => {
        const { onRowsChange } = renderTree(VOLUMES.map((path) => ({ path, excludePatterns: [], excludePatternPresetIds: [] })));
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        await userEvent.click(screen.getAllByRole("checkbox")[0]);

        expect(onRowsChange.mock.calls.at(-1)![0]).toEqual([]);
    });

    it("leaves a volume the user picked by hand alone when ticking the rest", async () => {
        // Select-all must not drop and recreate the existing row - its exclude patterns and
        // its stop-containers setting live on it.
        const existing = { path: "web-config", excludePatterns: ["*.tmp"], excludePatternPresetIds: ["preset-1"] };
        const { onRowsChange } = renderTree([existing]);
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        await userEvent.click(screen.getAllByRole("checkbox")[0]);

        const rows = onRowsChange.mock.calls.at(-1)![0];
        expect(rows).toHaveLength(VOLUMES.length);
        expect(rows.find((r) => r.path === "web-config")).toEqual(existing);
    });

    it("removes a row when a volume is unticked, instead of excluding it from another row", async () => {
        const rows = VOLUMES.map((path) => ({ path, excludePatterns: [], excludePatternPresetIds: [] }));
        const { onRowsChange } = renderTree(rows);
        await waitFor(() => expect(screen.getByText("web-config")).toBeTruthy());

        // Index 0 is the top row, so web-config is the third volume in load order.
        await userEvent.click(screen.getAllByRole("checkbox")[3]);

        const after = onRowsChange.mock.calls.at(-1)![0];
        expect(after.map((r) => r.path)).toEqual(["app-data", "web-config"]);
        expect(after.flatMap((r) => r.excludePatterns)).toEqual([]);
    });

    it("ignores a leftover root row instead of letting it own every volume", async () => {
        // The actual bug, and it needs the root row to reproduce: the tree stands in for
        // "not this subfolder" with a `<child>/**` exclude on the row that owns it, and a
        // row with the empty path owns everything. So unticking one volume wrote the others
        // into that row's exclude patterns rather than removing a row - and because the root
        // row has no checkbox of its own in flat mode, it could never be cleared.
        //
        // The dialog strips such a row when it opens, but a job saved by an older version
        // still carries one, so the tree has to be right on its own.
        const { onRowsChange } = renderTree([
            { path: "", excludePatterns: [], excludePatternPresetIds: [] },
            { path: "app-data", excludePatterns: [], excludePatternPresetIds: [] },
        ]);
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        await userEvent.click(screen.getAllByRole("checkbox")[1]);

        const after = onRowsChange.mock.calls.at(-1)![0];
        expect(after.flatMap((r) => r.excludePatterns)).toEqual([]);
        expect(after.map((r) => r.path)).not.toContain("app-data");
    });

    it("never produces a row for the root itself", async () => {
        // `/` becomes an empty volume name in the adapter, so a job built that way cannot
        // run. Neither ticking everything nor ticking each one may create it.
        const { onRowsChange } = renderTree();
        await waitFor(() => expect(screen.getByText("app-data")).toBeTruthy());

        await userEvent.click(screen.getAllByRole("checkbox")[0]);
        for (let i = 1; i <= VOLUMES.length; i++) {
            await userEvent.click(screen.getAllByRole("checkbox")[i]);
        }

        for (const call of onRowsChange.mock.calls) {
            expect(call[0].map((r: { path: string }) => r.path)).not.toContain("");
            expect(call[0].map((r: { path: string }) => r.path)).not.toContain("/");
        }
    });

    it("still lets a single volume be picked on its own", async () => {
        const { onRowsChange } = renderTree();
        await waitFor(() => expect(screen.getByText("web-content")).toBeTruthy());

        // Index 0 is the top row, so the volumes start at 1 in load order.
        await userEvent.click(screen.getAllByRole("checkbox")[1]);

        expect(onRowsChange.mock.calls.at(-1)![0].map((r) => r.path)).toEqual(["app-data"]);
    });
});
