import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = "BAD_REQUEST", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  if (req.path.startsWith("/api") || req.path.startsWith("/cdn")) {
    res.status(404).json({ error: "Not found.", code: "NOT_FOUND" });
    return;
  }
  res.status(404).send("Not found");
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: error.issues[0]?.message ?? "Invalid request.",
      code: "VALIDATION_ERROR",
      details: error.issues,
    });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
    return;
  }
  const e = error as { status?: number; code?: string; message?: string; details?: unknown };
  if (e && typeof e.status === "number" && typeof e.message === "string") {
    res.status(e.status).json({ error: e.message, code: e.code ?? "ERROR", details: e.details });
    return;
  }
  console.error("[gitfi] unhandled error", error);
  res.status(500).json({
    error: "Something went wrong on our side. No funds moved.",
    code: "INTERNAL_ERROR",
  });
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
