import { focusAuto } from "./focus_auto.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function printHelp() {
  // Keep output plain for easy copy/paste into docs.
  console.log(`context-slicer\n\nUsage:\n  context-slicer focus-auto <target> [model]\n  context-slicer mcp\n\nOutputs:\n  .context-slicer/active_context.xml\n  .context-slicer/active_context.meta.json\n`);
}

async function runMcp() {
  const server = new McpServer({ name: "context-slicer", version: "0.1.0" });

  server.tool(
    "context_slicer_focus_auto",
    {
      repoPath: z.string().optional().describe("Repo root (defaults to current working directory)"),
      target: z.string().describe("Module name, directory, or glob (depending on repo preset)"),
      modelId: z.string().optional().describe("Model id (e.g. gpt-5.3-codex). Optional; auto-detected when possible."),
      budgetTokens: z.number().int().positive().optional().describe("Override token budget")
    },
    async ({ repoPath, target, modelId, budgetTokens }) => {
      const repoRoot = repoPath || process.cwd();
      const meta = focusAuto({ repoRoot, target, modelId, budgetTokens });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                outputDir: ".context-slicer",
                outputFile: ".context-slicer/active_context.xml",
                meta
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log("0.1.0");
    return;
  }

  if (cmd === "mcp") {
    await runMcp();
    return;
  }

  if (cmd === "focus-auto") {
    const target = argv[1];
    const model = argv[2];
    if (!target) {
      printHelp();
      process.exitCode = 2;
      return;
    }
    const meta = await focusAuto({ repoRoot: process.cwd(), target, modelId: model });
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exitCode = 1;
});
