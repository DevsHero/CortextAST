#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { focusAuto } from "./focus_auto.js";

const server = new McpServer({
  name: "context-slicer",
  version: "0.1.0"
});

server.tool(
  "context_slicer_focus_auto",
  {
    repoPath: z.string().optional().describe("Repo root (defaults to current working directory)"),
    target: z.string().describe("Module name, directory, or glob (depending on repo preset)") ,
    modelId: z.string().optional().describe("Model id (e.g. gpt-5.3-codex). Optional; auto-detected when possible."),
    budgetTokens: z.number().int().positive().optional().describe("Override token budget")
  },
  async ({ repoPath, target, modelId, budgetTokens }) => {
    const repoRoot = repoPath || process.cwd();
    const meta = await focusAuto({ repoRoot, target, modelId, budgetTokens });

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
