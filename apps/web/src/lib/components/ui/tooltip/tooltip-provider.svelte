<script lang="ts">
import { Tooltip as TooltipPrimitive } from "bits-ui";

let {
  delayDuration = 500,
  skipDelayDuration = 300,
  ...restProps
}: TooltipPrimitive.ProviderProps = $props();
</script>

<TooltipPrimitive.Provider {delayDuration} {skipDelayDuration} {...restProps} />
