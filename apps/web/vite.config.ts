import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ProxyOptions } from "vite";

const api = process.env.PENDIA_DEV_API ?? "http://127.0.0.1:3000";

// Keep the dev server's Host so the API's Origin check sees a same-origin call.
const sameOrigin: ProxyOptions = { target: api, changeOrigin: false };

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      "/rpc": sameOrigin,
      "/api": sameOrigin,
      "/healthz": sameOrigin,
      "/readyz": sameOrigin,
    },
  },
});
