import express, { type Express } from "express";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { corsMiddleware, requestIdMiddleware, setSecurityHeaders } from "./http.js";
import { ParserService } from "./parser.js";
import { createApiRouter } from "./routes.js";

export interface AppDependencies {
  parser?: ParserService;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestIdMiddleware);
  app.use(setSecurityHeaders);
  app.use(corsMiddleware(config.corsOrigins));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  app.use("/api", createApiRouter(dependencies.parser ?? new ParserService()));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();

