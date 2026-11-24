const router = require('express').Router();
const { z } = require('zod');
const { ObjectId } = require('mongodb');
const { col } = require('../config/db');
const env = require('../config/env');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { HttpError, toId } = require('../utils/helpers');

const publicUser = (u) => ({
    _id: u._id,
    email: u.email,
    name: u.name,
    photo: u.photo,
    phone: u.phone || '',
    role: u.role,
    addresses: u.addresses || [],
    createdAt: u.createdAt,
});

// Every route in this file needs a signed-in user (scoped so it never touches other routers).
router.use(['/users', '/cart', '/wishlist'], requireAuth);

/**
 * Called after every sign in / sign up. Identity comes ONLY from the verified Firebase
 * token — the role can never be supplied by the client (fixes the old privilege escalation).
 */
router.post(
    '/users/sync',
    validate(z.object({ name: z.string().trim().max(80).optional(), photo: z.string().trim().url().max(500).optional().or(z.literal('')) })),
    async (req, res) => {
        const { email, uid, name, picture } = req.auth;
        const now = new Date();
        const isBootstrapAdmin = env.adminEmails.includes(email);
        await col().users.updateOne(
            { email },
            {
                $set: { uid, lastLoginAt: now, ...(isBootstrapAdmin ? { role: 'admin' } : {}) },
                $setOnInsert: {
                    email,
                    name: req.body.name || name || email.split('@')[0],
                    photo: req.body.photo || picture || '',
                    ...(isBootstrapAdmin ? {} : { role: 'customer' }),
                    status: 'active',
                    addresses: [],
                    createdAt: now,
                },
            },
            { upsert: true }
        );
        const user = await col().users.findOne({ email });
        res.json(publicUser(user));
    }
);

router.get('/users/me', async (req, res) => {
    if (!req.user) throw new HttpError(404, 'Profile not found');
    res.json(publicUser(req.user));
});

router.patch(
    '/users/me',
    validate(
        z.object({
            name: z.string().trim().min(2).max(80).optional(),
            phone: z.string().trim().max(30).optional(),
            photo: z.string().trim().url().max(500).optional().or(z.literal('')),
        })
    ),
    async (req, res) => {
        await col().users.updateOne({ email: req.auth.email }, { $set: { ...req.body, updatedAt: new Date() } });
        const user = await col().users.findOne({ email: req.auth.email });
        res.json(publicUser(user));
    }
);

const addressSchema = z.object({
    label: z.string().trim().max(30).optional().default('Home'),
    fullName: z.string().trim().min(2, 'Full name is required').max(80),
    phone: z.string().trim().min(5, 'Phone is required').max(30),
    line1: z.string().trim().min(3, 'Address is required').max(160),
    line2: z.string().trim().max(160).optional().default(''),
    city: z.string().trim().min(2, 'City is required').max(80),
    state: z.string().trim().max(80).optional().default(''),
    postalCode: z.string().trim().min(2, 'Postal code is required').max(20),
    country: z.string().trim().min(2).max(60).default('United States'),
    isDefault: z.boolean().optional().default(false),
});

router.post('/users/me/addresses', validate(addressSchema), async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(404, 'Profile not found');
    if ((user.addresses || []).length >= 10) throw new HttpError(400, 'You can save up to 10 addresses');
    const addr = { _id: new ObjectId().toString(), ...req.body };
    let addresses = [...(user.addresses || []), addr];
    if (addr.isDefault || addresses.length === 1) addresses = addresses.map((a) => ({ ...a, isDefault: a._id === addr._id }));
    await col().users.updateOne({ email: req.auth.email }, { $set: { addresses } });
    res.status(201).json(addresses);
});

router.put('/users/me/addresses/:addrId', validate(addressSchema), async (req, res) => {
    const list = req.user?.addresses || [];
    if (!list.some((a) => a._id === req.params.addrId)) throw new HttpError(404, 'Address not found');
    let addresses = list.map((a) => (a._id === req.params.addrId ? { _id: a._id, ...req.body } : a));
    if (req.body.isDefault) addresses = addresses.map((a) => ({ ...a, isDefault: a._id === req.params.addrId }));
    await col().users.updateOne({ email: req.auth.email }, { $set: { addresses } });
    res.json(addresses);
});

router.delete('/users/me/addresses/:addrId', async (req, res) => {
    let addresses = (req.user?.addresses || []).filter((a) => a._id !== req.params.addrId);
    if (addresses.length && !addresses.some((a) => a.isDefault)) addresses[0].isDefault = true;
    await col().users.updateOne({ email: req.auth.email }, { $set: { addresses } });
    res.json(addresses);
});

// ---------- Cart (persisted per user) ----------
const cartItem = z.object({
    productId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid product'),
    qty: z.coerce.number().int().min(1).max(99),
    color: z.string().trim().max(40).nullable().optional(),
    size: z.string().trim().max(40).nullable().optional(),
});

const hydrateCart = async (items) => {
    if (!items.length) return [];
    const products = await col()
        .products.find({ _id: { $in: items.map((i) => toId(i.productId)) } })
        .project({ title: 1, slug: 1, price: 1, compareAtPrice: 1, images: { $slice: 1 }, stock: 1, status: 1, brand: 1 })
        .toArray();
    const map = new Map(products.map((p) => [String(p._id), p]));
    return items
        .filter((i) => map.has(i.productId) && map.get(i.productId).status === 'active')
        .map((i) => ({ ...i, product: map.get(i.productId) }));
};

router.get('/cart', async (req, res) => {
    const cart = await col().carts.findOne({ email: req.auth.email });
    res.json(await hydrateCart(cart?.items || []));
});

router.put('/cart', validate(z.object({ items: z.array(cartItem).max(50) })), async (req, res) => {
    await col().carts.updateOne(
        { email: req.auth.email },
        { $set: { items: req.body.items, updatedAt: new Date() } },
        { upsert: true }
    );
    res.json(await hydrateCart(req.body.items));
});

// ---------- Wishlist ----------
router.get('/wishlist', async (req, res) => {
    const w = await col().wishlists.findOne({ email: req.auth.email });
    const ids = (w?.productIds || []).map((id) => toId(id));
    const products = ids.length
        ? await col().products.find({ _id: { $in: ids }, status: 'active' }, { projection: { costPrice: 0 } }).toArray()
        : [];
    res.json({ ids: w?.productIds || [], products });
});

router.post(
    '/wishlist/toggle',
    validate(z.object({ productId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid product') })),
    async (req, res) => {
        const { productId } = req.body;
        const w = await col().wishlists.findOne({ email: req.auth.email });
        const has = (w?.productIds || []).includes(productId);
        await col().wishlists.updateOne(
            { email: req.auth.email },
            has ? { $pull: { productIds: productId } } : { $addToSet: { productIds: productId } },
            { upsert: true }
        );
        const updated = await col().wishlists.findOne({ email: req.auth.email });
        res.json({ ids: updated?.productIds || [], added: !has });
    }
);

router.post(
    '/wishlist/merge',
    validate(z.object({ productIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(100) })),
    async (req, res) => {
        await col().wishlists.updateOne(
            { email: req.auth.email },
            { $addToSet: { productIds: { $each: req.body.productIds } } },
            { upsert: true }
        );
        const w = await col().wishlists.findOne({ email: req.auth.email });
        res.json({ ids: w?.productIds || [] });
    }
);

module.exports = router;
