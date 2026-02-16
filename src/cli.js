#!/usr/bin/env node

import { focusAuto } from "./focus_auto.js";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const [cmd, target, model] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`context-slicer\n\nCommands:\n  focus-auto <target> [model]\n\nExamples:\n  context-slicer focus-auto mixer\n  context-slicer focus-auto mixer gpt-5.3-codex\n`);
    return;
  }

  if (cmd !== "focus-auto") {
    die(`Unknown command: ${cmd}`);
  }
  if (!target) {
    die("Missing <target>");
  }

  const meta = await focusAuto({ repoRoot: process.cwd(), target, modelId: model });
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((e) => die(e?.stack || String(e)));
