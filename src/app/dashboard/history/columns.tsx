"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, FileText, KeyRound, MousePointerClick } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { DateDisplay } from "@/components/utils/date-display";

export interface Execution {
    id: string;
    jobId?: string;
    job?: {
        name: string;
    };
    type?: string;
    status: "Running" | "Success" | "Failed" | "Pending" | "Partial" | "Cancelled";
    startedAt: string;
    endedAt?: string;
    path?: string;
    metadata?: string;
    triggerType?: string | null;
    triggerLabel?: string | null;
}

const SYSTEM_TASK_TYPE_LABELS: Record<string, string> = {
  IntegrityCheck: "Backup Integrity Check",
};

export const createColumns = (onViewLogs: (execution: Execution) => void): ColumnDef<Execution>[] => [
    {
        id: "jobName",
        accessorFn: (row) => row.job?.name || "Manual Action",
        header: "Job / Resource",
        cell: ({ row }) => {
            const execution = row.original;
            return (
                <div className="flex flex-col">
                    <span className="font-medium">
                        {row.getValue("jobName")}
                    </span>
                    {execution.path && (
                        <span className="text-[10px] text-muted-foreground truncate max-w-150" title={execution.path}>
                            {execution.path}
                        </span>
                    )}
                </div>
            )
        }
    },
    {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => {
            const type = row.getValue("type") as string;
            return <Badge variant="outline">{type || "Backup"}</Badge>;
        },
        filterFn: (row, id, value) => {
            return value.includes(row.getValue(id))
        },
    },
    {
        id: "trigger",
        accessorFn: (row) => row.triggerType ?? "",
        header: "Trigger",
        filterFn: (row, _id, value) => {
            return value.includes(row.original.triggerType ?? "");
        },
        cell: ({ row }) => {
            const triggerType = row.original.triggerType;
            const triggerLabel = row.original.triggerLabel;

            if (!triggerType) {
                return <span className="text-muted-foreground">-</span>;
            }

            const iconClass = "h-3.5 w-3.5 shrink-0";
            let icon: React.ReactNode;
            let badgeClass: string;

            if (triggerType === "Scheduler") {
                icon = <Clock className={iconClass} />;
                badgeClass = "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800";
            } else if (triggerType === "Api") {
                icon = <KeyRound className={iconClass} />;
                badgeClass = "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800";
            } else {
                icon = <MousePointerClick className={iconClass} />;
                badgeClass = "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800";
            }

            return (
                <Badge variant="outline" className={`flex items-center gap-1.5 w-fit font-normal ${badgeClass}`}>
                    {icon}
                    <span>{triggerLabel || triggerType}</span>
                </Badge>
            );
        },
    },
    {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
            const status = row.getValue("status") as string;

            if (status === "Success") {
                return (
                    <Badge className="bg-[hsl(145,78%,45%)] text-white border-transparent hover:bg-[hsl(145,78%,40%)]">
                        Success
                    </Badge>
                );
            } else if (status === "Failed") {
                return (
                    <Badge className="bg-[hsl(357,78%,54%)] text-white border-transparent hover:bg-[hsl(357,78%,48%)]">
                        Failed
                    </Badge>
                );
            } else if (status === "Running") {
                return (
                    <Badge className="bg-[hsl(225,79%,54%)] text-white border-transparent hover:bg-[hsl(225,79%,48%)]">
                        Running
                    </Badge>
                );
            } else if (status === "Partial") {
                return (
                    <Badge className="bg-[hsl(25,90%,55%)] text-white border-transparent hover:bg-[hsl(25,90%,50%)]">
                        Partial
                    </Badge>
                );
            } else if (status === "Cancelled") {
                return (
                    <Badge variant="outline" className="text-muted-foreground">
                        Cancelled
                    </Badge>
                );
            }

            return <Badge variant="outline">{status}</Badge>;
        },
        filterFn: (row, id, value) => {
            return value.includes(row.getValue(id))
        },
    },
    {
        accessorKey: "startedAt",
        header: "Started At",
        cell: ({ row }) => {
             return <DateDisplay date={row.getValue("startedAt")} format="PPpp" />;
        }
    },
    {
        accessorKey: "endedAt",
        header: "Duration",
        cell: ({ row }) => {
            const start = new Date(row.original.startedAt);
            const end = row.original.endedAt ? new Date(row.original.endedAt) : null;
            if (!end) return <span className="text-muted-foreground italic">Running...</span>;

            const diff = end.getTime() - start.getTime();
            return <span>{formatDuration(diff)}</span>;
        }
    },
    {
        id: "actions",
        cell: ({ row }) => {
            return (
                <Button variant="ghost" size="sm" onClick={() => onViewLogs(row.original)}>
                    <FileText className="mr-2 h-4 w-4" />
                    Logs
                </Button>
            );
        }
    }
];

