import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 4176,
    allowedHosts: ["agents.codeops.example"],
  },
  optimizeDeps: {
    exclude: ["@tanstack/react-start", "@tanstack/start-server-core"],
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), nitro()],
});
