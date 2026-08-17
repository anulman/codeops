import { transformAsync } from "@babel/core";
import styleXPlugin from "@stylexjs/babel-plugin";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig, type Plugin } from "vite";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";

function styleXTransform(dev: boolean): Plugin {
  const rootDir = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "codeops-stylex",
    enforce: "pre",
    async transform(source, id) {
      if (!id.startsWith(rootDir) || !/\.[jt]sx?$/.test(id)) return null;
      const result = await transformAsync(source, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: {
          plugins: ["jsx", "typescript"],
        },
        plugins: [[styleXPlugin, {
          dev,
          runtimeInjection: false,
          unstable_moduleResolution: {
            type: "commonJS",
            rootDir,
          },
        }]],
      });
      return result?.code ? { code: result.code, map: result.map } : null;
    },
  };
}

export default defineConfig(({ command }) => ({
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
  plugins: [
    styleXTransform(command === "serve"),
    tanstackStart(),
    viteReact(),
    nitro(),
  ],
}));
