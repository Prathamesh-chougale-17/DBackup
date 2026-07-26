"use client";

import * as React from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BulkFailure } from "@/lib/core/bulk";

export interface BulkResultDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    failures: BulkFailure[];
}

/**
 * The rows a bulk action could not process, with the reason for each.
 *
 * A plain Dialog rather than an AlertDialog: this reports what already happened and asks
 * for no decision. The reasons here are long and actionable, such as which jobs still use
 * a connection, which is exactly what a toast would truncate and then dismiss.
 */
export function BulkResultDialog({ open, onOpenChange, title, failures }: BulkResultDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {failures.length === 1
                            ? "One entry could not be processed."
                            : `${failures.length} entries could not be processed.`}
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[calc(80vh-10rem)]">
                    <ul className="space-y-3 pr-3">
                        {failures.map((failure) => (
                            <li key={failure.id} className="space-y-1 border-l-2 border-destructive/60 pl-3">
                                <p className="text-sm font-medium break-all">
                                    {failure.name ?? failure.id}
                                </p>
                                <p className="text-sm text-muted-foreground">{failure.error}</p>
                            </li>
                        ))}
                    </ul>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}
