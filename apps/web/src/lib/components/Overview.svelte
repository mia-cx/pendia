<script lang="ts">
import { onMount } from "svelte";
import * as Dialog from "$lib/components/ui/dialog/index.ts";

const {
  text,
  title,
}: {
  text: string;
  /** The Item's title, heading the More dialog. */
  title: string;
} = $props();

let paragraph = $state<HTMLElement | undefined>(undefined);
let overflows = $state(false);
let open = $state(false);

function measure() {
  if (paragraph)
    overflows = paragraph.scrollHeight > paragraph.clientHeight + 1;
}

onMount(() => {
  measure();
  const observer = new ResizeObserver(measure);
  if (paragraph) observer.observe(paragraph);
  return () => observer.disconnect();
});
</script>

<p
  bind:this={paragraph}
  class:overflowed={overflows}
  class="relative max-w-[36rem] text-callout text-white/90 line-clamp-3"
>
  {text}
  {#if overflows}
    <button
      type="button"
      class="material absolute right-0 bottom-0 rounded-full px-2.5 py-1 text-caption-1 font-semibold tracking-wide uppercase text-white"
      onclick={() => (open = true)}
    >
      More
    </button>
  {/if}
</p>

<Dialog.Root bind:open>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
    </Dialog.Header>
    <p class="text-callout text-label whitespace-pre-line">{text}</p>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Fade the last line's tail under the More pill. */
  .overflowed {
    mask-image:
      linear-gradient(#000, #000),
      linear-gradient(to left, transparent 4.5rem, #000 7rem);
    mask-size:
      100% calc(100% - 1lh),
      100% 1lh;
    mask-position: top, bottom;
    mask-repeat: no-repeat;
  }
</style>
