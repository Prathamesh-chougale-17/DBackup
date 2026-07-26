"use client";

import * as React from "react";
import {
    ColumnDef,
    ColumnFiltersState,
    RowSelectionState,
    SortingState,
    VisibilityState,
    PaginationState,
    OnChangeFn,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    getFacetedRowModel,
    getFacetedUniqueValues,
    useReactTable,
} from "@tanstack/react-table";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { DataTableToolbar } from "./data-table-toolbar";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableBulkBar } from "./data-table-bulk-bar";
import { selectColumn } from "./data-table-selection";
import type { BulkAction, DataTableFilterableColumn, DataTableFilterOption } from "./data-table-types";

export type { BulkAction, DataTableFilterableColumn, DataTableFilterOption };

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    searchKey?: string;
    filterableColumns?: DataTableFilterableColumn<TData>[];
    initialColumnVisibility?: VisibilityState;
    autoResetPageIndex?: boolean;
    onRefresh?: () => void;
    isLoading?: boolean;

    // Row selection & bulk actions
    /**
     * Shows the leading checkbox column and the bulk action bar.
     *
     * Bind this to the permission boolean resolved on the server. It hides UI only - the
     * endpoint behind every bulk action checks permissions again.
     */
    enableRowSelection?: boolean;
    /**
     * Stable identity per row. Required whenever `enableRowSelection` is set.
     *
     * Without it TanStack keys the selection by row index, so any refetch that reorders or
     * resizes the list leaves the selection pointing at different records. Every consumer
     * here replaces `data` after a mutation, and some poll on a timer.
     */
    getRowId?: (row: TData, index: number) => string;
    /** Rows that may never be selected, whatever the action. Renders a disabled checkbox. */
    isRowSelectable?: (row: TData) => boolean;
    bulkActions?: BulkAction<TData>[];
    /** Runs after a bulk action settles, whether fully or partly successful. Refetch here. */
    onBulkActionComplete?: () => void | Promise<void>;

    // Manual Pagination & Sorting Capabilities
    pageCount?: number;
    rowCount?: number;
    pagination?: PaginationState;
    onPaginationChange?: OnChangeFn<PaginationState>;
    sorting?: SortingState;
    onSortingChange?: OnChangeFn<SortingState>;
    columnFilters?: ColumnFiltersState;
    onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
    manualPagination?: boolean;
    manualSorting?: boolean;
    manualFiltering?: boolean;
}

export function DataTable<TData, TValue>({
    columns,
    data,
    searchKey = "name",
    filterableColumns = [],
    initialColumnVisibility = {},
    autoResetPageIndex = true,
    onRefresh,
    isLoading = false,
    enableRowSelection = false,
    getRowId,
    isRowSelectable,
    bulkActions = [],
    onBulkActionComplete,
    pageCount,
    rowCount,
    pagination: controlledPagination,
    onPaginationChange,
    sorting: controlledSorting,
    onSortingChange,
    columnFilters: controlledColumnFilters,
    onColumnFiltersChange,
    manualPagination = false,
    manualSorting = false,
    manualFiltering = false,
}: DataTableProps<TData, TValue>) {
    // Internal state (used if no controlled state is provided)
    const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
    const [internalColumnFilters, setInternalColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [internalPagination, setInternalPagination] = React.useState<PaginationState>({
        pageIndex: 0,
        pageSize: 10,
    });
    const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(initialColumnVisibility);
    const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

    // Resolution (Controlled vs Internal)
    const sorting = controlledSorting ?? internalSorting;
    const setSorting = onSortingChange ?? setInternalSorting;

    const columnFilters = controlledColumnFilters ?? internalColumnFilters;
    const setColumnFilters = onColumnFiltersChange ?? setInternalColumnFilters;

    const pagination = controlledPagination ?? internalPagination;
    const setPagination = onPaginationChange ?? setInternalPagination;

    // The select column is prepended here rather than by each consumer, so its position is
    // the same everywhere and permission gating stays a single boolean.
    const tableColumns = React.useMemo(
        () => (enableRowSelection ? [selectColumn<TData>() as ColumnDef<TData, TValue>, ...columns] : columns),
        [enableRowSelection, columns]
    );

    const table = useReactTable({
        data,
        columns: tableColumns,
        getRowId,
        enableRowSelection: enableRowSelection
            ? (row) => (isRowSelectable ? isRowSelectable(row.original) : true)
            : false,
        pageCount: pageCount ?? (manualPagination ? -1 : undefined),
        state: {
            sorting,
            columnFilters,
            columnVisibility,
            rowSelection,
            pagination,
        },
        manualPagination,
        manualSorting,
        manualFiltering,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onPaginationChange: setPagination,
        onColumnVisibilityChange: setColumnVisibility,
        onRowSelectionChange: setRowSelection,

        // When pagination is controlled externally, auto-reset would overwrite the parent's pageIndex on every data update.
        autoResetPageIndex: manualPagination ? false : autoResetPageIndex,
        getCoreRowModel: getCoreRowModel(),
        // Only use client-side models if NOT manual
        getPaginationRowModel: !manualPagination ? getPaginationRowModel() : undefined,
        getSortedRowModel: !manualSorting ? getSortedRowModel() : undefined,
        getFilteredRowModel: !manualFiltering ? getFilteredRowModel() : undefined,
        getFacetedRowModel: !manualFiltering ? getFacetedRowModel() : undefined,
        getFacetedUniqueValues: !manualFiltering ? getFacetedUniqueValues() : undefined,
    });

    // TanStack keeps selection keys for rows that have left `data`. They are invisible in
    // the row models but would still count as "selected" the moment a row with the same id
    // comes back, so drop them whenever the data changes.
    React.useEffect(() => {
        if (!enableRowSelection || !getRowId) return;
        setRowSelection((current) => {
            const keys = Object.keys(current);
            if (keys.length === 0) return current;
            const present = new Set(data.map((row, index) => getRowId(row, index)));
            const stale = keys.filter((key) => !present.has(key));
            if (stale.length === 0) return current;
            const next = { ...current };
            for (const key of stale) delete next[key];
            return next;
        });
    }, [data, enableRowSelection, getRowId]);

    const totalRows = rowCount ?? table.getFilteredRowModel().rows.length;
    // Always read the selection through the row model. The raw record can hold ids that
    // are no longer on screen.
    const selectedRows = enableRowSelection
        ? table.getFilteredSelectedRowModel().rows.map((row) => row.original)
        : [];

    return (
        <div className="w-full">
            <DataTableToolbar
                table={table}
                searchKey={searchKey}
                filterableColumns={filterableColumns}
                onRefresh={onRefresh}
                isLoading={isLoading}
            />
            {enableRowSelection && bulkActions.length > 0 && (
                <DataTableBulkBar
                    selectedRows={selectedRows}
                    actions={bulkActions}
                    onClearSelection={() => setRowSelection({})}
                    onComplete={onBulkActionComplete}
                />
            )}
            <div className="rounded-md border overflow-x-auto max-w-[calc(100vw-6rem)] md:max-w-[calc(100vw-22rem)]">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                      header.column.columnDef.header,
                                                      header.getContext()
                                                  )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext()
                                            )}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell
                                    // Counted from the table, not from `columns`, so the
                                    // prepended select column does not break the span.
                                    colSpan={table.getVisibleLeafColumns().length}
                                    className="h-24 text-center"
                                >
                                    No results.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
            <DataTablePagination table={table} totalRows={totalRows} />
        </div>
    );
}
