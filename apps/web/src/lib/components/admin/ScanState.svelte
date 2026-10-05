<script lang="ts">
import { type ScanStatus, scanStartedAt, scanState } from "$lib/scan.ts";

/** A library's scan state as a dot and label; `withTime` adds a "Last scan" line. */
const {
  status,
  withTime = false,
}: { status: ScanStatus | undefined | null; withTime?: boolean } = $props();

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

<span class="flex flex-col items-end gap-0.5">
  <span class="flex items-center gap-2">
    <span class="size-2 rounded-full {scanTones[state.tone]}"></span>
    <span class="text-footnote text-label-secondary">{state.label}</span>
  </span>
  {#if lastScan}
    <span class="text-footnote text-label-secondary"
      >Last scan {instant.format(lastScan)}</span
    >
  {/if}
</span>
