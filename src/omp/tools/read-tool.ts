import { readFile } from "node:fs/promises";
import type { RegisteredOmpTool } from "../registry-runtime.js";

export const createReadTool = (): RegisteredOmpTool => ({
  definition: {
    name: "read",
    description: "Read a UTF-8 file from the current OMP workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },

  async execute(request) {
    const path = String(request.arguments.path ?? "");
    if (!path) {
      return {
        isError: true,
        content: [{ type: "text", text: "path is required" }],
      };
    }

    try {
      const content = await readFile(path, "utf8");
      return {
        isError: false,
        content: [{ type: "text", text: content }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  },
});
