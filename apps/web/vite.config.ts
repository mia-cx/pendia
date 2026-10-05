import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ProxyOptions } from "vite";

const api = process.env.PENDIA_DEV_API ?? "http://127.0.0.1:3000";

// The API checks Origin on mutations, so the dev proxy has to forward the
// API's own origin rather than the page's.
const proxied: ProxyOptions = {
  target: api,
  changeOrigin: true,
  headers: { origin: api },
};

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      "/rpc": proxied,
      "/api": proxied,
      "/healthz": api,
    },
  },
});
