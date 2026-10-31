import { z } from 'zod';

/**
 * Corps des routes de la liaison GestStock (lot 2, J4). Formats bornés : un `code` ou un `state` hors format est
 * refusé avant toute consommation de la demande et tout appel à GestStock.
 */

/** Retour de l'écran d'autorisation : `code`, `state` et `iss` lus par la page Angular de retour. */
export const completeGeststockLinkSchema = z.object({
  code:  z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/, 'code invalide'),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/, 'state invalide'),
  iss:   z.string().min(1).max(200),
}).strict();

/**
 * Motif de révocation accepté par GestStock (`POST /link/revoke`, `LinkController.LinkRevocationRequest`) : champ
 * `reason` facultatif, texte libre de 500 caractères au plus, inscrit dans `platform.integration_audit_log.reason`
 * (varchar(500)). PostgreSQL y refuse le caractère NUL (GestStock répondrait 500) : les caractères de contrôle sont
 * refusés ici, sauf tabulation et sauts de ligne.
 */
export const GESTSTOCK_REVOCATION_REASON_MAX = 500;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Révocation par la boutique : motif facultatif, transmis tel quel à GestStock (journal d'audit). */
export const revokeGeststockLinkSchema = z.object({
  reason: z.string().trim().min(1).max(GESTSTOCK_REVOCATION_REASON_MAX)
    .refine((reason) => !CONTROL_CHARACTERS.test(reason), 'caractère de contrôle refusé')
    .optional(),
}).strict();

export type CompleteGeststockLinkInput = z.infer<typeof completeGeststockLinkSchema>;
