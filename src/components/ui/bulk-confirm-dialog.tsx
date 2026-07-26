"use client";

import * as React from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface BulkConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: React.ReactNode;
    /** Names of the rows that will be acted on. */
    items: string[];
    /** Rows this action skips, with the reason. Shown so the count is never a surprise. */
    skipped?: { name: string; reason: string }[];
    /** How many names to show before summarising the rest. */
    previewLimit?: number;
    confirmLabel?: string;
    destructive?: boolean;
    isPending?: boolean;
    onConfirm: () => void;
}

/**
 * Confirmation for an action about to touch several rows.
 *
 * Lists the rows by name rather than only counting them, because a selection can be
 * changed by a filter after it was made and a bare count would not show that.
 */
export function BulkConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    items,
    skipped = [],
    previewLimit = 8,
    confirmLabel = "Confirm",
    destructive = false,
    isPending = false,
    onConfirm,
}: BulkConfirmDialogProps) {
    const preview = items.slice(0, previewLimit);
    const remaining = items.length - preview.length;

    return (
        <AlertDialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
            <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>

                {items.length > 0 && (
                    <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-40 rounded-md border bg-muted/40">
                        <ul className="px-3 py-2 text-sm">
                            {preview.map((name) => (
                                <li key={name} className="truncate py-0.5">
                                    {name}
                                </li>
                            ))}
                            {remaining > 0 && (
                                <li className="py-0.5 text-muted-foreground">
                                    and {remaining} more
                                </li>
                            )}
                        </ul>
                    </ScrollArea>
                )}

                {skipped.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                        <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
                            <AlertTriangle className="h-4 w-4" />
                            {skipped.length} will be skipped
                        </p>
                        <ul className="mt-1 space-y-0.5 text-amber-800/90 dark:text-amber-300/90">
                            {skipped.slice(0, previewLimit).map((entry) => (
                                <li key={entry.name} className="truncate">
                                    {entry.name} - {entry.reason}
                                </li>
                            ))}
                            {skipped.length > previewLimit && (
                                <li>and {skipped.length - previewLimit} more</li>
                            )}
                        </ul>
                    </div>
                )}

                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        className={cn(
                            destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        )}
                        disabled={isPending || items.length === 0}
                        // Radix closes on click. The dialog has to stay up while the request
                        // runs, so the close is deferred to the caller.
                        onClick={(event) => {
                            event.preventDefault();
                            onConfirm();
                        }}
                    >
                        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {confirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
