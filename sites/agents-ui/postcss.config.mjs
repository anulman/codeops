import styleXPostcss from "@stylexjs/postcss-plugin";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default {
  plugins: [
    styleXPostcss({
      include: ["src/**/*.{ts,tsx}"],
      cwd: rootDir,
      babelConfig: {
        babelrc: false,
        configFile: false,
        parserOpts: {
          plugins: ["jsx", "typescript"],
        },
        plugins: [["@stylexjs/babel-plugin", {
          dev: false,
          runtimeInjection: false,
          unstable_moduleResolution: {
            type: "commonJS",
            rootDir,
          },
        }]],
      },
    }),
  ],
};
