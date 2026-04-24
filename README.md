<<<<<<< HEAD
# Backend Gestion Boutique

Backend Next.js (App Router) généré à partir du projet Angular `gestion-boutique`.

---

## Stack

- **Next.js 14** (App Router, API Routes)
- **MongoDB** + **Mongoose**
- **JWT** (`jsonwebtoken`) — authentification stateless
- **bcryptjs** — hachage des mots de passe
- **Zod** — validation des données entrantes

---

## Démarrage rapide

### 1. Installer les dépendances

```bash
npm install
```

### 2. Configurer les variables d'environnement

```bash
cp .env.example .env.local
```

Éditer `.env.local` :

```env
MONGODB_URI=mongodb://localhost:27017/burkina-shop
JWT_SECRET=remplacer_par_un_secret_fort_64_caracteres
JWT_EXPIRES_IN=7d
```

### 3. Lancer le seed (données de démo)

```bash
npm run seed
```

Crée un compte démo :
- **Téléphone** : `22677938688`
- **Mot de passe** : `password123`
- **Slug boutique** : `kabore-et-fils`

### 4. Lancer le serveur

```bash
npm run dev
# → http://localhost:4000
```

---

## Structure du projet

```
backend-gestion-boutique/
├── app/
│   └── api/
│       ├── auth/
│       │   ├── register/route.ts   POST /api/auth/register
│       │   ├── login/route.ts      POST /api/auth/login
│       │   └── me/route.ts         GET  /api/auth/me
│       ├── public/
│       │   └── shop/[slug]/route.ts GET /api/public/shop/:slug
│       ├── categories/
│       │   ├── route.ts            GET/POST
│       │   └── [id]/route.ts       GET/PUT/DELETE
│       ├── products/
│       │   ├── route.ts            GET/POST
│       │   └── [id]/route.ts       GET/PUT/DELETE
│       ├── annonces/
│       │   ├── route.ts            GET/POST
│       │   └── [id]/
│       │       ├── route.ts            GET/PUT/DELETE
│       │       ├── toggle-active/      PATCH
│       │       └── toggle-epinglee/    PATCH
│       └── orders/
│           └── route.ts            GET (auth) / POST (public)
├── lib/
│   ├── db.ts          Connexion MongoDB (singleton)
│   ├── auth.ts        JWT sign/verify + helpers
│   └── api-response.ts Helpers de réponse HTTP
├── models/
│   ├── user.model.ts
│   ├── category.model.ts
│   ├── product.model.ts
│   ├── annonce.model.ts
│   └── order.model.ts
├── services/          Logique métier
├── validators/        Schémas Zod
├── scripts/seed.ts    Données de démo
└── middleware.ts      Vérification JWT globale
```

---

## API Reference

### Authentification

| Méthode | Route | Corps | Auth |
|---------|-------|-------|------|
| POST | `/api/auth/register` | `{name, phone, password, description?, logo?, address?, coverColor?}` | ❌ |
| POST | `/api/auth/login` | `{phone, password}` | ❌ |
| GET  | `/api/auth/me` | — | ✅ |

### Boutique publique

| Méthode | Route | Auth |
|---------|-------|------|
| GET | `/api/public/shop/:slug` | ❌ |

Retourne : `{ company, categories, products, announcements }`

### Catégories (authentifié)

| Méthode | Route |
|---------|-------|
| GET    | `/api/categories` |
| POST   | `/api/categories` |
| GET    | `/api/categories/:id` |
| PUT    | `/api/categories/:id` |
| DELETE | `/api/categories/:id` *(supprime aussi les produits liés)* |

### Produits (authentifié)

| Méthode | Route | Query |
|---------|-------|-------|
| GET    | `/api/products` | `?categoryId=xxx` |
| POST   | `/api/products` | — |
| GET    | `/api/products/:id` | — |
| PUT    | `/api/products/:id` | — |
| DELETE | `/api/products/:id` | — |

### Annonces (authentifié)

| Méthode | Route |
|---------|-------|
| GET    | `/api/annonces` |
| POST   | `/api/annonces` |
| GET    | `/api/annonces/:id` |
| PUT    | `/api/annonces/:id` |
| DELETE | `/api/annonces/:id` |
| PATCH  | `/api/annonces/:id/toggle-active` |
| PATCH  | `/api/annonces/:id/toggle-epinglee` |

### Commandes

| Méthode | Route | Auth | Notes |
|---------|-------|------|-------|
| GET | `/api/orders` | ✅ | Commandes de la boutique |
| POST | `/api/orders?shopSlug=xxx` | ❌ | Créée depuis la vitrine publique |

---

## Connecter Angular au backend

### 1. Désactiver le mock interceptor

Dans `@/core/interceptors/shop-mock.interceptor.ts` :

```typescript
export const USE_SHOP_MOCK = false; // ← changer à false
```

### 2. Configurer l'URL de base

Dans `environment.ts` (ou directement dans les services) :

```typescript
export const environment = {
  apiUrl: 'http://localhost:4000'
};
```

### 3. Adapter le PublicShopService

```typescript
getShop(slug: string): Observable<ShopData> {
  return this.http.get<ShopData>(`${environment.apiUrl}/api/public/shop/${slug}`);
}
```

### 4. Ajouter l'interceptor JWT pour les routes privées

```typescript
// core/interceptors/auth.interceptor.ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = sessionStorage.getItem('bs_token');
  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next(req);
};
```

### 5. Stocker le token au login

```typescript
// Dans AuthService.login()
const { user, token } = await firstValueFrom(
  this.http.post<{data: {user: Company, token: string}}>(
    `${environment.apiUrl}/api/auth/login`,
    { phone, password }
  )
);
sessionStorage.setItem('bs_token', token);
```

---

## Format de réponse uniforme

Toutes les réponses suivent ce format :

```json
// Succès
{ "success": true, "data": { ... } }

// Erreur
{ "success": false, "message": "Description", "details": { ... } }
```

---

## Modèles de données

### User (boutique)
`name` · `slug` · `phone` · `password` · `description` · `logo` · `address` · `coverColor` · `role`

### Category
`shopId` · `name` · `icon` · `color` · `description`

### Product
`shopId` · `categoryId` · `name` · `price` · `originalPrice?` · `promotion?` · `image` · `unit` · `stock` · `inStock`

### Annonce
`shopId` · `titre` · `message` · `type` (promo/info/alerte/evenement) · `emoji` · `dateDebut` · `dateFin?` · `active` · `epinglee`

### Order
`shopId` · `customerName` · `customerPhone` · `items[]` · `total` · `status` · `whatsappSent` · `note?`
=======
# easyOrder-backend
>>>>>>> dfda50bfe2976c8d0be62e6b2f77ea038be6aa48
