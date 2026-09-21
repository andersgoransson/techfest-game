import { defineConfig } from 'vite';

// GitHub Pages serves this project repo under a subpath
// (https://andersgoransson.github.io/techfest-game/), so all built asset URLs
// must be prefixed with the repo name instead of the domain root.
export default defineConfig({
  base: '/techfest-game/',
});
