import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same origin in dev, as nginx makes it in production (`docker/web`): the
    // session cookie and the CSRF header need nothing else. The api is
    // `pnpm --filter tic-campus-api start` on :3000 — see the README's
    // "Una sesión de verdad" for driving a login against the mock.
    proxy: { "/api": "http://localhost:3000" },
  },
});
