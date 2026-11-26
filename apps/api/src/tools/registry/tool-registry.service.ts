import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { TOOLS, type ToolDefinition } from "./tool-definition.interface.js";

@Injectable()
export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(@Inject(TOOLS) tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
  }

  find(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  /** LLM-facing function descriptions (name, description, JSON Schema) for the Phase 4 orchestrator. */
  describe() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      type: t.type,
      requiresIdentity: t.requiresIdentity,
      parameters: z.toJSONSchema(t.inputSchema),
    }));
  }
}
