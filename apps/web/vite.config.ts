import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const api = process.env.PENDIA_DEV_API ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      "/rpc": api,
      "/api": api,
      "/healthz": api,
    },
  },
});
