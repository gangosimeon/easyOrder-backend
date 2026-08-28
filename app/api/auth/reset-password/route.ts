import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/db';
import { verifyResetToken } from '@/lib/auth';
import User from '@/models/user.model';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return NextResponse.json({ success: false, message: 'Token et nouveau mot de passe requis' }, { status: 400 });
    }

    // Vérifier le reset token (15 min)
    let payload: { userId: string };
    try {
      payload = verifyResetToken(token);
    } catch {
      return NextResponse.json({ success: false, message: 'Lien de réinitialisation invalide ou expiré' }, { status: 400 });
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      return NextResponse.json({ success: false, message: 'Utilisateur introuvable' }, { status: 404 });
    }

    // Hasher, sauvegarder et invalider toutes les sessions existantes — un
    // mot de passe réinitialisé doit couper l'accès à tout token déjà émis.
    const hashed = await bcrypt.hash(newPassword, 12);
    user.password = hashed;
    user.refreshTokens = [];
    user.tokenVersion += 1;
    await user.save();

    return NextResponse.json({
      success: true,
      message: 'Mot de passe réinitialisé avec succès',
    });
  } catch (err) {
    console.error('[POST /api/auth/reset-password]', err);
    return NextResponse.json({ success: false, message: 'Erreur serveur' }, { status: 500 });
  }
}
