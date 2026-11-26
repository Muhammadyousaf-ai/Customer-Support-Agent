import pino from "pino";

/**
 * Structured JSON logs (pino), correlated with traces by traceId/runId/sessionId. Redaction here is a second line of
 * defence: the fields below are never logged even if a caller passes them by mistake.
 */
export const logger = pino({
  level: process.env.VITEST ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  base: { service: "support-ai" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: ["*.apiKey", "*.api_key", "*.authorization", "*.token", "*.verificationCode", "*.code", "*.resumptionHandle", "*.ticket", "*.password", "*.audio", "*.connectionString"], censor: "[redacted]" },
});

export const moduleLogger = (module: string) => logger.child({ module });
