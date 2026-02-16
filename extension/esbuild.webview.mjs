import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/webview/index.tsx"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  sourcemap: true,
  define: {
    "process.env.NODE_ENV": '"production"'
  },
  loader: {
    ".css": "css",
    ".svg": "text"
  },
  logLevel: "info"
});

if (watch) {
  await ctx.watch();
  console.log("[anvil-holo] webview watch enabled");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
