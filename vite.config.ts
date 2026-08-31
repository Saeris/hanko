import { defineConfig } from "vite-plus";
import { lint, fmt } from "@saeris/configs";
import manifest from "./package.json" with { type: "json" };

export default defineConfig({
  lint: {
    ...lint,
    ignorePatterns: [
      ...(lint.ignorePatterns ?? []),
      // Astro regenerates these on every `dev` and `build`. Linting generated
      // output reports problems nobody can fix in the source.
      "**/.astro/**",
      "**/dist/**"
    ]
  },
  fmt: {
    ...fmt,
    ignorePatterns: [
      ...(fmt.ignorePatterns ?? []),
      "**/.astro/**",
      "**/dist/**"
    ]
  },
  // ── Builds (tsdown) ─────────────────────────────────────────────────
  pack: {
    entry: [
      manifest.exports["."].import.development,
      manifest.exports["./qr"].import.development,
      manifest.exports["./client"].import.development,
      manifest.exports["./approve"].import.development,
      manifest.exports["./scan"].import.development,
      manifest.exports["./handlers"].import.development,
      manifest.exports["./stores/memory"].import.development,
      manifest.exports["./stores/kv"].import.development
    ],
    clean: true,
    format: [`esm`],
    dts: true,
    outDir: `./dist`
  },
  // ── Testing (Vitest) ────────────────────────────────────────────────
  test: {
    name: manifest.name,
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    passWithNoTests: true
  }
});
