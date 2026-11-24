/**
 * Seeds the store database with demo catalog data.
 *   npm run seed            -> adds data only if the catalog is empty
 *   npm run seed -- --fresh -> wipes catalog collections first (never touches users or orders)
 *
 * Demo products come from the public dummyjson.com sample catalog.
 */
const { connect, client } = require('../src/config/db');
const { slugify, round2 } = require('../src/utils/helpers');
const { DEFAULT_SETTINGS, recomputeRating } = require('../src/utils/store');

const CATEGORIES = [
    { slug: 'smartphones', name: 'Phones', description: 'Flagships and everyday phones', featured: true },
    { slug: 'laptops', name: 'Laptops', description: 'Work, create and play anywhere', featured: true },
    { slug: 'tablets', name: 'Tablets', description: 'Big screens, light bags' },
    { slug: 'mobile-accessories', name: 'Tech Accessories', description: 'Charge, connect, listen', featured: true },
    { slug: 'mens-watches', name: 'Watches', description: 'Timepieces for every wrist', featured: true },
    { slug: 'womens-bags', name: 'Bags', description: 'Carry it beautifully', featured: true },
    { slug: 'mens-shoes', name: 'Sneakers', description: 'Built for the city' },
    { slug: 'sunglasses', name: 'Sunglasses', description: 'Shade, with style' },
    { slug: 'fragrances', name: 'Fragrances', description: 'Signature scents', featured: true },
    { slug: 'skin-care', name: 'Skin Care', description: 'Clean, simple routines' },
    { slug: 'furniture', name: 'Furniture', description: 'Pieces that last', featured: true },
    { slug: 'home-decoration', name: 'Home Decor', description: 'Small things, big mood' },
    { slug: 'kitchen-accessories', name: 'Kitchen', description: 'Tools for good food' },
    { slug: 'sports-accessories', name: 'Sports', description: 'Gear up, get out' },
];

const COLORS = {
    smartphones: ['Graphite', 'Silver', 'Ocean Blue'],
    laptops: ['Space Gray', 'Silver'],
    tablets: ['Space Gray', 'Silver', 'Rose'],
    'mens-watches': ['Black', 'Silver', 'Gold'],
    'womens-bags': ['Black', 'Tan', 'Cream'],
    'mens-shoes': ['Black', 'White', 'Olive'],
    sunglasses: ['Black', 'Tortoise'],
};
const SIZES = { 'mens-shoes': ['40', '41', '42', '43', '44', '45'] };

