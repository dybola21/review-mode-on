import pino from "pino";

export const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "signedUrl",
      "signedUploadUrl",
      "*.signedUrl",
      "*.signedUploadUrl",
      "authorization",
      "Authorization",
      "headers.authorization",
      "headers.Authorization",
      "APP_WEBHOOK_SECRET",
      "WORKER_API_KEY",
    ],
    remove: true,
  },
  base: undefined,
});
