import { Injectable } from "@nestjs/common";
import type { ToolResult } from "@support-ai/contracts";

@Injectable()
export class RetryService {
  /** Bounded retry with exponential backoff, only for failures the tool marked retryable. */
  async run<T>(
    attempt: (n: number) => Promise<ToolResult<T>>,
    opts: { maxRetries: number; baseDelayMs: number },
  ): Promise<{ result: ToolResult<T>; attempts: number }> {
    let n = 0;
    for (;;) {
      n++;
      const result = await attempt(n);
      if (result.success || !result.error?.retryable || n > opts.maxRetries) return { result, attempts: n };
      await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (n - 1)));
    }
  }
}
