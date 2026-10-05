<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import { afterNavigate, goto } from "$app/navigation";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";

const {
  title,
  fallbackHref,
  hero,
}: {
  title: string;
  /** Where Back lands when the page was opened directly. */
  fallbackHref: string;
  /** The hero element the bar reads to know when to solidify. */
  hero: HTMLElement | undefined;
} = $props();

// The bar is 56 px tall; the hero pulls up under it by the same amount.
const barHeight = "56px";

let past = $state(false);
let inApp = $state(false);

$effect(() => {
  if (hero === undefined) return;
  // The bar solidifies once the hero is about half scrolled away: a sentinel
  // inside the hero leaves view when its middle reaches the bar.
  const sentinel = document.createElement("div");
  sentinel.style.cssText =
    "position:absolute;left:0;right:0;top:50%;height:1px;pointer-events:none";
  sentinel.setAttribute("aria-hidden", "true");
  const host = hero.firstElementChild ?? hero;
  host.appendChild(sentinel);
  const observer = new IntersectionObserver(
    (entries) => {
      past = !entries.some((entry) => entry.isIntersecting);
    },
    { threshold: 0, rootMargin: `-${barHeight} 0px 0px 0px` },
  );
  observer.observe(sentinel);
  return () => {
    observer.disconnect();
    sentinel.remove();
  };
});

afterNavigate(({ from }) => {
  inApp = from !== null;
});

function back() {
  if (inApp) history.back();
  else void goto(fallbackHref);
}
</script>

<div
  class="bleed sticky top-0 z-20 transition-[background-color,border-color,box-shadow] duration-(--duration-fast) {past
    ? 'material border-b border-separator'
    : ''}"
>
  <div
    class="flex h-14 items-center gap-3 ps-(--shell-start) pe-(--gutter)"
  >
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="glass"
            size="icon-lg"
            class="size-11"
            onclick={back}
            aria-label="Back"
          >
            <ChevronLeftIcon />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Back</Tooltip.Content>
    </Tooltip.Root>
    <p
      class="truncate text-headline transition-opacity duration-(--duration-fast) {past
        ? 'opacity-100'
        : 'opacity-0'}"
      aria-hidden={!past}
    >
      {title}
    </p>
  </div>
</div>
