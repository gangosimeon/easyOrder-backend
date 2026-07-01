/**
 * country-utils.ts — Table de correspondance indicatifs ↔ ISO ↔ noms de pays.
 *
 * `countryCode` en base MongoDB = indicatif téléphonique (ex: "226").
 * Ce fichier est la source unique de vérité — aucune donnée ISO n'est jamais
 * stockée en base.
 */

interface CountryEntry {
  dialCode: string;
  name: string;
}

/** Code ISO 3166-1 alpha-2 → { indicatif, nom français } */
const ISO_MAP: Readonly<Record<string, CountryEntry>> = {
  // ── Afrique de l'Ouest ──────────────────────────────────────────────────────
  BF: { dialCode: '226', name: 'Burkina Faso'          },
  CI: { dialCode: '225', name: "Côte d'Ivoire"          },
  SN: { dialCode: '221', name: 'Sénégal'                },
  ML: { dialCode: '223', name: 'Mali'                   },
  GH: { dialCode: '233', name: 'Ghana'                  },
  TG: { dialCode: '228', name: 'Togo'                   },
  BJ: { dialCode: '229', name: 'Bénin'                  },
  NE: { dialCode: '227', name: 'Niger'                  },
  MR: { dialCode: '222', name: 'Mauritanie'             },
  GN: { dialCode: '224', name: 'Guinée'                 },
  GM: { dialCode: '220', name: 'Gambie'                 },
  GW: { dialCode: '245', name: 'Guinée-Bissau'          },
  SL: { dialCode: '232', name: 'Sierra Leone'           },
  LR: { dialCode: '231', name: 'Libéria'                },
  CV: { dialCode: '238', name: 'Cap-Vert'               },
  // ── Afrique centrale ────────────────────────────────────────────────────────
  NG: { dialCode: '234', name: 'Nigéria'                },
  CM: { dialCode: '237', name: 'Cameroun'               },
  GA: { dialCode: '241', name: 'Gabon'                  },
  CG: { dialCode: '242', name: 'Congo'                  },
  CD: { dialCode: '243', name: 'R. D. Congo'            },
  CF: { dialCode: '236', name: 'Centrafrique'           },
  TD: { dialCode: '235', name: 'Tchad'                  },
  GQ: { dialCode: '240', name: 'Guinée équatoriale'     },
  ST: { dialCode: '239', name: 'São Tomé-et-Príncipe'   },
  // ── Afrique de l'Est ────────────────────────────────────────────────────────
  ET: { dialCode: '251', name: 'Éthiopie'               },
  KE: { dialCode: '254', name: 'Kenya'                  },
  UG: { dialCode: '256', name: 'Ouganda'                },
  TZ: { dialCode: '255', name: 'Tanzanie'               },
  RW: { dialCode: '250', name: 'Rwanda'                 },
  BI: { dialCode: '257', name: 'Burundi'                },
  SO: { dialCode: '252', name: 'Somalie'                },
  DJ: { dialCode: '253', name: 'Djibouti'               },
  ER: { dialCode: '291', name: 'Érythrée'               },
  MG: { dialCode: '261', name: 'Madagascar'             },
  MZ: { dialCode: '258', name: 'Mozambique'             },
  MU: { dialCode: '230', name: 'Maurice'                },
  SC: { dialCode: '248', name: 'Seychelles'             },
  KM: { dialCode: '269', name: 'Comores'                },
  // ── Afrique australe ────────────────────────────────────────────────────────
  ZA: { dialCode: '27',  name: 'Afrique du Sud'         },
  ZW: { dialCode: '263', name: 'Zimbabwe'               },
  ZM: { dialCode: '260', name: 'Zambie'                 },
  MW: { dialCode: '265', name: 'Malawi'                 },
  BW: { dialCode: '267', name: 'Botswana'               },
  NA: { dialCode: '264', name: 'Namibie'                },
  LS: { dialCode: '266', name: 'Lesotho'                },
  SZ: { dialCode: '268', name: 'Eswatini'               },
  AO: { dialCode: '244', name: 'Angola'                 },
  // ── Afrique du Nord ─────────────────────────────────────────────────────────
  MA: { dialCode: '212', name: 'Maroc'                  },
  DZ: { dialCode: '213', name: 'Algérie'                },
  TN: { dialCode: '216', name: 'Tunisie'                },
  LY: { dialCode: '218', name: 'Libye'                  },
  EG: { dialCode: '20',  name: 'Égypte'                 },
  SD: { dialCode: '249', name: 'Soudan'                 },
  SS: { dialCode: '211', name: 'Soudan du Sud'          },
  // ── Reste du monde ──────────────────────────────────────────────────────────
  FR: { dialCode: '33',  name: 'France'                 },
  BE: { dialCode: '32',  name: 'Belgique'               },
  CH: { dialCode: '41',  name: 'Suisse'                 },
  CA: { dialCode: '1',   name: 'Canada'                 },
  US: { dialCode: '1',   name: 'États-Unis'             },
};

/** Indicatif → nom du pays (map inverse, construite une seule fois). */
const DIAL_TO_NAME: Record<string, string> = {};
for (const { dialCode, name } of Object.values(ISO_MAP)) {
  if (!DIAL_TO_NAME[dialCode]) DIAL_TO_NAME[dialCode] = name;
}

/** ISO 3166-1 alpha-2 → indicatif téléphonique. Ex: "BF" → "226". */
export function isoToDialCode(iso: string): string | null {
  return ISO_MAP[iso.toUpperCase()]?.dialCode ?? null;
}

/** Indicatif → nom du pays en français. Ex: "226" → "Burkina Faso". */
export function dialCodeToName(dialCode: string): string | null {
  return DIAL_TO_NAME[dialCode] ?? null;
}

/** Liste complète triée par nom (pour le sélecteur de pays frontend). */
export function getAllCountries(): { iso: string; dialCode: string; name: string }[] {
  return Object.entries(ISO_MAP)
    .map(([iso, { dialCode, name }]) => ({ iso, dialCode, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
