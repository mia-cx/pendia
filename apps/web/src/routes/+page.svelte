<svelte:head>
  <title>Pendia</title>
  <meta
    name="description"
    content="Pendia is a self-hosted media server for your library."
  />
</svelte:head>

<main>
  <div class="wordmark" aria-hidden="true">P</div>
  <h1>Pendia</h1>
  <p>Your library. Your server.</p>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(:root) {
    color-scheme: light dark;
    font-family:
      ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    font-synthesis: none;
    --canvas: oklch(97% 0.012 250deg);
    --ink: oklch(22% 0.025 250deg);
    --muted: oklch(48% 0.025 250deg);
    --signal: oklch(57% 0.17 255deg);
  }

  :global(body) {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
  }

  main {
    display: grid;
    min-height: 100svh;
    place-content: center;
    padding: 32px;
    text-align: center;
  }

  .wordmark {
    display: grid;
    width: 56px;
    height: 56px;
    margin: 0 auto 24px;
    place-items: center;
    border-radius: 16px;
    background: var(--signal);
    color: oklch(98% 0.01 250deg);
    font-size: 28px;
    font-weight: 750;
  }

  h1 {
    margin: 0;
    font-size: clamp(42px, 9vw, 72px);
    letter-spacing: -0.055em;
    line-height: 1;
    text-wrap: balance;
  }

  p {
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 16px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --canvas: oklch(17% 0.02 250deg);
      --ink: oklch(94% 0.012 250deg);
      --muted: oklch(70% 0.025 250deg);
      --signal: oklch(66% 0.17 255deg);
    }
  }

  @media (prefers-contrast: more) {
    :global(:root) {
      --canvas: oklch(100% 0 0deg);
      --ink: oklch(10% 0 0deg);
      --muted: oklch(30% 0 0deg);
    }
  }

  @media (prefers-contrast: more) and (prefers-color-scheme: dark) {
    :global(:root) {
      --canvas: oklch(8% 0 0deg);
      --ink: oklch(98% 0 0deg);
      --muted: oklch(82% 0 0deg);
    }
  }
</style>
