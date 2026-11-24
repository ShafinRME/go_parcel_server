const router = require('express').Router();
const { z } = require('zod');
const { col } = require('../config/db');
const validate = require('../middleware/validate');
const { getSettings } = require('../utils/store');
const { HttpError } = require('../utils/helpers');

// Store settings visible to shoppers (no secrets live in this document).
router.get('/settings', async (_req, res) => {
    const s = await getSettings();
    res.set('Cache-Control', 'public, max-age=60');
    res.json(s);
});

router.get('/banners', async (_req, res) => {
    const banners = await col().banners.find({ active: true }).sort({ order: 1, createdAt: -1 }).limit(10).toArray();
    res.json(banners);
});

router.get('/categories', async (_req, res) => {
    const [cats, counts] = await Promise.all([
        col().categories.find({}).sort({ order: 1, name: 1 }).toArray(),
        col()
            .products.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$category', n: { $sum: 1 } } }])
            .toArray(),
    ]);
    const map = new Map(counts.map((c) => [c._id, c.n]));
    res.json(cats.map((c) => ({ ...c, productCount: map.get(c.slug) || 0 })));
});

// Top reviews used as storefront testimonials
router.get('/testimonials', async (_req, res) => {
    const items = await col()
        .reviews.find({ status: 'published', rating: { $gte: 4 }, comment: { $exists: true, $ne: '' } })
        .sort({ rating: -1, createdAt: -1 })
        .limit(9)
        .project({ userEmail: 0 })
        .toArray();
    res.json(items);
});

router.post(
    '/subscribe',
    validate(z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email').max(120) })),
    async (req, res) => {
        await col().subscribers.updateOne(
            { email: req.body.email },
            { $setOnInsert: { email: req.body.email, createdAt: new Date() } },
            { upsert: true }
        );
        res.status(201).json({ message: 'You are subscribed. Welcome aboard!' });
    }
);

router.post(
    '/contact',
    validate(
        z.object({
            name: z.string().trim().min(2, 'Name is too short').max(80),
            email: z.string().trim().toLowerCase().email('Enter a valid email').max(120),
            subject: z.string().trim().max(120).optional().default(''),
            message: z.string().trim().min(10, 'Message should be at least 10 characters').max(3000),
        })
    ),
    async (req, res) => {
        await col().messages.insertOne({ ...req.body, status: 'new', createdAt: new Date() });
        res.status(201).json({ message: 'Thanks! We will get back to you within one business day.' });
    }
);

// Guest order tracking: needs BOTH the order number and the email it was placed with.
router.get(
    '/track',
    validate(
        z.object({
            orderNumber: z.string().trim().toUpperCase().min(3).max(20),
            email: z.string().trim().toLowerCase().email(),
        }),
        'query'
    ),
    async (req, res) => {
        const { orderNumber, email } = req.validQuery;
        const order = await col().orders.findOne(
            { orderNumber, email },
            {
                projection: {
                    orderNumber: 1, status: 1, paymentStatus: 1, timeline: 1, createdAt: 1, total: 1,
                    trackingNumber: 1, carrier: 1, 'items.title': 1, 'items.image': 1, 'items.qty': 1,
                    'shippingAddress.city': 1, 'shippingAddress.country': 1,
                },
            }
        );
        if (!order) throw new HttpError(404, 'We could not find an order with those details');
        res.json(order);
    }
);

module.exports = router;
