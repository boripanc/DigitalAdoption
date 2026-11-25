// Bundles the extension into dist/, which is what you load in chrome://extensions.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const ctx = await esbuild.context({
  entryPoints: { background: 'src/background.ts', content: 'src/content.ts', popup: 'src/popup.ts', ui5bridge: 'src/ui5bridge.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome114',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
});
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
