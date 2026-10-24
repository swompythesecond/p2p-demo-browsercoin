import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained index.html: host it anywhere, or save it and open it
// straight from disk. Both are part of what the demo is proving.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
});
