import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: [
    { in: "src/test/runTest.ts", out: "runTest" },
    { in: "src/test/suite/index.ts", out: "suite/index" }
  ],
  outdir: "out/test",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  external: ["vscode", "@vscode/test-electron"],
  logLevel: "info"
});

if (watch) {
  await ctx.watch();
  console.log("[anvil-holo] integration test build watch enabled");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
