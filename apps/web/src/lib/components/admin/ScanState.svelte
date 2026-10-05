<script lang="ts">
import { type ScanStatus, scanStartedAt, scanState } from "$lib/scan.ts";
import { cn } from "$lib/utils.ts";

/** A library's scan state as a dot and label; `withTime` adds a "Last scan" line, styled by `timeClass`. */
const {
  status,
  withTime = false,
  timeClass,
  class: className,
}: {
  status: ScanStatus | undefined | null;
  withTime?: boolean;
  timeClass?: string;
  class?: string;
} = $props();

const scanTones = {
  active: "bg-tint",
  done: "bg-success",
  error: "bg-destructive",
  idle: "bg-label-tertiary",
} as const;

const instant = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const state = $derived(
  status === null
    ? { label: "Status unavailable", tone: "idle" as const }
    : scanState(status),
);
const lastScan = $derived(
  withTime && status !== null ? scanStartedAt(status) : null,
);
</script>

<span class={cn("flex flex-col items-end gap-0.5", className)}>
  <span class="flex items-center gap-2">
    <span class="size-2 rounded-full {scanTones[state.tone]}"></span>
    <span class="text-footnote text-label-secondary">{state.label}</span>
  </span>
  {#if lastScan}
    <span class={cn("text-footnote text-label-secondary", timeClass)}
      >Last scan {instant.format(lastScan)}</span
    >
  {/if}
</span>
