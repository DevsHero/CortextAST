import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
  // Compiled location: extension/out/test/runTest.js
  // extensionRoot:      extension/
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  // Open the monorepo root as the workspace (so manifests like package.json resolve).
  const workspacePath = path.resolve(extensionDevelopmentPath, "..");

  console.log("[integration] extensionDevelopmentPath=", extensionDevelopmentPath);
  console.log("[integration] extensionTestsPath=", extensionTestsPath);
  console.log("[integration] workspacePath=", workspacePath);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
    extensionTestsEnv: {
      ANVIL_HOLO_INTEGRATION: "1"
    }
  });
}

main().catch((err) => {
  console.error("[integration] FAILED", err);
  process.exit(1);
});
