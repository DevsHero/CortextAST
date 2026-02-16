import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

function makePayload(nodesCount: number, edgesCount: number) {
  const nodes = Array.from({ length: nodesCount }, (_, i) => ({
    id: `node-${i}`,
    label: `Node ${i}`
  }));

  const edges = Array.from({ length: edgesCount }, (_, i) => ({
    source: `node-${i % nodesCount}`,
    target: `node-${(i + 1) % nodesCount}`
  }));

  return { nodes, edges };
}

describe("AnvilHolo Webview", () => {
  test("renders nodes after UPDATE_GRAPH message", async () => {
    const { App } = await import("./App");
    render(<App />);

    const payload = makePayload(482, 818);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "UPDATE_GRAPH",
          payload
        }
      })
    );

    // Mandatory assertion as requested (expected to fail initially).
    await waitFor(() => {
      expect(screen.getAllByTestId("rf__node")).toHaveLength(482);
    });
  });
});