async function main() {
    const fresh = process.argv.includes('--fresh');
    const db = await connect();

    if (!fresh && (await db.products.countDocuments()) > 0) {
        console.log('Catalog already has products. Run with --fresh to reseed the catalog.');
        return;
    }
    if (fresh) {
        await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({}), db.banners.deleteMany({}), db.reviews.deleteMany({ seeded: true }), db.coupons.deleteMany({ seeded: true })]);
    }

    console.log('Downloading demo catalog…');
    const now = Date.now();
    const products = [];
    const reviews = [];
    const categories = [];

    for (const [ci, c] of CATEGORIES.entries()) {
        const r = await fetch(`https://dummyjson.com/products/category/${c.slug}?limit=20`);
        const { products: list = [] } = await r.json();
        categories.push({ ...c, image: list[0]?.thumbnail || '', order: ci, createdAt: new Date() });

        list.forEach((p, i) => {
            const onSale = p.discountPercentage >= 8;
            const price = round2(p.price);
            const compareAtPrice = onSale ? round2(price / (1 - p.discountPercentage / 100)) : null;
            let slug = slugify(p.title);
            if (products.some((x) => x.slug === slug)) slug = `${slug}-${p.id}`;
            const createdAt = new Date(now - (ci * 20 + i) * 3600 * 1000 * 7);
            products.push({
                _seedKey: p.id,
                title: p.title,
                slug,
                shortDescription: p.description.split('. ')[0].slice(0, 160),
                description: p.description,
                brand: p.brand || '',
                category: c.slug,
                images: p.images?.length ? p.images : [p.thumbnail],
                price,
                compareAtPrice,
                discountPercent: compareAtPrice ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100) : 0,
                costPrice: round2(price * 0.55),
                stock: p.stock,
                sku: p.sku,
                tags: (p.tags || []).map((t) => t.toLowerCase()),
                colors: COLORS[c.slug] || [],
                sizes: SIZES[c.slug] || [],
                specs: [
                    p.brand && { label: 'Brand', value: p.brand },
                    { label: 'SKU', value: p.sku },
                    p.weight && { label: 'Weight', value: `${p.weight} oz` },
                    p.dimensions && { label: 'Dimensions', value: `${p.dimensions.width} × ${p.dimensions.height} × ${p.dimensions.depth} cm` },
                    p.warrantyInformation && { label: 'Warranty', value: p.warrantyInformation },
                ].filter(Boolean),
                featured: p.rating >= 4.5 || i === 0,
                status: 'active',
                shippingInfo: p.shippingInformation || 'Ships in 2–4 business days',
                warranty: p.warrantyInformation || '',
                returnPolicy: p.returnPolicy || '30 days return policy',
                ratingAvg: 0,
                ratingCount: 0,
                soldCount: Math.round((p.rating || 3) * 13 + (p.id % 17) * 3),
                createdAt,
                updatedAt: createdAt,
                _reviews: p.reviews || [],
            });
        });
        process.stdout.write(`  ${c.name}: ${list.length} products\n`);
    }

    await db.categories.insertMany(categories);
    for (const p of products) {
        const { _seedKey, _reviews, ...doc } = p; // eslint-disable-line no-unused-vars
        const { insertedId } = await db.products.insertOne(doc);
        _reviews.forEach((rv, idx) => {
            reviews.push({
                productId: String(insertedId),
                userEmail: `demo-${_seedKey}-${idx}@example.com`,
                userName: rv.reviewerName,
                userPhoto: '',
                rating: rv.rating,
                title: '',
                comment: rv.comment,
                verified: true,
                status: 'published',
                seeded: true,
                createdAt: new Date(now - (idx + 1) * 86400000 * 3),
            });
        });
    }
    if (reviews.length) await db.reviews.insertMany(reviews);
    const ids = await db.products.find({}).project({ _id: 1 }).toArray();
    for (const { _id } of ids) await recomputeRating(_id);

    const pick = (cat) => products.find((p) => p.category === cat)?.images?.[0];
    await db.banners.insertMany([
        { eyebrow: 'New season', title: 'Objects worth keeping.', subtitle: 'Thoughtfully made essentials for home, work and the weekend — curated every week.', image: pick('furniture'), ctaText: 'Shop the edit', ctaLink: '/shop', theme: 'dark', active: true, order: 0, createdAt: new Date() },
        { eyebrow: 'Tech week', title: 'Up to 25% off laptops & phones', subtitle: 'Upgrade your everyday carry with the latest devices and accessories.', image: pick('laptops'), ctaText: 'Shop tech', ctaLink: '/shop?category=laptops,smartphones', theme: 'dark', active: true, order: 1, createdAt: new Date() },
        { eyebrow: 'Signature scents', title: 'Find a fragrance that feels like you', subtitle: 'Discover best-selling perfumes from the houses you love.', image: pick('fragrances'), ctaText: 'Explore fragrances', ctaLink: '/shop?category=fragrances', theme: 'dark', active: true, order: 2, createdAt: new Date() },
    ]);

    await db.coupons.insertMany([
        { code: 'WELCOME10', description: '10% off your first order', type: 'percent', value: 10, minOrder: 0, maxDiscount: 50, maxUses: 0, perUserLimit: 1, usedCount: 0, active: true, startsAt: null, expiresAt: null, seeded: true, createdAt: new Date() },
        { code: 'SAVE20', description: '$20 off orders over $150', type: 'fixed', value: 20, minOrder: 150, maxDiscount: null, maxUses: 500, perUserLimit: 0, usedCount: 0, active: true, startsAt: null, expiresAt: null, seeded: true, createdAt: new Date() },
    ]).catch(() => {});

    await db.settings.updateOne({ _id: 'store' }, { $setOnInsert: { ...DEFAULT_SETTINGS } }, { upsert: true });

    console.log(`Seeded ${categories.length} categories, ${products.length} products, ${reviews.length} reviews, 3 banners, 2 coupons.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => client.close());
