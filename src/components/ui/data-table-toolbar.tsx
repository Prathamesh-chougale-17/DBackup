"use client";

import * as React from "react";
import { Table } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { X, Settings2, RefreshCw } from "lucide-react";
import { DataTableFacetedFilter } from "./data-table-faceted-filter";
import type { DataTableFilterableColumn } from "./data-table-types";
import { cn } from "@/lib/utils";

interface DataTableToolbarProps<TData> {
    table: Table<TData>;
    searchKey: string;
    filterableColumns: DataTableFilterableColumn<TData>[];
    onRefresh?: () => void;
    isLoading?: boolean;
}

/** Filter input, faceted filter chips, column visibility and refresh. */
export function DataTableToolbar<TData>({
    table,
    searchKey,
    filterableColumns,
    onRefresh,
    isLoading = false,
}: DataTableToolbarProps<TData>) {
    const isFiltered = table.getState().columnFilters.length > 0;

    return (
        <div className="flex items-center justify-between py-4">
            <div className="flex flex-1 items-center space-x-2">
                <Input
                    placeholder="Filter..."
                    value={(table.getColumn(searchKey)?.getFilterValue() as string) ?? ""}
                    onChange={(event) =>
                        table.getColumn(searchKey)?.setFilterValue(event.target.value)
                    }
                    className="h-8 w-37.5 lg:w-62.5"
                />
                {filterableColumns.length > 0 &&
                    filterableColumns.map((column) => (
                        table.getColumn(column.id as string) && (
                            <DataTableFacetedFilter
                                key={String(column.id)}
                                column={table.getColumn(column.id as string)}
                                title={column.title}
                                options={column.options}
                            />
                        )
                    ))}
                {isFiltered && (
                    <Button
                        variant="ghost"
                        onClick={() => table.resetColumnFilters()}
                        className="h-8 px-2 lg:px-3"
                    >
                        Reset
                        <X className="ml-2 h-4 w-4" />
                    </Button>
                )}
            </div>
            <div className="flex items-center space-x-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 hidden lg:flex ml-auto">
                            <Settings2 className="mr-2 h-4 w-4" />
                            View
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-37.5">
                        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {table
                            .getAllColumns()
                            .filter((column) => column.getCanHide())
                            .map((column) => {
                                return (
                                    <DropdownMenuCheckboxItem
                                        key={column.id}
                                        className="capitalize"
                                        checked={column.getIsVisible()}
                                        onCheckedChange={(value) =>
                                            column.toggleVisibility(!!value)
                                        }
                                    >
                                        {column.id}
                                    </DropdownMenuCheckboxItem>
                                );
                            })}
                    </DropdownMenuContent>
                </DropdownMenu>
                {onRefresh && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onRefresh}
                        title="Refresh"
                        className="h-8 w-8 p-0"
                        disabled={isLoading}
                    >
                        <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
                    </Button>
                )}
            </div>
        </div>
    );
}
