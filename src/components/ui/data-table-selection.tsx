"use client";

import * as React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * The leading checkbox column.
 *
 * DataTable prepends this itself when row selection is enabled, so no consumer has to add
 * it to its own column list and the position stays the same everywhere.
 */
export function selectColumn<TData>(): ColumnDef<TData, unknown> {
    return {
        id: "select",
        enableSorting: false,
        // Without this the View menu offers to hide a column labelled "select".
        enableHiding: false,
        size: 32,
        header: ({ table }) => (
            <Checkbox
                checked={
                    table.getIsAllPageRowsSelected()
                        ? true
                        : table.getIsSomePageRowsSelected()
                            ? "indeterminate"
                            : false
                }
                onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
                aria-label="Select all rows on this page"
            />
        ),
        cell: ({ row }) => (
            <Checkbox
                checked={row.getIsSelected()}
                disabled={!row.getCanSelect()}
                onCheckedChange={(value) => row.toggleSelected(!!value)}
                // Rows are clickable in some tables. Selecting must not also open the row.
                onClick={(event) => event.stopPropagation()}
                aria-label="Select row"
            />
        ),
    };
}
