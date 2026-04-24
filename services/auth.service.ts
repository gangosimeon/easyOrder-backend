import bcrypt from 'bcryptjs';
import User, { UserPublic } from '@/models/user.model';
import { signToken, JWTPayload } from '@/lib/auth';
import { RegisterInput, LoginInput, UpdateProfileInput } from '@/validators/auth.validator';

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

export async function registerUser(
  data: RegisterInput
): Promise<{ user: UserPublic; token: string }> {
  const existingPhone = await User.findOne({ phone: data.phone });
  if (existingPhone) {
    throw Object.assign(new Error('Ce numéro est déjà utilisé'), { status: 409 });
  }

  const baseSlug = generateSlug(data.name);
  const slug     = await ensureUniqueSlug(baseSlug);

  const hashed = await bcrypt.hash(data.password, 12);

  const user = await User.create({
    ...data,
    slug,
    password: hashed,
    role: 'user',
  });

  const payload: JWTPayload = {
    userId: user._id.toString(),
    phone:  user.phone,
    role:   user.role,
    slug:   user.slug,
  };

  const token = signToken(payload);

  const { password: _pw, ...safeUser } = user.toObject();
  return { user: safeUser as unknown as UserPublic, token };
}

export async function loginUser(
  data: LoginInput
): Promise<{ user: UserPublic; token: string }> {
  const user = await User.findOne({ phone: data.phone });
  if (!user) {
    throw Object.assign(new Error('Numéro ou mot de passe incorrect'), { status: 401 });
  }

  const valid = await bcrypt.compare(data.password, user.password);
  if (!valid) {
    throw Object.assign(new Error('Numéro ou mot de passe incorrect'), { status: 401 });
  }

  const payload: JWTPayload = {
    userId: user._id.toString(),
    phone:  user.phone,
    role:   user.role,
    slug:   user.slug,
  };

  const token = signToken(payload);

  const { password: _pw, ...safeUser } = user.toObject();
  return { user: safeUser as unknown as UserPublic, token };
}

export async function getUserById(userId: string) {
  const user = await User.findById(userId).select('-password');
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
  ).select('-password');
  if (!user) {
    throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 });
  }
  return user.toObject() as unknown as UserPublic;
}