export const createSystemTaskColumns = (onViewLogs: (execution: Execution) => void): ColumnDef<Execution>[] => [
    {
        id: "taskName",
        accessorFn: (row) => SYSTEM_TASK_TYPE_LABELS[row.type ?? ""] ?? row.type ?? "System Task",
        header: "Task",
        cell: ({ row }) => (
            <span className="font-medium">{row.getValue("taskName")}</span>
        ),
    },
    {
        id: "trigger",
        accessorFn: (row) => row.triggerType ?? "",
        header: "Trigger",
        filterFn: (row, _id, value) => {
            return value.includes(row.original.triggerType ?? "");
        },
        cell: ({ row }) => {
            const triggerType = row.original.triggerType;
            const triggerLabel = row.original.triggerLabel;

            if (!triggerType) {
                return <span className="text-muted-foreground">-</span>;
            }

            const iconClass = "h-3.5 w-3.5 shrink-0";
            let icon: React.ReactNode;
            let badgeClass: string;

            if (triggerType === "Scheduler") {
                icon = <Clock className={iconClass} />;
                badgeClass = "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800";
            } else {
                icon = <MousePointerClick className={iconClass} />;
                badgeClass = "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800";
            }

            return (
                <Badge variant="outline" className={`flex items-center gap-1.5 w-fit font-normal ${badgeClass}`}>
                    {icon}
                    <span>{triggerLabel || triggerType}</span>
                </Badge>
            );
        },
    },
    {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
            const status = row.getValue("status") as string;
            if (status === "Success") {
                return <Badge className="bg-[hsl(145,78%,45%)] text-white border-transparent hover:bg-[hsl(145,78%,40%)]">Success</Badge>;
            } else if (status === "Failed") {
                return <Badge className="bg-[hsl(357,78%,54%)] text-white border-transparent hover:bg-[hsl(357,78%,48%)]">Failed</Badge>;
            } else if (status === "Running") {
                return <Badge className="bg-[hsl(225,79%,54%)] text-white border-transparent hover:bg-[hsl(225,79%,48%)]">Running</Badge>;
            } else if (status === "Partial") {
                return <Badge className="bg-[hsl(25,90%,55%)] text-white border-transparent hover:bg-[hsl(25,90%,50%)]">Partial</Badge>;
            }
            return <Badge variant="outline">{status}</Badge>;
        },
        filterFn: (row, id, value) => value.includes(row.getValue(id)),
    },
    {
        accessorKey: "startedAt",
        header: "Started At",
        cell: ({ row }) => <DateDisplay date={row.getValue("startedAt")} format="PPpp" />,
    },
    {
        accessorKey: "endedAt",
        header: "Duration",
        cell: ({ row }) => {
            const start = new Date(row.original.startedAt);
            const end = row.original.endedAt ? new Date(row.original.endedAt) : null;
            if (!end) return <span className="text-muted-foreground italic">Running...</span>;
            return <span>{formatDuration(end.getTime() - start.getTime())}</span>;
        },
    },
    {
        id: "actions",
        cell: ({ row }) => (
            <Button variant="ghost" size="sm" onClick={() => onViewLogs(row.original)}>
                <FileText className="mr-2 h-4 w-4" />
                Logs
            </Button>
        ),
    },
];
