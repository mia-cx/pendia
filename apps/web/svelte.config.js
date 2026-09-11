import adapter from "@sveltejs/adapter-static";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    // Prerendered pages keep their own files; 200.html is the fallback for client-side routes.
    adapter: adapter({ fallback: "200.html" }),
  },
};

export default config;
