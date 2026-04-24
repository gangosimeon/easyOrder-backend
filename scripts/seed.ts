import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const MONGODB_URI = process.env.MONGODB_URI as string;
if (!MONGODB_URI) throw new Error('MONGODB_URI manquant dans .env.local');

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connecté à MongoDB');

  const User      = (await import('../models/user.model')).default;
  const Category  = (await import('../models/category.model')).default;
  const Product   = (await import('../models/product.model')).default;
  const Annonce   = (await import('../models/annonce.model')).default;

  await Promise.all([
    User.deleteMany({}),
    Category.deleteMany({}),
    Product.deleteMany({}),
    Annonce.deleteMany({}),
  ]);
  console.log('🧹 Collections vidées');

  const hashed = await bcrypt.hash('password123', 12);
  const user = await User.create({
    name:        'Boutique Kaboré & Fils',
    slug:        'kabore-et-fils',
    phone:       '22677938688',
    password:    hashed,
    description: 'Votre boutique de confiance à Ouagadougou',
    logo:        '🏪',
    address:     'Secteur 15, Ouagadougou',
    coverColor:  '#a04343',
    role:        'user',
  });
  console.log(`👤 Utilisateur créé : ${user.slug}`);

  const shopId = user._id.toString();

  const cats = await Category.insertMany([
    { shopId, name: 'Alimentation', icon: 'lunch_dining', color: '#FF6B35', description: 'Nourriture et épicerie' },
    { shopId, name: 'Boissons',     icon: 'local_drink',  color: '#1E88E5', description: 'Eau, jus, sodas' },
    { shopId, name: 'Vêtements',   icon: 'checkroom',    color: '#8E24AA', description: 'Habits et tissus' },
    { shopId, name: 'Électronique', icon: 'devices',      color: '#00ACC1', description: 'Téléphones et appareils' },
    { shopId, name: 'Agriculture',  icon: 'grass',        color: '#43A047', description: 'Semences et engrais' },
    { shopId, name: 'Beauté',       icon: 'face',         color: '#E91E63', description: 'Cosmétiques et soins' },
  ]);
  console.log(`📂 ${cats.length} catégories créées`);

  const [alim, boisson, vêt, elec, agri, beauté] = cats;

  const products = await Product.insertMany([
    { shopId, categoryId: alim._id,    name: 'Riz local 5kg',      price: 3500, originalPrice: 4200, promotion: 17, image: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600', unit: 'sachet',   stock: 50,  inStock: true },
    { shopId, categoryId: alim._id,    name: 'Huile de palme 1L',  price: 1200, image: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTwRpQAQaBK5UW_3LTnKO1xa9tARmwZVoFcmA&s', unit: 'litre',    stock: 30,  inStock: true },
    { shopId, categoryId: alim._id,    name: 'Farine de maïs 2kg', price: 1800, originalPrice: 2200, promotion: 18, image: 'https://images.unsplash.com/photo-1608198093002-ad4e005484ec?w=600', unit: 'sachet',   stock: 25,  inStock: true },
    { shopId, categoryId: boisson._id, name: 'Eau minérale 1.5L',  price: 500,  image: 'https://images.unsplash.com/photo-1564419320461-6870880221ad?w=600', unit: 'bouteille', stock: 100, inStock: true },
    { shopId, categoryId: boisson._id, name: 'Jus de bissap',      price: 350,  image: 'https://images.unsplash.com/photo-1622597467836-f3285f2131b8?w=600', unit: 'bouteille', stock: 45,  inStock: true },
    { shopId, categoryId: vêt._id,     name: 'Tissu wax 6 yards',  price: 8500, originalPrice: 10000, promotion: 15, image: 'https://images.unsplash.com/photo-1593032465175-481ac7f401a0?w=600', unit: 'pièce', stock: 15, inStock: true },
    { shopId, categoryId: elec._id,    name: 'Téléphone basique',  price: 25000, image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600', unit: 'pièce',   stock: 8,   inStock: true },
    { shopId, categoryId: agri._id,    name: 'Semences de sorgho', price: 2500,  image: 'https://images.unsplash.com/photo-1592928302636-c83cf1e1d7f3?w=600', unit: 'kg',      stock: 60,  inStock: true },
    { shopId, categoryId: beauté._id,  name: 'Savon de karité',    price: 500,  originalPrice: 700, promotion: 29, image: 'https://images.unsplash.com/photo-1600857544200-b2f666a9a2ec?w=600', unit: 'pièce', stock: 40, inStock: true },
    { shopId, categoryId: alim._id,    name: 'Gombo sec',          price: 500,  originalPrice: 700, promotion: 29, image: 'https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?w=600', unit: 'pièce', stock: 40, inStock: false },
  ]);
  console.log(`📦 ${products.length} produits créés`);

  const now      = new Date();
  const nextWeek = new Date(); nextWeek.setDate(now.getDate() + 7);
  const tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1);

  const annonces = await Annonce.insertMany([
    { shopId, titre: 'Grande Promotion du Vendredi !', message: 'Jusqu\'à -30% sur tous les produits alimentaires ce vendredi.', type: 'promo',     emoji: '🔥', dateDebut: now, dateFin: nextWeek, active: true, epinglee: true },
    { shopId, titre: 'Nouveaux arrivages de tissus wax', message: 'Nouveaux modèles disponibles ! Venez découvrir notre nouvelle collection.', type: 'info', emoji: '🎉', dateDebut: now, active: true, epinglee: false },
    { shopId, titre: 'Fermeture exceptionnelle demain', message: 'La boutique sera fermée demain pour fête nationale.', type: 'alerte',    emoji: '⚠️', dateDebut: now, dateFin: tomorrow, active: true, epinglee: true },
    { shopId, titre: 'Foire Agricole de Ouagadougou', message: 'Participez à la Foire Agricole ! Stand B12 avec nos meilleures semences.', type: 'evenement', emoji: '🌾', dateDebut: nextWeek, active: true, epinglee: false },
  ]);
  console.log(`📢 ${annonces.length} annonces créées`);

  console.log('\n🎉 Seed terminé avec succès !');
  console.log(`\n📌 Connexion boutique :`);
  console.log(`   Téléphone : 22677938688`);
  console.log(`   Mot de passe : password123`);
  console.log(`   Slug : kabore-et-fils`);
  console.log(`   URL boutique : GET /api/public/shop/kabore-et-fils`);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('❌ Erreur seed :', err);
  process.exit(1);
});
