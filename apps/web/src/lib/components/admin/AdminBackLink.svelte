<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";

/** The tinted back row above an admin page title; hidden on desktop unless `always`. */
const {
  href,
  label,
  always = false,
}: { href: string; label: string; always?: boolean } = $props();
</script>

<a
  {href}
  class="flex h-11 items-center gap-0.5 text-tint text-body {always
    ? ''
    : 'lg:hidden'}"
>
  <ChevronLeftIcon class="size-5" />
  {label}
</a>
