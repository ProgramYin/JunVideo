import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const requestId = request.header("x-request-id")?.trim() || randomUUID();
  request.requestId = requestId.slice(0, 100);
  response.setHeader("x-request-id", request.requestId);
  next();
}

export function corsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  return (request, response, next) => {
    const origin = request.header("origin");
    if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-Request-Id");
    }

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  };
}

export function setSecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
}

