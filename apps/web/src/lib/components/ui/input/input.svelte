<script lang="ts">
import type {
  HTMLInputAttributes,
  HTMLInputTypeAttribute,
} from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.js";

type InputType = Exclude<HTMLInputTypeAttribute, "file">;

type Props = WithElementRef<
  Omit<HTMLInputAttributes, "type"> &
    (
      | { type: "file"; files?: FileList }
      | { type?: InputType; files?: undefined }
    )
>;

let {
  ref = $bindable(null),
  value = $bindable(),
  type,
  files = $bindable(),
  class: className,
  "data-slot": dataSlot = "input",
  ...restProps
}: Props = $props();
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"flex h-10 w-full min-w-0 rounded-md border-0 bg-fill px-3 text-body text-label transition-colors lg:text-subheadline pointer-coarse:h-11 placeholder:text-label-secondary file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-subheadline file:font-medium file:text-label contrast-more:border contrast-more:border-input aria-invalid:border aria-invalid:border-destructive disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"flex h-10 w-full min-w-0 rounded-md border-0 bg-fill px-3 text-body text-label transition-colors lg:text-subheadline pointer-coarse:h-11 placeholder:text-label-secondary file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-subheadline file:font-medium file:text-label contrast-more:border contrast-more:border-input aria-invalid:border aria-invalid:border-destructive disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
