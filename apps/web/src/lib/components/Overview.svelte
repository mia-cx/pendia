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
  class="relative max-w-[36rem] text-callout text-white/90 line-clamp-3"
>
  {text}
  {#if overflows}
    <span
      class="absolute right-0 bottom-0 flex items-center"
    >
      <span
        class="pointer-events-none absolute inset-y-0 right-full w-10 bg-linear-to-l from-black/85 to-transparent"
        aria-hidden="true"
      ></span>
      <button
        type="button"
        class="material rounded-full bg-black/85 px-2.5 py-1 text-caption-1 font-semibold tracking-wide uppercase text-white"
        onclick={() => (open = true)}
      >
        More
      </button>
    </span>
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
