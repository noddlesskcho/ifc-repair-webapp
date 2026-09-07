import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"));

// `base: "./"` makes every built asset URL relative, so the same dist/
// output works whether it's served at the root of a GitHub Pages user site
// or under a project subpath (https://<user>.github.io/<repo>/) without any
// per-repo configuration.
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
