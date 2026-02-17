import { runRustIntegrationTest } from "./rust.test";

// VS Code test runner entrypoint (referenced by @vscode/test-electron).
// Keep this minimal and avoid extra dependencies (no mocha/glob required).
export async function run(): Promise<void> {
  await runRustIntegrationTest();
}
