<script lang="ts">
import { type ScanStatus, scanStartedAt, scanState } from "$lib/scan.ts";
import { cn } from "$lib/utils.ts";

/** A library's scan state as a dot and label; `withTime` adds a "Last scan" line. */
const {
  status,
  withTime = false,
  class: className,
}: {
  status: ScanStatus | undefined | null;
  withTime?: boolean;
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
  <span class={cn("flex items-center gap-2", className)}>
    <span class="size-2 rounded-full {scanTones[state.tone]}"></span>
    <span class="text-footnote text-label-secondary">{state.label}</span>
  </span>
  {#if lastScan}
    <span class="text-footnote text-label-secondary"
      >Last scan {instant.format(lastScan)}</span
    >
  {/if}
</span>
