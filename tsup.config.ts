import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'mcp-server': 'src/mcp-server.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: true,
  shims: false,
});
