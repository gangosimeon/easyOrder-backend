import * as nodemailer from 'nodemailer';

// ── Configuration Gmail SMTP ─────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  family: 4,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
} as any);

// ── Types d'OTP supportés ───────────────────────────────────────────────────────────
type OtpType = 'forgot-password' | 'recovery-email' | 'login-otp';

// ── Configuration des messages par type ─────────────────────────────────────────────
const otpMessages: Record<OtpType, { subject: string; title: string; message: string }> = {
  'forgot-password': {
    subject: 'Code de récupération de mot de passe',
    title: 'Réinitialisation de votre mot de passe',
    message: 'Vous avez demandé une réinitialisation de votre mot de passe. Utilisez le code ci-dessous pour procéder.',
  },
  'recovery-email': {
    subject: 'Code de vérification - Email de récupération',
    title: 'Vérification de votre email de récupération',
    message: 'Vous avez ajouté un email de récupération à votre compte. Utilisez le code ci-dessous pour le vérifier.',
  },
  'login-otp': {
    subject: 'Code de connexion sécurisée',
    title: 'Connexion sécurisée',
    message: 'Utilisez le code ci-dessous pour vous connecter à votre compte.',
  },
};

// ── Template HTML email ───────────────────────────────────────────────────────────
function getEmailTemplate(otp: string, type: OtpType): string {
  const config = otpMessages[type];

  return `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${config.subject}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: #f4f4f4;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .email-card {
            background: #ffffff;
            border-radius: 12px;
            padding: 40px 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .logo {
            text-align: center;
            margin-bottom: 30px;
            font-size: 24px;
            font-weight: bold;
            color: #e8521a;
          }
          .title {
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            color: #1a1a1a;
            margin-bottom: 16px;
          }
          .message {
            text-align: center;
            color: #666;
            margin-bottom: 30px;
            font-size: 16px;
          }
          .otp-container {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
          }
          .otp-code {
            font-size: 48px;
            font-weight: bold;
            color: #ffffff;
            letter-spacing: 8px;
            margin: 0;
          }
          .otp-label {
            color: rgba(255, 255, 255, 0.9);
            font-size: 14px;
            margin-bottom: 10px;
          }
          .security {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
            font-size: 14px;
            color: #856404;
          }
          .security-icon {
            margin-right: 8px;
          }
          .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #999;
          }
          .warning {
            color: #dc3545;
            font-weight: bold;
          }
          @media only screen and (max-width: 600px) {
            .email-card { padding: 30px 20px; }
            .title { font-size: 20px; }
            .otp-code { font-size: 36px; letter-spacing: 4px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="email-card">
            <div class="logo">🏪 JeCreeMaBoutique</div>
            <h1 class="title">${config.title}</h1>
            <p class="message">${config.message}</p>
            
            <div class="otp-container">
              <div class="otp-label">Votre code de vérification</div>
              <p class="otp-code">${otp}</p>
            </div>

            <div class="security">
              <span class="security-icon">🔒</span>
              <strong>Information importante :</strong>
              <br>
              Ce code expire dans 5 minutes. Ne le partagez avec personne.
              Notre équipe ne vous demandera jamais votre code par téléphone ou email.
            </div>

            <div class="footer">
              <p>Si vous n'avez pas demandé ce code, ignorez cet email.</p>
              <p class="warning">Ne partagez jamais ce code avec qui que ce soit.</p>
              <p style="margin-top: 15px;">Envoyé le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

// ── Fonction principale d'envoi d'OTP ─────────────────────────────────────────────
export async function sendOtpEmail(to: string, otp: string, type: OtpType): Promise<{ success: boolean; error?: string }> {
  try {
    const config = otpMessages[type];
    const html = getEmailTemplate(otp, type);

    const mailOptions = {
      from: `"JeCreeMaBoutique" <${process.env.GMAIL_USER}>`,
      to,
      subject: config.subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);

    console.log(`[EMAIL SENT] Type: ${type} | To: ${to} | MessageId: ${info.messageId} | Timestamp: ${new Date().toISOString()}`);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue lors de l\'envoi de l\'email';
    console.error(`[EMAIL ERROR] Type: ${type} | To: ${to} | Error: ${errorMessage} | Timestamp: ${new Date().toISOString()}`);
    
    // Ne pas exposer l'erreur technique
    return { success: false, error: 'Impossible d\'envoyer l\'email. Veuillez réessayer.' };
  }
}

// ── Vérification de la configuration SMTP ─────────────────────────────────────────
export function isMailerConfigured(): boolean {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}
