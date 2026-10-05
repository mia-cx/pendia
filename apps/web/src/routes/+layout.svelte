<script lang="ts">
import "$lib/app.css";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import type { LayoutProps } from "./$types";

const { children }: LayoutProps = $props();
</script>

{@render children()}

<Toaster />
