<script lang="ts">
import { oidcLoginUrl } from "../auth.ts";

const { name, invite }: { name: string | null; invite?: string } = $props();
</script>

<!-- A server route, so the router must hand it to the browser. -->
<a class="oidc" href={oidcLoginUrl(invite)} data-sveltekit-reload
  >Sign in with {name ?? "SSO"}</a
>

<style>
  .oidc {
    display: grid;
    min-height: 32px;
    place-items: center;
    padding: 4px 14px;
    border: 1px solid color-mix(in oklch, var(--ink) 32%, transparent);
    border-radius: 6px;
    color: var(--ink);
    text-decoration: none;
  }

  .oidc:hover {
    border-color: var(--ink);
  }
</style>
