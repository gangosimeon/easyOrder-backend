import { describe, expect, it, vi } from 'vitest';
import { sendOtpEmail } from '@/lib/mailer';
import { GET as me } from '@/app/api/auth/me/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as changePassword } from '@/app/api/auth/change-password/route';
import { POST as requestRecoveryEmail } from '@/app/api/user/recovery-email/route';
import { POST as verifyRecoveryEmail } from '@/app/api/user/verify-recovery-email/route';
import { POST as forgotPassword } from '@/app/api/auth/forgot-password/route';
import { POST as verifyOtp } from '@/app/api/auth/verify-otp/route';
import { POST as resetPassword } from '@/app/api/auth/reset-password/route';
import { createShop, jsonRequest, TestShop } from './helpers';

/** Dernier code envoyé par email (le mailer est simulé). */
function lastOtp(): string {
  const calls = vi.mocked(sendOtpEmail).mock.calls;
  return calls[calls.length - 1][1] as string;
}

async function withVerifiedEmail(shop: TestShop, email = 'awa@example.com') {
  await requestRecoveryEmail(jsonRequest('/api/user/recovery-email', { email, currentPassword: shop.password }, { token: shop.token }));
  const res = await verifyRecoveryEmail(jsonRequest('/api/user/verify-recovery-email', { email, otp: lastOtp() }, { token: shop.token }));
  expect(res.status).toBe(200);
}

describe('email de récupération', () => {
  it('exige le mot de passe actuel', async () => {
    const shop = await createShop('Awa', '70000020');
    const res = await requestRecoveryEmail(jsonRequest('/api/user/recovery-email',
      { email: 'pirate@example.com', currentPassword: 'mauvais' }, { token: shop.token }));
    expect(res.status).toBe(400);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('refuse un token révoqué par la déconnexion', async () => {
    const shop = await createShop('Awa', '70000021');
    await logout(jsonRequest('/api/auth/logout', {}, { token: shop.token }));
    const res = await requestRecoveryEmail(jsonRequest('/api/user/recovery-email',
      { email: 'pirate@example.com', currentPassword: shop.password }, { token: shop.token }));
    expect(res.status).toBe(401);
    const pwd = await changePassword(jsonRequest('/api/auth/change-password',
      { currentPassword: shop.password, newPassword: 'autrechose' }, { token: shop.token }));
    expect(pwd.status).toBe(401);
  });

  it("ne remplace l'email vérifié qu'après validation du nouveau code", async () => {
    const shop = await createShop('Awa', '70000022');
    await withVerifiedEmail(shop, 'awa@example.com');
    await requestRecoveryEmail(jsonRequest('/api/user/recovery-email',
      { email: 'nouveau@example.com', currentPassword: shop.password }, { token: shop.token }));

    const profile = (await (await me(jsonRequest('/api/auth/me', undefined, { token: shop.token }))).json()).data;
    expect(profile.recoveryEmail).toBe('awa@example.com');
    expect(profile.recoveryEmailVerified).toBe(true);
    expect(profile.pendingRecoveryEmail).toBe('nouveau@example.com');
  });

  it('ne renvoie jamais les codes OTP au client', async () => {
    const shop = await createShop('Awa', '70000023');
    await requestRecoveryEmail(jsonRequest('/api/user/recovery-email',
      { email: 'awa@example.com', currentPassword: shop.password }, { token: shop.token }));
    await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'awa@example.com' }));

    const profile = (await (await me(jsonRequest('/api/auth/me', undefined, { token: shop.token }))).json()).data;
    const logged = (await (await login(jsonRequest('/api/auth/login', { phone: '70000023', password: shop.password }))).json()).data.user;
    for (const user of [profile, logged]) {
      expect(user).not.toHaveProperty('recoveryOtp');
      expect(user).not.toHaveProperty('resetOtp');
    }
  });
});

describe('mot de passe oublié', () => {
  it("n'envoie rien vers un email non vérifié, avec la même réponse", async () => {
    const shop = await createShop('Awa', '70000030');
    await requestRecoveryEmail(jsonRequest('/api/user/recovery-email',
      { email: 'nonverifie@example.com', currentPassword: shop.password }, { token: shop.token }));
    vi.mocked(sendOtpEmail).mockClear();

    const unverified = await (await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'nonverifie@example.com' }))).json();
    const unknown    = await (await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'inconnu@example.com' }))).json();
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(unverified.message).toBe(unknown.message);
  });

  it('parcours complet, puis lien de réinitialisation à usage unique', async () => {
    const shop = await createShop('Awa', '70000031');
    await withVerifiedEmail(shop);

    await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'awa@example.com' }));
    const verify = await (await verifyOtp(jsonRequest('/api/auth/verify-otp', { email: 'awa@example.com', otp: lastOtp() }))).json();
    expect(verify.success).toBe(true);

    const first = await resetPassword(jsonRequest('/api/auth/reset-password', { token: verify.token, newPassword: 'nouveaumdp' }));
    expect(first.status).toBe(200);
    const second = await resetPassword(jsonRequest('/api/auth/reset-password', { token: verify.token, newPassword: 'encoreautre' }));
    expect(second.status).toBe(400);

    const relog = await login(jsonRequest('/api/auth/login', { phone: '70000031', password: 'nouveaumdp' }));
    expect(relog.status).toBe(200);
    // L'ancienne session est coupée.
    expect((await me(jsonRequest('/api/auth/me', undefined, { token: shop.token }))).status).toBe(401);
  });

  it('grille le code après 5 essais erronés', async () => {
    const shop = await createShop('Awa', '70000032');
    await withVerifiedEmail(shop);
    await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'awa@example.com' }));
    const good = lastOtp();
    const wrong = good === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      await verifyOtp(jsonRequest('/api/auth/verify-otp', { email: 'awa@example.com', otp: wrong }));
    }
    const res = await verifyOtp(jsonRequest('/api/auth/verify-otp', { email: 'awa@example.com', otp: good }));
    expect(res.status).toBe(400);
  });

  it('refuse un mot de passe trop court', async () => {
    const shop = await createShop('Awa', '70000033');
    await withVerifiedEmail(shop);
    await forgotPassword(jsonRequest('/api/auth/forgot-password', { email: 'awa@example.com' }));
    const { token } = await (await verifyOtp(jsonRequest('/api/auth/verify-otp', { email: 'awa@example.com', otp: lastOtp() }))).json();
    const res = await resetPassword(jsonRequest('/api/auth/reset-password', { token, newPassword: 'a' }));
    expect(res.status).toBe(400);
  });
});
