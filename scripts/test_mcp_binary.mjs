import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exe = process.platform === "win32" ? "dist/context-slicer.exe" : "dist/context-slicer";
if (!existsSync(exe)) {
  throw new Error(`Missing binary: ${exe}. Run npm run build:binary first.`);
}

const transport = new StdioClientTransport({
  command: resolve(exe),
  args: ["mcp"],
  cwd: process.cwd(),
  stderr: "inherit"
});

const client = new Client(
  { name: "context-slicer-test", version: "0.0.0" },
  { capabilities: {} }
);

await client.connect(transport);

const tools = await client.listTools();
const names = (tools.tools ?? []).map((t) => t.name);
if (!names.includes("context_slicer_focus_auto")) {
  throw new Error(`Expected tool context_slicer_focus_auto, got: ${names.join(", ")}`);
}

const result = await client.callTool({
  name: "context_slicer_focus_auto",
  arguments: { target: "mixer" }
});

if (!result || !Array.isArray(result.content) || result.content.length === 0) {
  throw new Error("Expected non-empty callTool result content");
}

await client.close();

console.log("binary MCP ok");
