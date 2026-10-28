import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/db';
import { verifyResetToken } from '@/lib/auth';
import { resetPasswordSchema } from '@/validators/user.validator';
import User from '@/models/user.model';

const INVALID_LINK = { success: false, message: 'Lien de réinitialisation invalide ou expiré' };

export async function POST(req: Request) {
  try {
    await connectDB();

    const parsed = resetPasswordSchema.safeParse(await req.json());
    if (!parsed.success) {
      const errors = parsed.error.flatten().fieldErrors;
      const message = errors.newPassword?.[0] ?? 'Token et nouveau mot de passe requis';
      return NextResponse.json({ success: false, message, details: errors }, { status: 400 });
    }
    const { token, newPassword } = parsed.data;

    // Vérifier le reset token (15 min)
    let payload: { userId: string; tokenVersion: number };
    try {
      payload = verifyResetToken(token);
    } catch {
      return NextResponse.json(INVALID_LINK, { status: 400 });
    }

    // Le filtre sur tokenVersion rend le token à usage unique : la mise à jour
    // incrémente la version, donc une seconde utilisation ne trouve plus rien.
    // Elle invalide aussi toutes les sessions existantes.
    const hashed = await bcrypt.hash(newPassword, 12);
    const updated = await User.findOneAndUpdate(
      { _id: payload.userId, tokenVersion: payload.tokenVersion },
      { $set: { password: hashed, refreshTokens: [] }, $inc: { tokenVersion: 1 } }
    );
    if (!updated) {
      return NextResponse.json(INVALID_LINK, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Mot de passe réinitialisé avec succès',
    });
  } catch (err) {
    console.error('[POST /api/auth/reset-password]', err);
    return NextResponse.json({ success: false, message: 'Erreur serveur' }, { status: 500 });
  }
}
