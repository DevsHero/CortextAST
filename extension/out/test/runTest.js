"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/test/runTest.ts
var path = __toESM(require("node:path"));
var import_test_electron = require("@vscode/test-electron");
async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = path.resolve(extensionDevelopmentPath, "..");
  console.log("[integration] extensionDevelopmentPath=", extensionDevelopmentPath);
  console.log("[integration] extensionTestsPath=", extensionTestsPath);
  console.log("[integration] workspacePath=", workspacePath);
  await (0, import_test_electron.runTests)({
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
//# sourceMappingURL=runTest.js.map
