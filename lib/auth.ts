import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { connectDB } from '@/lib/db';
import User from '@/models/user.model';

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('La variable JWT_SECRET est absente dans .env.local');
  return s;
}

function getAccessExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '30m';
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

export interface JWTPayload {
  userId: string;
  phone: string;
  role: 'admin' | 'user';
  slug: string;
  tokenVersion: number;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: getAccessExpiresIn() } as jwt.SignOptions);
}

export function signResetToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'reset-password' }, getSecret(), { expiresIn: '15m' } as jwt.SignOptions);
}

export function verifyResetToken(token: string): { userId: string; purpose: string } {
  const payload = jwt.verify(token, getSecret()) as { userId: string; purpose: string };
  if (payload.purpose !== 'reset-password') throw new Error('Token invalide');
  return payload;
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, getSecret()) as JWTPayload;
}

// ── Refresh tokens ─────────────────────────────────────────────────────────
// Opaques (pas des JWT), stockés hashés (SHA-256) en base sur le document
// User, à rotation unique : chaque utilisation invalide l'ancien et en émet
// un nouveau. `tokenVersion` permet en plus de révoquer instantanément tous
// les access tokens déjà émis (déconnexion, changement de mot de passe).

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
}

// ── Vérification des requêtes authentifiées ───────────────────────────────
// Le JWT seul ne peut pas refléter une révocation décidée après son émission
// (bannissement, déconnexion, changement de mot de passe) : on recharge donc
// l'utilisateur en base à chaque requête pour appliquer ces révocations
// immédiatement, plutôt que d'attendre l'expiration naturelle du token.

export async function getAuthUser(req: Request): Promise<JWTPayload | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];

  let payload: JWTPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }

  await connectDB();
  const user = await User.findById(payload.userId).select('banned tokenVersion').lean();
  if (!user || user.banned || user.tokenVersion !== payload.tokenVersion) return null;

  return payload;
}

export async function requireAuthUser(req: Request): Promise<JWTPayload> {
  const user = await getAuthUser(req);
  if (!user) throw new Error('Non authentifié');
  return user;
}

export async function requireAdmin(req: Request): Promise<JWTPayload> {
  const user = await requireAuthUser(req);
  if (user.role !== 'admin') throw new Error('Accès réservé aux administrateurs');
  return user;
}
