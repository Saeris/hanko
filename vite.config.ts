import { defineConfig } from "vite-plus";
import { lint, fmt } from "@saeris/configs";

// Root config for the workspace. Each package carries its own `pack` and
// `test` config; this one only supplies the shared lint and format rules so
// `vp check` at the root covers every workspace uniformly.
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
  }
});
