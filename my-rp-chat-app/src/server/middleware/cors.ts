import type { Request, Response, NextFunction } from "express";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

export interface CorsMiddlewareOptions {
  allowNullOrigin?: boolean;
  allowedOrigins?: string[];
}

export function readCorsAllowedOriginsFromEnv(): string[] {
  return (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isNullOriginAllowedFromEnv(): boolean {
  return process.env.CORS_ALLOW_NULL_ORIGIN === "true";
}

function normalizeOptions(options: CorsMiddlewareOptions | boolean): Required<CorsMiddlewareOptions> {
  if (typeof options === "boolean") {
    return {
      allowNullOrigin: options,
      allowedOrigins: readCorsAllowedOriginsFromEnv(),
    };
  }

  return {
    allowNullOrigin: options.allowNullOrigin ?? false,
    allowedOrigins: options.allowedOrigins ?? readCorsAllowedOriginsFromEnv(),
  };
}

function isOriginAllowed(origin: string, configuredOrigins: string[]): boolean {
  const allowedOrigins = configuredOrigins.length > 0
    ? configuredOrigins
    : DEFAULT_ALLOWED_ORIGINS;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function createCorsMiddleware(options: CorsMiddlewareOptions | boolean = {}) {
  const { allowNullOrigin, allowedOrigins } = normalizeOptions(options);

  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin;

    if (!origin) {
      next();
      return;
    }

    if (origin === "null") {
      if (!allowNullOrigin) {
        response.status(403).json({ message: "origin not allowed" });
        return;
      }
      response.header("Access-Control-Allow-Origin", "null");
    } else if (isOriginAllowed(origin, allowedOrigins)) {
      response.header("Access-Control-Allow-Origin", origin);
      response.header("Vary", "Origin");
    } else {
      response.status(403).json({ message: "origin not allowed" });
      return;
    }

    response.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  };
}
