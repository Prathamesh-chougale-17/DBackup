import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
    ChartConfig,
    ChartContainer,
    ChartLegend,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
} from "@/components/ui/chart";

const CHART_WIDTH = 800;
const CHART_HEIGHT = 400;

// ResponsiveContainer measures its parent, and jsdom reports every element as 0x0, so the
// charts would render nothing and every assertion below would pass vacuously. Handing the
// chart explicit dimensions is the form Recharts supports natively.
//
// Faking the geometry on HTMLElement.prototype instead is the obvious-looking alternative
// and it is wrong: it hands the same size to every element including the legend, which then
// claims the full chart height and collapses the plot area, so the series vanish.
vi.mock("recharts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("recharts")>();
    return {
        ...actual,
        ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
            React.cloneElement(children, { width: CHART_WIDTH, height: CHART_HEIGHT } as Partial<unknown>),
    };
});

const barConfig = {
    completed: { label: "Completed", color: "hsl(145, 78%, 45%)" },
    failed: { label: "Failed", color: "hsl(357, 78%, 54%)" },
} satisfies ChartConfig;

// Every value is non-zero on purpose: Recharts skips the rectangle for a zero-height bar,
// which would make the rectangle count below depend on the data rather than on the series.
const barData = [
    { date: "2026-07-01", completed: 4, failed: 1 },
    { date: "2026-07-02", completed: 6, failed: 2 },
    { date: "2026-07-03", completed: 2, failed: 3 },
];

const areaConfig = { size: { label: "Size", color: "hsl(225, 79%, 54%)" } } satisfies ChartConfig;
const areaData = [
    { date: "2026-07-01", size: 1024 },
    { date: "2026-07-02", size: 4096 },
    { date: "2026-07-03", size: 2048 },
];

const pieConfig = {
    count: { label: "Executions" },
    Success: { label: "Completed", color: "hsl(145, 78%, 45%)" },
    Failed: { label: "Failed", color: "hsl(357, 78%, 54%)" },
} satisfies ChartConfig;

const pieData = [
    { status: "Success", count: 8, fill: "var(--color-Success)" },
    { status: "Failed", count: 2, fill: "var(--color-Failed)" },
];

const lineConfig = { versionIndex: { label: "Version", color: "hsl(225, 79%, 54%)" } } satisfies ChartConfig;
const lineData = [
    { detectedAt: "2026-07-01T00:00:00.000Z", versionIndex: 0 },
    { detectedAt: "2026-07-02T00:00:00.000Z", versionIndex: 1 },
];

describe("chart primitives render under Recharts 3", () => {
    it("renders a stacked BarChart with grid, axes and one series per bar", () => {
        const { container } = render(
            <ChartContainer config={barConfig} className="h-62.5 w-full">
                <BarChart data={barData} accessibilityLayer>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar dataKey="completed" stackId="a" fill="var(--color-completed)" />
                    <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" />
                </BarChart>
            </ChartContainer>
        );

        expect(container.querySelector("svg.recharts-surface")).not.toBeNull();
        expect(container.querySelectorAll(".recharts-bar")).toHaveLength(2);
        // Three data points per series, so six rectangles in a two-series stack.
        expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(6);
        expect(container.querySelector(".recharts-cartesian-grid")).not.toBeNull();
        expect(container.querySelectorAll(".recharts-cartesian-axis")).toHaveLength(2);
    });

    it("renders an AreaChart with its curve", () => {
        const { container } = render(
            <ChartContainer config={areaConfig} className="h-full w-full">
                <AreaChart data={areaData} accessibilityLayer margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area dataKey="size" type="monotone" fill="url(#fillSize)" stroke="var(--color-size)" />
                </AreaChart>
            </ChartContainer>
        );

        expect(container.querySelector(".recharts-area")).not.toBeNull();
        expect(container.querySelector(".recharts-area-area")).not.toBeNull();
    });

    it("renders a LineChart with a point per data row", () => {
        const { container } = render(
            <ChartContainer config={lineConfig} className="h-55 w-full">
                <LineChart data={lineData} accessibilityLayer>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="detectedAt" tickLine={false} axisLine={false} />
                    <YAxis dataKey="versionIndex" tickLine={false} axisLine={false} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line type="stepAfter" dataKey="versionIndex" stroke="var(--color-versionIndex)" dot={{ r: 4 }} />
                </LineChart>
            </ChartContainer>
        );

        expect(container.querySelector(".recharts-line")).not.toBeNull();
        expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(lineData.length);
    });

    it("renders a PieChart with one sector per slice and a legend entry per series", async () => {
        const { container, findByText } = render(
            <ChartContainer config={pieConfig} className="mx-auto aspect-auto h-56">
                <PieChart accessibilityLayer>
                    <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                    {/* Sectors are drawn by the entry animation, which never runs in jsdom.
                        Asserting the settled shape needs the animation switched off. */}
                    <Pie
                        data={pieData}
                        dataKey="count"
                        nameKey="status"
                        innerRadius={55}
                        outerRadius={80}
                        isAnimationActive={false}
                    />
                    <ChartLegend
                        content={<ChartLegendContent nameKey="status" className="-translate-y-2 flex-wrap" />}
                    />
                </PieChart>
            </ChartContainer>
        );

        expect(container.querySelectorAll(".recharts-pie-sector")).toHaveLength(pieData.length);
        // ChartLegendContent maps each payload entry back through the config, which is the
        // part that broke when Recharts 3 stopped exposing `payload` on LegendProps.
        //
        // These are awaited rather than read synchronously: Recharts 3 populates the legend
        // payload from its state store, which the graphical items only fill in after their
        // first render, so the legend is genuinely empty on the initial pass.
        expect(await findByText("Completed")).toBeInTheDocument();
        expect(await findByText("Failed")).toBeInTheDocument();
    });

    it("emits a CSS custom property per configured colour", () => {
        const { container } = render(
            <ChartContainer config={barConfig} className="h-62.5 w-full">
                <BarChart data={barData}>
                    <Bar dataKey="completed" fill="var(--color-completed)" />
                </BarChart>
            </ChartContainer>
        );

        const style = container.querySelector("style");
        expect(style?.innerHTML).toContain("--color-completed: hsl(145, 78%, 45%)");
        expect(style?.innerHTML).toContain("--color-failed: hsl(357, 78%, 54%)");
    });
});
