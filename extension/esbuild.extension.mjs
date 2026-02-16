import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});

if (watch) {
  await ctx.watch();
  console.log("[anvil-holo] extension watch enabled");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
