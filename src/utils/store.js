const { col } = require('../config/db');
const { HttpError, round2, toId } = require('./helpers');

const DEFAULT_SETTINGS = {
    _id: 'store',
    storeName: 'Lumen & Co.',
    tagline: 'Considered goods for everyday life',
    currencySymbol: '$',
    shippingFee: 6.99,
    freeShippingThreshold: 75,
    taxRate: 5, // percent
    codEnabled: true,
    announcement: 'Free shipping on orders over $75 · 30-day easy returns',
    contactEmail: 'hello@lumen.shop',
    contactPhone: '+1 (555) 010-2030',
    address: '221 Market Street, San Francisco, CA',
    social: { instagram: '', facebook: '', x: '', youtube: '' },
    heroBadge: 'New season · Autumn edit',
    lowStockThreshold: 10,
};

async function getSettings() {
    const doc = await col().settings.findOne({ _id: 'store' });
    return { ...DEFAULT_SETTINGS, ...(doc || {}), social: { ...DEFAULT_SETTINGS.social, ...(doc?.social || {}) } };
}

// Next human-friendly order number, e.g. LC-100042
async function nextOrderNumber() {
    const r = await col().counters.findOneAndUpdate(
        { _id: 'orderNumber' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    return `LC-${100000 + (r?.seq ?? r?.value?.seq ?? Date.now() % 100000)}`;
}

/**
 * Re-prices a cart using ONLY database values. Client-sent prices are never trusted.
 * items: [{ productId, qty, color?, size? }]
 */
async function priceCart(items, couponCode, { email } = {}) {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Your cart is empty');
    const settings = await getSettings();

    const ids = [...new Set(items.map((i) => String(i.productId)))].map((id) => toId(id, 'product id'));
    const products = await col().products.find({ _id: { $in: ids }, status: 'active' }).toArray();
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const lines = [];
    const problems = [];
    for (const item of items) {
        const p = byId.get(String(item.productId));
        const qty = Math.max(1, Math.min(99, parseInt(item.qty, 10) || 1));
        if (!p) {
            problems.push({ productId: item.productId, message: 'This product is no longer available' });
            continue;
        }
        if (p.stock < qty) {
            problems.push({
                productId: item.productId,
                message: p.stock > 0 ? `Only ${p.stock} left of ${p.title}` : `${p.title} is out of stock`,
            });
            continue;
        }
        lines.push({
            productId: String(p._id),
            title: p.title,
            slug: p.slug,
            image: p.images?.[0] || '',
            price: round2(p.price),
            qty,
            color: item.color || null,
            size: item.size || null,
            lineTotal: round2(p.price * qty),
        });
    }

    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

    let discount = 0;
    let coupon = null;
    let couponError = null;
    if (couponCode) {
        const c = await col().coupons.findOne({ code: String(couponCode).trim().toUpperCase() });
        const now = new Date();
        if (!c || !c.active) couponError = 'Coupon code is not valid';
        else if (c.startsAt && new Date(c.startsAt) > now) couponError = 'Coupon is not active yet';
        else if (c.expiresAt && new Date(c.expiresAt) < now) couponError = 'Coupon has expired';
        else if (c.maxUses && c.usedCount >= c.maxUses) couponError = 'Coupon usage limit reached';
        else if (c.minOrder && subtotal < c.minOrder) couponError = `Spend ${settings.currencySymbol}${c.minOrder} to use this coupon`;
        else if (c.perUserLimit && email) {
            const used = await col().orders.countDocuments({
                email,
                'coupon.code': c.code,
                status: { $ne: 'cancelled' },
            });
            if (used >= c.perUserLimit) couponError = 'You have already used this coupon';
        }
        if (!couponError) {
            discount = c.type === 'percent' ? (subtotal * c.value) / 100 : c.value;
            if (c.maxDiscount) discount = Math.min(discount, c.maxDiscount);
            discount = round2(Math.min(discount, subtotal));
            coupon = { code: c.code, type: c.type, value: c.value };
        }
    }

    const afterDiscount = round2(subtotal - discount);
    const shippingFee =
        lines.length === 0 || (settings.freeShippingThreshold && afterDiscount >= settings.freeShippingThreshold)
            ? 0
            : round2(settings.shippingFee);
    const tax = round2((afterDiscount * (Number(settings.taxRate) || 0)) / 100);
    const total = round2(afterDiscount + shippingFee + tax);

    return { lines, problems, subtotal, discount, coupon, couponError, shippingFee, tax, total, settings };
}

// Decrement stock atomically; returns list of items that could not be reserved.
async function reserveStock(lines) {
    const failed = [];
    const done = [];
    for (const l of lines) {
        const r = await col().products.updateOne(
            { _id: toId(l.productId), stock: { $gte: l.qty } },
            { $inc: { stock: -l.qty, soldCount: l.qty } }
        );
        if (r.modifiedCount === 1) done.push(l);
        else failed.push(l);
    }
    if (failed.length) {
        // roll back what we already took so stock never drifts
        await restock(done);
    }
    return failed;
}

async function restock(lines) {
    for (const l of lines) {
        await col().products.updateOne({ _id: toId(l.productId) }, { $inc: { stock: l.qty, soldCount: -l.qty } });
    }
}

async function recomputeRating(productId) {
    const [agg] = await col()
        .reviews.aggregate([
            { $match: { productId: String(productId), status: 'published' } },
            { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
        ])
        .toArray();
    await col().products.updateOne(
        { _id: toId(String(productId)) },
        { $set: { ratingAvg: agg ? round2(agg.avg) : 0, ratingCount: agg ? agg.count : 0 } }
    );
}

module.exports = { DEFAULT_SETTINGS, getSettings, nextOrderNumber, priceCart, reserveStock, restock, recomputeRating };
