const router = require('express').Router();
const { z } = require('zod');
const { col } = require('../config/db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { HttpError, toId, escapeRegex, paginate } = require('../utils/helpers');
const { recomputeRating } = require('../utils/store');

const SORTS = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    popular: { soldCount: -1, ratingCount: -1 },
    rating: { ratingAvg: -1, ratingCount: -1 },
    discount: { discountPercent: -1 },
};

const listQuery = z.object({
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(200).optional(), // comma separated slugs
    brand: z.string().trim().max(300).optional(), // comma separated
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    rating: z.coerce.number().min(0).max(5).optional(),
    inStock: z.enum(['true', 'false']).optional(),
    onSale: z.enum(['true', 'false']).optional(),
    featured: z.enum(['true', 'false']).optional(),
    tag: z.string().trim().max(40).optional(),
    ids: z.string().trim().max(2000).optional(), // comma separated ids (recently viewed, wishlist)
    sort: z.enum(Object.keys(SORTS)).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(60).optional(),
});

const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30) : []);

const publicProjection = { costPrice: 0 };

router.get('/', validate(listQuery, 'query'), async (req, res) => {
    const q = req.validQuery;
    const { page, limit, skip } = paginate(q, { defLimit: 12, maxLimit: 60 });
    const filter = { status: 'active' };

    if (q.search) {
        const rx = new RegExp(escapeRegex(q.search), 'i');
        filter.$or = [{ title: rx }, { brand: rx }, { tags: rx }, { category: rx }];
    }
    const cats = csv(q.category);
    if (cats.length) filter.category = { $in: cats };
    const brands = csv(q.brand);
    if (brands.length) filter.brand = { $in: brands };
    if (q.minPrice != null || q.maxPrice != null) {
        filter.price = {};
        if (q.minPrice != null) filter.price.$gte = q.minPrice;
        if (q.maxPrice != null) filter.price.$lte = q.maxPrice;
    }
    if (q.rating) filter.ratingAvg = { $gte: q.rating };
    if (q.inStock === 'true') filter.stock = { $gt: 0 };
    if (q.onSale === 'true') filter.discountPercent = { $gt: 0 };
    if (q.featured === 'true') filter.featured = true;
    if (q.tag) filter.tags = q.tag;
    const ids = csv(q.ids);
    if (ids.length) filter._id = { $in: ids.filter((i) => /^[a-f0-9]{24}$/i.test(i)).map((i) => toId(i)) };

    const sort = { ...(SORTS[q.sort] || SORTS.newest), _id: -1 };

    const [items, total] = await Promise.all([
        col().products.find(filter, { projection: publicProjection }).sort(sort).skip(skip).limit(limit).toArray(),
        col().products.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
});

// Facets for the shop filters (brands + price range) — optionally scoped to a category.
router.get('/facets', async (req, res) => {
    const match = { status: 'active' };
    const cats = csv(typeof req.query.category === 'string' ? req.query.category : '');
    if (cats.length) match.category = { $in: cats };
    const [agg] = await col()
        .products.aggregate([
            { $match: match },
            {
                $facet: {
                    brands: [{ $match: { brand: { $nin: [null, ''] } } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 40 }],
                    price: [{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }],
                },
            },
        ])
        .toArray();
    res.json({
        brands: (agg?.brands || []).map((b) => ({ name: b._id, count: b.count })),
        price: agg?.price?.[0] ? { min: Math.floor(agg.price[0].min), max: Math.ceil(agg.price[0].max) } : { min: 0, max: 0 },
    });
});

// Lightweight search-as-you-type suggestions
router.get('/suggest', async (req, res) => {
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (term.length < 2) return res.json({ products: [], categories: [] });
    const rx = new RegExp(escapeRegex(term), 'i');
    const [products, categories] = await Promise.all([
        col()
            .products.find({ status: 'active', $or: [{ title: rx }, { brand: rx }, { tags: rx }] })
            .project({ title: 1, slug: 1, price: 1, images: { $slice: 1 }, brand: 1 })
            .sort({ soldCount: -1 })
            .limit(6)
            .toArray(),
        col().categories.find({ name: rx }).project({ name: 1, slug: 1 }).limit(4).toArray(),
    ]);
    res.json({ products, categories });
});

router.get('/:slug', async (req, res) => {
    const key = req.params.slug;
    const filter = /^[a-f0-9]{24}$/i.test(key) ? { _id: toId(key) } : { slug: key };
    const product = await col().products.findOne({ ...filter, status: 'active' }, { projection: publicProjection });
    if (!product) throw new HttpError(404, 'Product not found');

    const [related, category] = await Promise.all([
        col()
            .products.find({ status: 'active', category: product.category, _id: { $ne: product._id } }, { projection: publicProjection })
            .sort({ soldCount: -1 })
            .limit(8)
            .toArray(),
        col().categories.findOne({ slug: product.category }, { projection: { name: 1, slug: 1 } }),
    ]);
    res.json({ product, related, category });
});

// ---------- Reviews ----------
router.get('/:id/reviews', async (req, res) => {
    const productId = String(toId(req.params.id, 'product id'));
    const { page, limit, skip } = paginate(req.query, { defLimit: 5, maxLimit: 20 });
    const filter = { productId, status: 'published' };
    const [items, total, dist] = await Promise.all([
        col().reviews.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).project({ userEmail: 0 }).toArray(),
        col().reviews.countDocuments(filter),
        col().reviews.aggregate([{ $match: filter }, { $group: { _id: '$rating', n: { $sum: 1 } } }]).toArray(),
    ]);
    const distribution = [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: dist.find((d) => d._id === r)?.n || 0 }));
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)), distribution });
});

router.post(
    '/:id/reviews',
    requireAuth,
    validate(
        z.object({
            rating: z.coerce.number().int().min(1).max(5),
            title: z.string().trim().max(100).optional().default(''),
            comment: z.string().trim().min(5, 'Please write at least a few words').max(2000),
        })
    ),
    async (req, res) => {
        const pid = toId(req.params.id, 'product id');
        const product = await col().products.findOne({ _id: pid }, { projection: { _id: 1 } });
        if (!product) throw new HttpError(404, 'Product not found');

        const productId = String(pid);
        const verified = !!(await col().orders.findOne({
            email: req.auth.email,
            status: 'delivered',
            'items.productId': productId,
        }));

        const doc = {
            productId,
            userEmail: req.auth.email,
            userName: req.user?.name || req.auth.name || req.auth.email.split('@')[0],
            userPhoto: req.user?.photo || req.auth.picture || '',
            rating: req.body.rating,
            title: req.body.title,
            comment: req.body.comment,
            verified,
            status: 'published',
            updatedAt: new Date(),
        };
        await col().reviews.updateOne(
            { productId, userEmail: req.auth.email },
            { $set: doc, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        await recomputeRating(productId);
        res.status(201).json({ message: 'Thanks for your review!' });
    }
);

module.exports = router;
