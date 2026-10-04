<script lang="ts">
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import InfoIcon from "@lucide/svelte/icons/info";
import Loader2Icon from "@lucide/svelte/icons/loader-2";
import OctagonXIcon from "@lucide/svelte/icons/octagon-x";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import {
  Toaster as Sonner,
  type ToasterProps as SonnerProps,
} from "svelte-sonner";

let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme="system"
	position="bottom-center"
	mobileOffset="6rem"
	class="toaster group"
	toastOptions={{
		classes: {
			toast: "material-thick rounded-xl shadow-float text-subheadline text-label border-0",
			description: "text-footnote text-label-secondary",
		},
	}}
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin text-label-secondary" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4 text-tint" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4 text-destructive" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4 text-label-secondary" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4 text-destructive" />
	{/snippet}
</Sonner>

<style>
	/* Enter rises over --duration-slow, exit over --duration-medium. */
	:global([data-sonner-toast][data-sonner-toast]) {
		animation-duration: var(--duration-slow);
	}
	:global([data-sonner-toast][data-removed="true"]) {
		animation-duration: var(--duration-medium);
		transition-duration: var(--duration-medium);
	}
</style>
