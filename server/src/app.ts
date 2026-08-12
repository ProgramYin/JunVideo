import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { corsMiddleware, requestIdMiddleware, setSecurityHeaders } from "./http.js";
import { ParserService } from "./parser.js";
import { createApiRouter } from "./routes.js";
import { SubtitleTextService } from "./subtitle-text.js";
import { EmbeddedSubtitleService } from "./embedded-subtitle.js";

export interface AppDependencies {
  parser?: ParserService;
  subtitleTextService?: SubtitleTextService;
  embeddedSubtitleService?: EmbeddedSubtitleService;
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

  app.use("/api", createApiRouter(
    dependencies.parser ?? new ParserService(),
    dependencies.subtitleTextService ?? new SubtitleTextService(config),
    dependencies.embeddedSubtitleService ?? new EmbeddedSubtitleService(config),
  ));

  const clientDist = join(process.cwd(), "dist", "client");
  const clientIndex = join(clientDist, "index.html");
  if (config.serveClient && existsSync(clientIndex)) {
    app.use(express.static(clientDist, {
      index: false,
      setHeaders(response, filePath) {
        response.setHeader(
          "Cache-Control",
          filePath.includes(`${join("dist", "client", "assets")}`)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600",
        );
      },
    }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api") || !request.accepts("html")) {
        next();
        return;
      }
      response.setHeader("Cache-Control", "no-cache");
      response.sendFile(clientIndex);
    });
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();

