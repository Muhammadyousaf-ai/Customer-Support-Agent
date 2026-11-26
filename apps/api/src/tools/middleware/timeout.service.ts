import { Injectable } from "@nestjs/common";
import { ToolError } from "../errors/tool-error.js";

@Injectable()
export class TimeoutService {
  /**
   * Runs `fn` with an abort signal and rejects with TOOL_TIMEOUT after `ms`. A tool that ignores the signal may
   * still finish in the background, which is why every write tool is idempotent: the retry finds the result.
   */
  async run<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject first: aborting makes the tool's own promise reject synchronously, and if that won the race
        // the caller would see the tool's abort error instead of a retryable TOOL_TIMEOUT.
        reject(new ToolError("TOOL_TIMEOUT", `The tool did not finish within ${ms} ms.`, true));
        controller.abort();
      }, ms);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
