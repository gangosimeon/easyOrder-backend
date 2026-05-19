import jwt from 'jsonwebtoken';

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('La variable JWT_SECRET est absente dans .env.local');
  return s;
}

function getExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '7d';
}

export interface JWTPayload {
  userId: string;
  phone: string;
  role: 'admin' | 'user';
  slug: string;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: getExpiresIn() } as jwt.SignOptions);
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

export function getAuthUser(req: Request): JWTPayload | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

export function requireAuthUser(req: Request): JWTPayload {
  const user = getAuthUser(req);
  if (!user) throw new Error('Non authentifié');
  return user;
}

export function requireAdmin(req: Request): JWTPayload {
  const user = requireAuthUser(req);
  if (user.role !== 'admin') throw new Error('Accès réservé aux administrateurs');
  return user;
}
