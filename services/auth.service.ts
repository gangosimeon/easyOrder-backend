import bcrypt from 'bcryptjs';
import User, { UserPublic } from '@/models/user.model';
import {
  signToken, JWTPayload,
  generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
} from '@/lib/auth';
import { RegisterInput, LoginInput, UpdateProfileInput, ChangePasswordInput } from '@/validators/auth.validator';

export interface AuthSession {
  user:         UserPublic;
  token:        string;
  refreshToken: string;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function ensureUniqueSlug(base: string): Promise<string> {
  let slug = base;
  let count = 0;
  while (await User.exists({ slug })) {
    count++;
    slug = `${base}-${count}`;
  }
  return slug;
}

/** Émet un nouveau refresh token, le stocke (hashé) sur le document, sans le sauvegarder. */
function issueRefreshToken(user: { refreshTokens: { tokenHash: string; expiresAt: Date }[] }): string {
  const plain = generateRefreshToken();
  user.refreshTokens.push({ tokenHash: hashRefreshToken(plain), expiresAt: refreshTokenExpiry() });
  return plain;
}

/** Retire du document utilisateur tout ce qui ne doit jamais atteindre le client. */
function toSafeUser(user: { toObject(): Record<string, unknown> }): UserPublic {
  const { password: _pw, refreshTokens: _rt, tokenVersion: _tv, banned: _banned, ...safeUser } = user.toObject();
  return safeUser as unknown as UserPublic;
}

export async function registerUser(data: RegisterInput): Promise<AuthSession> {
  const fullPhone = data.countryCode ? data.countryCode + data.phone : undefined;

  // Check uniqueness on local phone and fullPhone
  const conflict = await User.findOne({
    $or: [
      { phone: data.phone },
      ...(fullPhone ? [{ fullPhone }] : []),
    ],
  });
  if (conflict) {
    throw Object.assign(new Error('Ce numéro est déjà utilisé'), { status: 409 });
  }

  const baseSlug = generateSlug(data.name);
  const slug     = await ensureUniqueSlug(baseSlug);

  const hashed = await bcrypt.hash(data.password, 12);

  const user = await User.create({
    ...data,
    fullPhone,
    slug,
    password: hashed,
    role: 'user',
    isActive: false,
  });

  const refreshToken = issueRefreshToken(user);
  await user.save();

  const payload: JWTPayload = {
    userId: user._id.toString(),
    phone:  user.phone,
    role:   user.role,
    slug:   user.slug,
    tokenVersion: user.tokenVersion,
  };

  const token = signToken(payload);

  return { user: toSafeUser(user), token, refreshToken };
}

export async function loginUser(data: LoginInput): Promise<AuthSession> {
  // Accept local phone OR full international number (backward compatible)
  const user = await User.findOne({
    $or: [
      { phone: data.phone },
      { fullPhone: data.phone },
    ],
  }).select('+password');
  if (!user) {
    throw Object.assign(new Error('Numéro ou mot de passe incorrect'), { status: 401 });
  }

  const valid = await bcrypt.compare(data.password, user.password);
  if (!valid) {
    throw Object.assign(new Error('Numéro ou mot de passe incorrect'), { status: 401 });
  }

  if (user.banned) {
    throw Object.assign(new Error('Ce compte a été suspendu'), { status: 403 });
  }

  const refreshToken = issueRefreshToken(user);
  await user.save();

  const payload: JWTPayload = {
    userId: user._id.toString(),
    phone:  user.phone,
    role:   user.role,
    slug:   user.slug,
    tokenVersion: user.tokenVersion,
  };

  const token = signToken(payload);

  return { user: toSafeUser(user), token, refreshToken };
}

/** Échange un refresh token valide contre une nouvelle paire access+refresh (rotation à usage unique). */
export async function refreshSession(refreshToken: string): Promise<AuthSession> {
  const tokenHash = hashRefreshToken(refreshToken);
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash });
  if (!user) {
    throw Object.assign(new Error('Session expirée, veuillez vous reconnecter'), { status: 401 });
  }

  const entry = user.refreshTokens.find(t => t.tokenHash === tokenHash);
  user.refreshTokens = user.refreshTokens.filter(t => t.tokenHash !== tokenHash);

  if (!entry || entry.expiresAt < new Date() || user.banned) {
    await user.save();
    throw Object.assign(new Error('Session expirée, veuillez vous reconnecter'), { status: 401 });
  }

  const newRefreshToken = issueRefreshToken(user);
  await user.save();

  const payload: JWTPayload = {
    userId: user._id.toString(),
    phone:  user.phone,
    role:   user.role,
    slug:   user.slug,
    tokenVersion: user.tokenVersion,
  };

  const token = signToken(payload);

  return { user: toSafeUser(user), token, refreshToken: newRefreshToken };
}

/** Révoque toutes les sessions d'un utilisateur : tous les access tokens déjà émis et tous les refresh tokens. */
async function invalidateAllSessions(userId: string): Promise<void> {
  await User.findByIdAndUpdate(userId, {
    $inc: { tokenVersion: 1 },
    $set: { refreshTokens: [] },
  });
}

export async function logoutUser(userId: string): Promise<void> {
  await invalidateAllSessions(userId);
}

export async function getUserById(userId: string) {
  const user = await User.findById(userId).select('-password -refreshTokens -tokenVersion -banned');
  if (!user) {
    throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 });
  }
  return user;
}

export async function updateUserProfile(
  userId: string,
  data: UpdateProfileInput
): Promise<UserPublic> {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: data },
    { new: true, runValidators: true }
  ).select('-password -refreshTokens -tokenVersion -banned');
  if (!user) {
    throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 });
  }
  return user.toObject() as unknown as UserPublic;
}

export async function changeUserPassword(
  userId: string,
  data: ChangePasswordInput
): Promise<{ message: string }> {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 });
  }

  // Vérifier le mot de passe actuel
  const isValid = await bcrypt.compare(data.currentPassword, user.password);
  if (!isValid) {
    throw Object.assign(new Error('Mot de passe actuel incorrect'), { status: 400 });
  }

  // Empêcher la réutilisation du même mot de passe
  const isSamePassword = await bcrypt.compare(data.newPassword, user.password);
  if (isSamePassword) {
    throw Object.assign(new Error('Le nouveau mot de passe doit être différent de l\'actuel'), { status: 400 });
  }

  // Hasher le nouveau mot de passe
  const hashedPassword = await bcrypt.hash(data.newPassword, 12);

  // Mettre à jour le mot de passe et invalider toutes les sessions existantes
  // (tokens déjà émis + refresh tokens) — un mot de passe changé doit couper
  // l'accès à quiconque détenait un token de l'ancienne session.
  await User.findByIdAndUpdate(userId, {
    $set: { password: hashedPassword, refreshTokens: [] },
    $inc: { tokenVersion: 1 },
  });

  return { message: 'Mot de passe modifié avec succès' };
}
