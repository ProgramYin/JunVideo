import bcrypt from "bcryptjs";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config.js";
import { query } from "./db.js";
import { AppError } from "./errors.js";
import { asyncHandler } from "./http.js";

const PASSWORD_SALT_ROUNDS = 12;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_vip: boolean;
  vip_activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  isVip: boolean;
  vipActivatedAt: string | null;
  createdAt: string;
}

export interface AccessTokenClaims extends JwtPayload {
  sub: string;
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: AuthUser;
    }
  }
}

export function toPublicUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    isVip: row.is_vip,
    vipActivatedAt: row.vip_activated_at,
    createdAt: row.created_at,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function issueAccessToken(user: Pick<AuthUser, "id">): string {
  const options: SignOptions = {
    expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
    issuer: "junvideo",
    audience: "junvideo-client",
  };
  return jwt.sign({ sub: user.id }, config.jwtSecret, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: "junvideo",
    audience: "junvideo-client",
  });
  if (typeof decoded === "string" || typeof decoded.sub !== "string") {
    throw new AppError(401, "INVALID_TOKEN", "The access token is invalid.");
  }
  return decoded as AccessTokenClaims;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash, is_vip, vip_activated_at, created_at, updated_at
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash, is_vip, vip_activated_at, created_at, updated_at
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createUser(email: string, password: string): Promise<UserRow> {
  const passwordHash = await hashPassword(password);
  try {
    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, password_hash, is_vip, vip_activated_at, created_at, updated_at`,
      [email, passwordHash],
    );
    return result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function bearerToken(request: Request): string | null {
  const header = request.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export const requireAuth: RequestHandler = asyncHandler(async (request, _response, next) => {
  const token = bearerToken(request);
  if (!token) {
    throw new AppError(401, "AUTH_REQUIRED", "A Bearer access token is required.");
  }

  let claims: AccessTokenClaims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "The access token is invalid or expired.");
  }

  const user = await findUserById(claims.sub);
  if (!user) {
    throw new AppError(401, "INVALID_TOKEN", "The access token no longer maps to an account.");
  }

  request.user = toPublicUser(user);
  next();
});

export function authenticatedUser(request: Request): AuthUser {
  if (!request.user) {
    throw new AppError(500, "AUTH_CONTEXT_MISSING", "Authentication context was not initialized.", { expose: false });
  }
  return request.user;
}

export function sendAuthResponse(response: Response, row: UserRow, statusCode = 200): void {
  const user = toPublicUser(row);
  response.status(statusCode).json({ token: issueAccessToken(user), user });
}

export function unusedNext(_request: Request, _response: Response, _next: NextFunction): void {
  // Kept as a named no-op hook for integrations that need to compose middleware.
}

