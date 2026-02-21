// User service module for managing user accounts and authentication.
// Provides CRUD operations, session management, and role-based access control.

// ============================================================
// SECTION 1: Imports and Constants
// ============================================================
import { Database } from "./database";
import { Logger } from "./logger";
import { hashPassword, verifyPassword } from "./crypto";
import { EventEmitter } from "./events";

const MAX_LOGIN_ATTEMPTS = 3;
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes (branch_a)
const DEFAULT_ROLE = "editor";
const PASSWORD_MIN_LENGTH = 10;

// ============================================================
// SECTION 2: Types
// ============================================================
interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  createdAt: Date;
  lastLogin: Date | null;
}

interface Session {
  token: string;
  userId: string;
  expiresAt: Date;
}

// ============================================================
// SECTION 3: UserService class
// ============================================================
export class UserService {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  // ----------------------------------------------------------
  // SECTION 3a: Core authentication method
  // ----------------------------------------------------------
  async authenticate(email: string, password: string): Promise<Session | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.db.findUserByEmail(normalizedEmail);
    if (!user) {
      this.logger.warn(`Login attempt for unknown email: ${normalizedEmail}`);
      await this.db.recordFailedAttempt(normalizedEmail);
      return null;
    }

    const attempts = await this.db.getLoginAttempts(user.id);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      this.logger.error(`Account locked after ${MAX_LOGIN_ATTEMPTS} attempts: ${user.id}`);
      await this.notifyAccountLocked(user);
      return null;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await this.db.incrementLoginAttempts(user.id);
      this.logger.warn(`Failed login attempt ${attempts + 1} for user: ${user.id}`);
      return null;
    }

    await this.db.resetLoginAttempts(user.id);
    const session = await this.createSession(user.id);
    await this.db.updateLastLogin(user.id);
    this.logger.info(`User ${user.id} authenticated via email/password`);
    return session;
  }

  private async notifyAccountLocked(user: User): Promise<void> {
    this.logger.error(`Sending lock notification to ${user.email}`);
  }

  // ----------------------------------------------------------
  // SECTION 3b: User creation
  // ----------------------------------------------------------
  async createUser(email: string, name: string, password: string): Promise<User> {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    const existing = await this.db.findUserByEmail(email);
    if (existing) {
      throw new Error("Email already registered");
    }

    const passwordHash = await hashPassword(password);
    const user = await this.db.insertUser({
      email,
      name,
      passwordHash,
      role: DEFAULT_ROLE,
      createdAt: new Date(),
      lastLogin: null,
    });

    this.logger.info(`Created user: ${user.id}`);
    return user;
  }

  // ----------------------------------------------------------
  // SECTION 3c: Session management helpers
  // ----------------------------------------------------------
  private async createSession(userId: string): Promise<Session> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_MS);

    await this.db.insertSession({ token, userId, expiresAt });
    return { token, userId, expiresAt };
  }

  private generateToken(): string {
    const segments: string[] = [];
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let s = 0; s < 4; s++) {
      let segment = "";
      for (let i = 0; i < 16; i++) {
        segment += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      segments.push(segment);
    }
    return segments.join("-");
  }

  async validateSession(token: string): Promise<User | null> {
    const session = await this.db.findSession(token);
    if (!session) {
      this.logger.debug(`Session not found: ${token.slice(0, 8)}...`);
      return null;
    }
    if (session.expiresAt < new Date()) {
      await this.db.deleteSession(token);
      this.logger.debug(`Session expired and cleaned up: ${token.slice(0, 8)}...`);
      return null;
    }
    return this.db.findUserById(session.userId);
  }

  // ----------------------------------------------------------
  // SECTION 3d: Role and permission utilities
  // ----------------------------------------------------------
  async updateRole(userId: string, newRole: User["role"]): Promise<void> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    await this.db.updateUser(userId, { role: newRole });
    this.logger.info(`Updated role for ${userId} to ${newRole}`);
  }

  hasPermission(user: User, action: string): boolean {
    const permissions: Record<User["role"], string[]> = {
      admin: ["read", "write", "delete", "manage", "audit"],
      editor: ["read", "write", "delete"],
      viewer: ["read"],
    };
    const allowed = permissions[user.role] ?? [];
    if (!allowed.includes(action)) {
      this.logger.warn(`Permission denied: ${user.id} tried '${action}' with role '${user.role}'`);
      return false;
    }
    return true;
  }
}
