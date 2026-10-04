<script lang="ts" module>
import type {
  HTMLAnchorAttributes,
  HTMLButtonAttributes,
} from "svelte/elements";
import type { VariantProps } from "tailwind-variants";
import { cn, tv, type WithElementRef } from "$lib/utils.ts";

export const buttonVariants = tv({
  base: "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap select-none transition-[transform,background-color,opacity] duration-(--duration-quick) motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-primary/88",
      secondary: "bg-fill text-label hover:bg-fill-strong",
      ghost: "hover:bg-fill",
      outline: "border border-input bg-transparent hover:bg-fill",
      tinted: "bg-tint-fill text-tint hover:bg-tint-fill/80",
      glass: "material text-label shadow-float",
      destructive: "bg-destructive text-destructive-foreground",
      link: "text-tint underline-offset-4 hover:underline",
    },
    size: {
      sm: "h-8 px-3 text-footnote",
      default: "h-10 px-4 text-subheadline pointer-coarse:h-11",
      lg: "h-12 px-6 text-headline rounded-lg [&_svg:not([class*='size-'])]:size-5",
      icon: "size-10 rounded-full pointer-coarse:size-11",
      "icon-sm": "size-8 rounded-full",
      "icon-lg": "size-12 rounded-full",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
  WithElementRef<HTMLAnchorAttributes> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  };
</script>

<script lang="ts">
  let {
    class: className,
    variant = "default",
    size = "default",
    ref = $bindable(null),
    href = undefined,
    type = "button",
    disabled,
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    href={disabled ? undefined : href}
    aria-disabled={disabled}
    role={disabled ? "link" : undefined}
    tabindex={disabled ? -1 : undefined}
    {...restProps}
  >
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {disabled}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}
