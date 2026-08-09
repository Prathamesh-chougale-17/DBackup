"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_HOURLY_TIER,
  RetentionConfiguration,
  RetentionMode,
} from "@/lib/core/retention";
import { cn } from "@/lib/utils";

interface Props {
  value: RetentionConfiguration;
  onChange: (config: RetentionConfiguration) => void;
}

const DEFAULT_SIMPLE = { keepCount: 10 };
const DEFAULT_SMART = { hourly: 0, daily: 7, weekly: 4, monthly: 12, yearly: 2 };

export function RetentionPolicyForm({ value, onChange }: Props) {
  const mode = value.mode;
  const simple = value.simple ?? DEFAULT_SIMPLE;
  const smart = value.smart ?? DEFAULT_SMART;

  // Most setups never need an hourly tier, so the field stays out of the way until it is
  // asked for. A policy that already carries one opens with it visible, which is why this
  // is derived from the value rather than held in state alone.
  const [manuallyShown, setManuallyShown] = useState(false);
  const showHourly = manuallyShown || (smart.hourly ?? 0) > 0;

  function setMode(newMode: RetentionMode) {
    onChange({
      mode: newMode,
      simple: value.simple ?? DEFAULT_SIMPLE,
      smart: value.smart ?? DEFAULT_SMART,
    });
  }

  function setKeepCount(n: number) {
    onChange({ ...value, simple: { keepCount: n } });
  }

  function setSmartField(field: keyof typeof DEFAULT_SMART, n: number) {
    onChange({
      ...value,
      smart: { ...smart, [field]: n },
    });
  }

  function toggleHourly() {
    if (showHourly) {
      setManuallyShown(false);
      setSmartField("hourly", 0);
      return;
    }
    setManuallyShown(true);
    setSmartField("hourly", DEFAULT_HOURLY_TIER);
  }

  return (
    <div className="space-y-3">
      <Label>Retention Mode</Label>
      <Tabs
        value={mode}
        onValueChange={(v) => setMode(v as RetentionMode)}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3 h-8">
          <TabsTrigger value="NONE" className="text-xs">
            Keep All
          </TabsTrigger>
          <TabsTrigger value="SIMPLE" className="text-xs">
            Simple
          </TabsTrigger>
          <TabsTrigger value="SMART" className="text-xs">
            Smart (GFS)
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "NONE" && (
        <p className="text-xs text-muted-foreground">
          All backups are kept indefinitely. No automatic deletion.
        </p>
      )}

      {mode === "SIMPLE" && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={simple.keepCount}
            onChange={(e) => setKeepCount(parseInt(e.target.value) || 1)}
            className="w-20 h-8"
          />
          <span className="text-xs text-muted-foreground">newest backups</span>
        </div>
      )}

      {mode === "SMART" && (
        <div className="space-y-2">
          <div
            className={cn(
              "grid gap-2",
              showHourly ? "grid-cols-5" : "grid-cols-4"
            )}
          >
            {showHourly && (
              <div className="space-y-1">
                <Label className="text-xs">Hourly</Label>
                <Input
                  type="number"
                  min={0}
                  value={smart.hourly ?? 0}
                  onChange={(e) =>
                    setSmartField("hourly", parseInt(e.target.value) || 0)
                  }
                  className="h-8"
                />
              </div>
            )}
            {(["daily", "weekly", "monthly", "yearly"] as const).map((period) => (
              <div key={period} className="space-y-1">
                <Label className="text-xs capitalize">{period}</Label>
                <Input
                  type="number"
                  min={0}
                  value={smart[period]}
                  onChange={(e) =>
                    setSmartField(period, parseInt(e.target.value) || 0)
                  }
                  className="h-8"
                />
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={toggleHourly}
          >
            {showHourly ? (
              <>
                <X className="size-3" />
                Remove hourly tier
              </>
            ) : (
              <>
                <Plus className="size-3" />
                Add hourly tier
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground">
            The tiers add up rather than overlap. Each one keeps that many backups on top
            of what the finer tiers already cover, so hourly 24 with daily 7 reaches back
            about a day of hourly slots plus 7 further days.
          </p>
        </div>
      )}
    </div>
  );
}
