import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../../config/env.js";
import { ENV } from "../../config/tokens.js";
import { ToolError } from "../errors/tool-error.js";

export const SIMULATION_MODES = ["timeout", "db_temporary", "permanent", "after_commit", "timeout_after_commit"] as const;
export type SimulationMode = (typeof SIMULATION_MODES)[number];

interface Rule {
  mode: SimulationMode;
  remaining: number;
}

function abortableSleep(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((_, reject) => {
    // Never resolves on its own: the executor's timeout aborts it.
    signal?.addEventListener("abort", () => reject(new ToolError("TOOL_TIMEOUT", "aborted", true)), { once: true });
  });
}

/**
 * Development-only failure injection, so recovery can be demonstrated on demand.
 * Arm via SIMULATE_TOOL_FAILURE="issue_refund:after_commit:1" or `arm()` in tests. Disabled in production.
 *
 *  - timeout:              the tool hangs before doing anything (retry runs it for real)
 *  - db_temporary:         a retryable database error for the next N attempts
 *  - permanent:            non-retryable SIMULATED_FAILURE on every attempt
 *  - after_commit:         the tool commits, then the call fails with a retryable error
 *  - timeout_after_commit: the tool commits, then the response is "lost" and the call times out
 */
@Injectable()
export class FailureSimulator {
  private readonly rules = new Map<string, Rule>();
  readonly enabled: boolean;

  constructor(@Inject(ENV) env: Env) {
    this.enabled = env.NODE_ENV !== "production";
    if (this.enabled && env.SIMULATE_TOOL_FAILURE) {
      const [tool, mode, times] = env.SIMULATE_TOOL_FAILURE.split(":");
      if (tool && SIMULATION_MODES.includes(mode as SimulationMode)) this.arm(tool, mode as SimulationMode, Number(times) || 1);
    }
  }

  arm(tool: string, mode: SimulationMode, times = 1): void {
    if (!this.enabled) throw new Error("Failure simulation is disabled in production");
    this.rules.set(tool, { mode, remaining: mode === "permanent" ? Number.POSITIVE_INFINITY : times });
  }

  clear(): void {
    this.rules.clear();
  }

  private take(tool: string, modes: SimulationMode[]): SimulationMode | undefined {
    const rule = this.rules.get(tool);
    if (!rule || !modes.includes(rule.mode) || rule.remaining <= 0) return undefined;
    rule.remaining--;
    return rule.mode;
  }

  async beforeExecute(tool: string, signal: AbortSignal): Promise<void> {
    switch (this.take(tool, ["timeout", "db_temporary", "permanent"])) {
      case "timeout":
        return abortableSleep(signal);
      case "db_temporary":
        throw new ToolError("DATABASE_UNAVAILABLE", "Simulated temporary database failure.", true);
      case "permanent":
        throw new ToolError("SIMULATED_FAILURE", "Simulated permanent tool failure.", false);
    }
  }

  async afterExecute(tool: string, signal: AbortSignal): Promise<void> {
    switch (this.take(tool, ["after_commit", "timeout_after_commit"])) {
      case "after_commit":
        throw new ToolError("SIMULATED_FAILURE", "Simulated failure immediately after commit.", true);
      case "timeout_after_commit":
        return abortableSleep(signal);
    }
  }
}
