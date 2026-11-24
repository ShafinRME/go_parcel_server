const express = require('express');
const { z } = require('zod');
const { col } = require('../config/db');
const env = require('../config/env');
const validate = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { HttpError, toId, escapeRegex, slugify, paginate, round2 } = require('../utils/helpers');
const { getSettings, recomputeRating, restock } = require('../utils/store');
const { ALL_STATUSES, timelineEntry, cancelOrder } = require('../utils/orders');
const stripe = require('../config/stripe');

const router = express.Router();
router.use('/admin', requireAdmin);

const url = z.string().trim().url('Must be a valid URL').max(1000);
const csvEscape = (v) => {
    const s = v == null ? '' : String(v);
    // also neutralises spreadsheet formula injection
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const sendCsv = (res, filename, header, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send([header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n'));
};

// =============== DASHBOARD ===============
router.get('/admin/stats', async (req, res) => {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const prevSince = new Date(since.getTime() - days * 86400000);
    const settings = await getSettings();
    const paidMatch = { $or: [{ paymentStatus: 'paid' }, { paymentMethod: 'cod', status: 'delivered' }] };

    const [
        revenueNow, revenuePrev, ordersNow, ordersPrev, customersNow, customersPrev,
        totalProducts, byDay, byStatus, topProducts, byCategory, lowStock, recentOrders,
        pendingReviews, newMessages, totalCustomers,
    ] = await Promise.all([
        col().orders.aggregate([{ $match: { ...paidMatch, createdAt: { $gte: since } } }, { $group: { _id: null, v: { $sum: '$total' } } }]).toArray(),
        col().orders.aggregate([{ $match: { ...paidMatch, createdAt: { $gte: prevSince, $lt: since } } }, { $group: { _id: null, v: { $sum: '$total' } } }]).toArray(),
        col().orders.countDocuments({ createdAt: { $gte: since }, status: { $ne: 'awaiting_payment' } }),
        col().orders.countDocuments({ createdAt: { $gte: prevSince, $lt: since }, status: { $ne: 'awaiting_payment' } }),
        col().users.countDocuments({ createdAt: { $gte: since } }),
        col().users.countDocuments({ createdAt: { $gte: prevSince, $lt: since } }),
        col().products.countDocuments({}),
        col().orders.aggregate([
            { $match: { createdAt: { $gte: since }, status: { $nin: ['awaiting_payment', 'cancelled'] } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
            { $sort: { _id: 1 } },
        ]).toArray(),
        col().orders.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        col().orders.aggregate([
            { $match: { status: { $nin: ['awaiting_payment', 'cancelled'] }, createdAt: { $gte: since } } },
            { $unwind: '$items' },
            { $group: { _id: '$items.productId', title: { $first: '$items.title' }, image: { $first: '$items.image' }, qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' } } },
            { $sort: { revenue: -1 } },
            { $limit: 6 },
        ]).toArray(),
        col().orders.aggregate([
            { $match: { status: { $nin: ['awaiting_payment', 'cancelled'] }, createdAt: { $gte: since } } },
            { $unwind: '$items' },
            { $lookup: { from: 'products', let: { pid: { $toObjectId: '$items.productId' } }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$pid'] } } }, { $project: { category: 1 } }], as: 'p' } },
            { $group: { _id: { $ifNull: [{ $first: '$p.category' }, 'other'] }, revenue: { $sum: '$items.lineTotal' } } },
            { $sort: { revenue: -1 } },
            { $limit: 6 },
        ]).toArray(),
        col().products.find({ stock: { $lte: settings.lowStockThreshold } }).project({ title: 1, stock: 1, images: { $slice: 1 }, sku: 1 }).sort({ stock: 1 }).limit(8).toArray(),
        col().orders.find({ status: { $ne: 'awaiting_payment' } }).project({ orderNumber: 1, customerName: 1, email: 1, total: 1, status: 1, paymentStatus: 1, createdAt: 1, itemCount: 1 }).sort({ createdAt: -1 }).limit(8).toArray(),
        col().reviews.countDocuments({ createdAt: { $gte: since } }),
        col().messages.countDocuments({ status: 'new' }),
        col().users.countDocuments({ role: 'customer' }),
    ]);

    // fill missing days so the chart is continuous
    const map = new Map(byDay.map((d) => [d._id, d]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        series.push({ date: d, revenue: round2(map.get(d)?.revenue || 0), orders: map.get(d)?.orders || 0 });
    }
    const pct = (a, b) => (b ? round2(((a - b) / b) * 100) : a ? 100 : 0);
    const rNow = revenueNow[0]?.v || 0;
    const rPrev = revenuePrev[0]?.v || 0;

    res.json({
        days,
        kpis: {
            revenue: { value: round2(rNow), change: pct(rNow, rPrev) },
            orders: { value: ordersNow, change: pct(ordersNow, ordersPrev) },
            avgOrder: { value: ordersNow ? round2(rNow / ordersNow) : 0 },
            newCustomers: { value: customersNow, change: pct(customersNow, customersPrev) },
            totalCustomers,
            totalProducts,
            pendingReviews,
            newMessages,
        },
        series,
        byStatus: byStatus.map((s) => ({ status: s._id, count: s.count })),
        topProducts,
        byCategory: byCategory.map((c) => ({ category: c._id, revenue: round2(c.revenue) })),
        lowStock,
        recentOrders,
    });
});

// =============== PRODUCTS ===============
const productSchema = z.object({
    title: z.string().trim().min(3, 'Title is too short').max(160),
    slug: z.string().trim().max(90).optional(),
    shortDescription: z.string().trim().max(300).optional().default(''),
    description: z.string().trim().min(10, 'Description is too short').max(8000),
    brand: z.string().trim().max(60).optional().default(''),
    category: z.string().trim().min(1, 'Category is required').max(60),
    images: z.array(url).min(1, 'Add at least one image').max(10),
    price: z.coerce.number().positive('Price must be greater than 0').max(1000000),
    compareAtPrice: z.coerce.number().min(0).max(1000000).optional().nullable(),
    costPrice: z.coerce.number().min(0).max(1000000).optional().nullable(),
    stock: z.coerce.number().int().min(0).max(1000000),
    sku: z.string().trim().max(60).optional().default(''),
    tags: z.array(z.string().trim().toLowerCase().max(30)).max(20).optional().default([]),
    colors: z.array(z.string().trim().max(30)).max(12).optional().default([]),
    sizes: z.array(z.string().trim().max(20)).max(12).optional().default([]),
    specs: z.array(z.object({ label: z.string().trim().max(60), value: z.string().trim().max(200) })).max(30).optional().default([]),
    featured: z.boolean().optional().default(false),
    status: z.enum(['active', 'draft']).optional().default('active'),
    shippingInfo: z.string().trim().max(200).optional().default(''),
    warranty: z.string().trim().max(200).optional().default(''),
    returnPolicy: z.string().trim().max(200).optional().default(''),
});

const withComputed = (p) => {
    const discountPercent = p.compareAtPrice && p.compareAtPrice > p.price ? Math.round(((p.compareAtPrice - p.price) / p.compareAtPrice) * 100) : 0;
    return { ...p, price: round2(p.price), compareAtPrice: p.compareAtPrice ? round2(p.compareAtPrice) : null, discountPercent };
};

const uniqueSlug = async (base, excludeId) => {
    let slug = slugify(base) || 'product';
    let i = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await col().products.findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { projection: { _id: 1 } })) {
        slug = `${slugify(base)}-${++i}`;
    }
    return slug;
};

router.get('/admin/products', async (req, res) => {
    const { page, limit, skip } = paginate(req.query, { defLimit: 15, maxLimit: 100 });
    const filter = {};
    const s = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (s) {
        const rx = new RegExp(escapeRegex(s), 'i');
        filter.$or = [{ title: rx }, { sku: rx }, { brand: rx }];
    }
    if (req.query.category) filter.category = String(req.query.category);
    if (['active', 'draft'].includes(req.query.status)) filter.status = req.query.status;
    const settings = await getSettings();
    if (req.query.stock === 'low') filter.stock = { $gt: 0, $lte: settings.lowStockThreshold };
    if (req.query.stock === 'out') filter.stock = 0;
    const sorts = { newest: { createdAt: -1 }, price: { price: -1 }, stock: { stock: 1 }, sales: { soldCount: -1 }, title: { title: 1 } };
    const [items, total] = await Promise.all([
        col().products.find(filter).sort({ ...(sorts[req.query.sort] || sorts.newest), _id: -1 }).skip(skip).limit(limit).toArray(),
        col().products.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

router.get('/admin/products/:id', async (req, res) => {
    const p = await col().products.findOne({ _id: toId(req.params.id) });
    if (!p) throw new HttpError(404, 'Product not found');
    res.json(p);
});

router.post('/admin/products', validate(productSchema), async (req, res) => {
    const data = withComputed(req.body);
    const cat = await col().categories.findOne({ slug: data.category });
    if (!cat) throw new HttpError(400, 'Category does not exist');
    const now = new Date();
    const doc = { ...data, slug: await uniqueSlug(data.slug || data.title), ratingAvg: 0, ratingCount: 0, soldCount: 0, createdAt: now, updatedAt: now };
    const { insertedId } = await col().products.insertOne(doc);
    res.status(201).json({ ...doc, _id: insertedId });
});

router.patch('/admin/products/:id', validate.patch(productSchema), async (req, res) => {
    const _id = toId(req.params.id);
    const current = await col().products.findOne({ _id });
    if (!current) throw new HttpError(404, 'Product not found');
    if (req.body.category && !(await col().categories.findOne({ slug: req.body.category }))) throw new HttpError(400, 'Category does not exist');
    const merged = withComputed({ ...current, ...req.body });
    const update = { ...req.body, price: merged.price, compareAtPrice: merged.compareAtPrice, discountPercent: merged.discountPercent, updatedAt: new Date() };
    if (req.body.slug !== undefined || req.body.title !== undefined) {
        update.slug = req.body.slug ? await uniqueSlug(req.body.slug, _id) : current.slug;
    }
    await col().products.updateOne({ _id }, { $set: update });
    res.json(await col().products.findOne({ _id }));
});

router.delete('/admin/products/:id', async (req, res) => {
    const _id = toId(req.params.id);
    const r = await col().products.deleteOne({ _id });
    if (!r.deletedCount) throw new HttpError(404, 'Product not found');
    await col().reviews.deleteMany({ productId: String(_id) });
    await col().wishlists.updateMany({}, { $pull: { productIds: String(_id) } });
    res.json({ message: 'Product deleted' });
});

router.post(
    '/admin/products/bulk',
    validate(z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(200), action: z.enum(['delete', 'activate', 'draft', 'feature', 'unfeature']) })),
    async (req, res) => {
        const ids = req.body.ids.map((i) => toId(i));
        const sets = { activate: { status: 'active' }, draft: { status: 'draft' }, feature: { featured: true }, unfeature: { featured: false } };
        if (req.body.action === 'delete') {
            await col().products.deleteMany({ _id: { $in: ids } });
            await col().reviews.deleteMany({ productId: { $in: req.body.ids } });
        } else {
            await col().products.updateMany({ _id: { $in: ids } }, { $set: { ...sets[req.body.action], updatedAt: new Date() } });
        }
        res.json({ message: `Updated ${ids.length} products` });
    }
);

// =============== CATEGORIES ===============
const categorySchema = z.object({
    name: z.string().trim().min(2).max(60),
    slug: z.string().trim().max(60).optional(),
    description: z.string().trim().max(300).optional().default(''),
    image: url.optional().or(z.literal('')).default(''),
    featured: z.boolean().optional().default(false),
    order: z.coerce.number().int().min(0).max(999).optional().default(0),
});

router.post('/admin/categories', validate(categorySchema), async (req, res) => {
    const slug = slugify(req.body.slug || req.body.name);
    const doc = { ...req.body, slug, createdAt: new Date() };
    const { insertedId } = await col().categories.insertOne(doc);
    res.status(201).json({ ...doc, _id: insertedId });
});

router.patch('/admin/categories/:id', validate.patch(categorySchema), async (req, res) => {
    const _id = toId(req.params.id);
    const cat = await col().categories.findOne({ _id });
    if (!cat) throw new HttpError(404, 'Category not found');
    const update = { ...req.body, updatedAt: new Date() };
    if (req.body.slug) {
        update.slug = slugify(req.body.slug);
        if (update.slug !== cat.slug) await col().products.updateMany({ category: cat.slug }, { $set: { category: update.slug } });
    }
    await col().categories.updateOne({ _id }, { $set: update });
    res.json(await col().categories.findOne({ _id }));
});

router.delete('/admin/categories/:id', async (req, res) => {
    const _id = toId(req.params.id);
    const cat = await col().categories.findOne({ _id });
    if (!cat) throw new HttpError(404, 'Category not found');
    const n = await col().products.countDocuments({ category: cat.slug });
    if (n) throw new HttpError(409, `Move or delete the ${n} product(s) in this category first`);
    await col().categories.deleteOne({ _id });
    res.json({ message: 'Category deleted' });
});

// =============== ORDERS ===============
const orderFilter = (q) => {
    const filter = {};
    if (q.status && ALL_STATUSES.includes(q.status)) filter.status = q.status;
    else filter.status = { $ne: 'awaiting_payment' };
    if (q.status === 'all') delete filter.status;
    if (['paid', 'unpaid', 'pending', 'refunded', 'failed'].includes(q.paymentStatus)) filter.paymentStatus = q.paymentStatus;
    if (['card', 'cod'].includes(q.paymentMethod)) filter.paymentMethod = q.paymentMethod;
    const s = typeof q.search === 'string' ? q.search.trim() : '';
    if (s) {
        const rx = new RegExp(escapeRegex(s), 'i');
        filter.$or = [{ orderNumber: rx }, { email: rx }, { customerName: rx }, { 'shippingAddress.phone': rx }];
    }
    if (q.from || q.to) {
        filter.createdAt = {};
        if (q.from && !Number.isNaN(Date.parse(q.from))) filter.createdAt.$gte = new Date(q.from);
        if (q.to && !Number.isNaN(Date.parse(q.to))) filter.createdAt.$lte = new Date(new Date(q.to).getTime() + 86399999);
    }
    return filter;
};

router.get('/admin/orders', async (req, res) => {
    const { page, limit, skip } = paginate(req.query, { defLimit: 15, maxLimit: 100 });
    const filter = orderFilter(req.query);
    const [items, total, counts] = await Promise.all([
        col().orders.find(filter).project({ timeline: 0 }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        col().orders.countDocuments(filter),
        col().orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
});

router.get('/admin/orders/export', async (req, res) => {
    const items = await col().orders.find(orderFilter(req.query)).sort({ createdAt: -1 }).limit(5000).toArray();
    sendCsv(
        res,
        `orders-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Order', 'Date', 'Customer', 'Email', 'Items', 'Subtotal', 'Discount', 'Shipping', 'Tax', 'Total', 'Payment', 'Payment status', 'Status', 'City', 'Country'],
        items.map((o) => [o.orderNumber, o.createdAt?.toISOString(), o.customerName, o.email, o.itemCount, o.subtotal, o.discount, o.shippingFee, o.tax, o.total, o.paymentMethod, o.paymentStatus, o.status, o.shippingAddress?.city, o.shippingAddress?.country])
    );
});

router.get('/admin/orders/:id', async (req, res) => {
    const o = await col().orders.findOne({ _id: toId(req.params.id) });
    if (!o) throw new HttpError(404, 'Order not found');
    const customerOrders = await col().orders.countDocuments({ email: o.email, status: { $ne: 'awaiting_payment' } });
    res.json({ ...o, customerOrders });
});

router.patch(
    '/admin/orders/:id',
    validate(
        z.object({
            status: z.enum(ALL_STATUSES.filter((s) => s !== 'awaiting_payment')).optional(),
            note: z.string().trim().max(300).optional().default(''),
            trackingNumber: z.string().trim().max(60).optional(),
            carrier: z.string().trim().max(60).optional(),
            paymentStatus: z.enum(['paid', 'unpaid']).optional(), // for COD collection
            adminNotes: z.string().trim().max(1000).optional(),
        })
    ),
    async (req, res) => {
        const _id = toId(req.params.id);
        const order = await col().orders.findOne({ _id });
        if (!order) throw new HttpError(404, 'Order not found');
        const { status, note, trackingNumber, carrier, paymentStatus, adminNotes } = req.body;
        const by = req.auth.email;

        if (status === 'cancelled') {
            if (order.status === 'cancelled') throw new HttpError(400, 'Order is already cancelled');
            await cancelOrder(order, { reason: note || 'Cancelled by store', by });
        } else {
            const $set = { updatedAt: new Date() };
            const push = [];
            if (status && status !== order.status) {
                if (order.status === 'cancelled') throw new HttpError(400, 'A cancelled order cannot be reopened');
                if (order.status === 'awaiting_payment') throw new HttpError(400, 'This order has not been paid yet');
                $set.status = status;
                if (status === 'delivered') {
                    $set.deliveredAt = new Date();
                    if (order.paymentMethod === 'cod') $set.paymentStatus = 'paid';
                }
                if (status === 'returned' && order.stockReserved) {
                    await restock(order.items);
                    $set.stockReserved = false;
                }
                push.push(timelineEntry(status, note, by));
            } else if (note) {
                push.push({ ...timelineEntry(order.status, note, by), label: 'Note' });
            }
            if (trackingNumber !== undefined) $set.trackingNumber = trackingNumber;
            if (carrier !== undefined) $set.carrier = carrier;
            if (adminNotes !== undefined) $set.adminNotes = adminNotes;
            if (paymentStatus && order.paymentMethod === 'cod') $set.paymentStatus = paymentStatus;
            await col().orders.updateOne({ _id }, { $set, ...(push.length ? { $push: { timeline: { $each: push } } } : {}) });
        }
        res.json(await col().orders.findOne({ _id }));
    }
);

router.post('/admin/orders/:id/refund', async (req, res) => {
    const _id = toId(req.params.id);
    const order = await col().orders.findOne({ _id });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.paymentMethod !== 'card' || order.paymentStatus !== 'paid' || !order.paymentIntentId) {
        throw new HttpError(400, 'Only paid card orders can be refunded');
    }
    const r = await stripe.refunds.create({ payment_intent: order.paymentIntentId });
    const $set = { paymentStatus: 'refunded', refundId: r.id, refundedAt: new Date(), updatedAt: new Date() };
    const entries = [{ ...timelineEntry(order.status, 'Payment refunded', req.auth.email), label: 'Refunded' }];
    if (!['delivered', 'returned', 'cancelled'].includes(order.status)) {
        $set.status = 'cancelled';
        entries.push(timelineEntry('cancelled', 'Cancelled and refunded', req.auth.email));
        if (order.stockReserved) {
            await restock(order.items);
            $set.stockReserved = false;
        }
    }
    await col().orders.updateOne({ _id }, { $set, $push: { timeline: { $each: entries } } });
    res.json(await col().orders.findOne({ _id }));
});

// =============== CUSTOMERS ===============
router.get('/admin/users', async (req, res) => {
    const { page, limit, skip } = paginate(req.query, { defLimit: 15, maxLimit: 100 });
    const filter = {};
    const s = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (s) {
        const rx = new RegExp(escapeRegex(s), 'i');
        filter.$or = [{ email: rx }, { name: rx }, { phone: rx }];
    }
    if (['admin', 'customer'].includes(req.query.role)) filter.role = req.query.role;
    if (['active', 'blocked'].includes(req.query.status)) filter.status = req.query.status;

    const [items, total] = await Promise.all([
        col().users.aggregate([
            { $match: filter },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
                $lookup: {
                    from: 'orders',
                    let: { e: '$email' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$email', '$$e'] }, status: { $nin: ['awaiting_payment', 'cancelled'] } } },
                        { $group: { _id: null, n: { $sum: 1 }, spent: { $sum: '$total' } } },
                    ],
                    as: 'stats',
                },
            },
            { $addFields: { orderCount: { $ifNull: [{ $first: '$stats.n' }, 0] }, totalSpent: { $ifNull: [{ $first: '$stats.spent' }, 0] } } },
            { $project: { stats: 0, uid: 0 } },
        ]).toArray(),
        col().users.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

router.get('/admin/users/:id', async (req, res) => {
    const u = await col().users.findOne({ _id: toId(req.params.id) }, { projection: { uid: 0 } });
    if (!u) throw new HttpError(404, 'User not found');
    const orders = await col().orders.find({ email: u.email }).project({ timeline: 0, items: 0 }).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({ ...u, orders });
});

router.patch(
    '/admin/users/:id',
    validate(z.object({ role: z.enum(['admin', 'customer']).optional(), status: z.enum(['active', 'blocked']).optional() })),
    async (req, res) => {
        const _id = toId(req.params.id);
        const u = await col().users.findOne({ _id });
        if (!u) throw new HttpError(404, 'User not found');
        if (u.email === req.auth.email) throw new HttpError(400, 'You cannot change your own role or status');
        if (u.role === 'admin' && (req.body.role === 'customer' || req.body.status === 'blocked')) {
            const admins = await col().users.countDocuments({ role: 'admin', status: { $ne: 'blocked' } });
            if (admins <= 1) throw new HttpError(400, 'At least one active admin is required');
        }
        await col().users.updateOne({ _id }, { $set: { ...req.body, updatedAt: new Date() } });
        res.json(await col().users.findOne({ _id }, { projection: { uid: 0 } }));
    }
);

// =============== REVIEWS ===============
router.get('/admin/reviews', async (req, res) => {
    const { page, limit, skip } = paginate(req.query, { defLimit: 15, maxLimit: 100 });
    const filter = {};
    if (['published', 'hidden'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.rating) filter.rating = Number(req.query.rating);
    const [items, total] = await Promise.all([
        col().reviews.aggregate([
            { $match: filter },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $lookup: { from: 'products', let: { pid: { $toObjectId: '$productId' } }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$pid'] } } }, { $project: { title: 1, slug: 1, images: { $slice: ['$images', 1] } } }], as: 'product' } },
            { $addFields: { product: { $first: '$product' } } },
        ]).toArray(),
        col().reviews.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

router.patch('/admin/reviews/:id', validate(z.object({ status: z.enum(['published', 'hidden']), reply: z.string().trim().max(1000).optional() })), async (req, res) => {
    const _id = toId(req.params.id);
    const r = await col().reviews.findOne({ _id });
    if (!r) throw new HttpError(404, 'Review not found');
    const $set = { status: req.body.status };
    if (req.body.reply !== undefined) $set.reply = req.body.reply ? { text: req.body.reply, at: new Date() } : null;
    await col().reviews.updateOne({ _id }, { $set });
    await recomputeRating(r.productId);
    res.json({ message: 'Review updated' });
});

router.delete('/admin/reviews/:id', async (req, res) => {
    const _id = toId(req.params.id);
    const r = await col().reviews.findOneAndDelete({ _id });
    const doc = r?.value ?? r;
    if (doc?.productId) await recomputeRating(doc.productId);
    res.json({ message: 'Review deleted' });
});

// =============== COUPONS ===============
const couponSchema = z.object({
    code: z.string().trim().toUpperCase().min(3).max(30).regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, - or _'),
    description: z.string().trim().max(160).optional().default(''),
    type: z.enum(['percent', 'fixed']),
    value: z.coerce.number().positive().max(100000),
    minOrder: z.coerce.number().min(0).optional().default(0),
    maxDiscount: z.coerce.number().min(0).optional().nullable(),
    maxUses: z.coerce.number().int().min(0).optional().default(0),
    perUserLimit: z.coerce.number().int().min(0).optional().default(0),
    startsAt: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
    active: z.boolean().optional().default(true),
}).refine((c) => c.type !== 'percent' || c.value <= 100, { message: 'Percent discount cannot exceed 100', path: ['value'] });

const normCoupon = (c) => ({
    ...c,
    startsAt: c.startsAt ? new Date(c.startsAt) : null,
    expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
});

router.get('/admin/coupons', async (_req, res) => {
    res.json(await col().coupons.find({}).sort({ createdAt: -1 }).toArray());
});
router.post('/admin/coupons', validate(couponSchema), async (req, res) => {
    const doc = { ...normCoupon(req.body), usedCount: 0, createdAt: new Date() };
    const { insertedId } = await col().coupons.insertOne(doc);
    res.status(201).json({ ...doc, _id: insertedId });
});
router.put('/admin/coupons/:id', validate(couponSchema), async (req, res) => {
    const _id = toId(req.params.id);
    await col().coupons.updateOne({ _id }, { $set: { ...normCoupon(req.body), updatedAt: new Date() } });
    res.json(await col().coupons.findOne({ _id }));
});
router.delete('/admin/coupons/:id', async (req, res) => {
    await col().coupons.deleteOne({ _id: toId(req.params.id) });
    res.json({ message: 'Coupon deleted' });
});

// =============== BANNERS ===============
const bannerSchema = z.object({
    title: z.string().trim().min(2).max(120),
    subtitle: z.string().trim().max(240).optional().default(''),
    eyebrow: z.string().trim().max(60).optional().default(''),
    image: url,
    ctaText: z.string().trim().max(40).optional().default('Shop now'),
    ctaLink: z.string().trim().max(300).regex(/^\/|^https?:\/\//, 'Link must start with / or http').optional().default('/shop'),
    theme: z.enum(['light', 'dark']).optional().default('dark'),
    active: z.boolean().optional().default(true),
    order: z.coerce.number().int().min(0).max(999).optional().default(0),
});
router.get('/admin/banners', async (_req, res) => res.json(await col().banners.find({}).sort({ order: 1 }).toArray()));
router.post('/admin/banners', validate(bannerSchema), async (req, res) => {
    const doc = { ...req.body, createdAt: new Date() };
    const { insertedId } = await col().banners.insertOne(doc);
    res.status(201).json({ ...doc, _id: insertedId });
});
router.put('/admin/banners/:id', validate(bannerSchema), async (req, res) => {
    const _id = toId(req.params.id);
    await col().banners.updateOne({ _id }, { $set: { ...req.body, updatedAt: new Date() } });
    res.json(await col().banners.findOne({ _id }));
});
router.delete('/admin/banners/:id', async (req, res) => {
    await col().banners.deleteOne({ _id: toId(req.params.id) });
    res.json({ message: 'Banner deleted' });
});

// =============== MESSAGES & SUBSCRIBERS ===============
router.get('/admin/messages', async (req, res) => {
    const filter = ['new', 'read', 'replied'].includes(req.query.status) ? { status: req.query.status } : {};
    res.json(await col().messages.find(filter).sort({ createdAt: -1 }).limit(200).toArray());
});
router.patch('/admin/messages/:id', validate(z.object({ status: z.enum(['new', 'read', 'replied']) })), async (req, res) => {
    await col().messages.updateOne({ _id: toId(req.params.id) }, { $set: { status: req.body.status } });
    res.json({ message: 'Updated' });
});
router.delete('/admin/messages/:id', async (req, res) => {
    await col().messages.deleteOne({ _id: toId(req.params.id) });
    res.json({ message: 'Deleted' });
});

router.get('/admin/subscribers', async (req, res) => {
    const items = await col().subscribers.find({}).sort({ createdAt: -1 }).limit(5000).toArray();
    if (req.query.format === 'csv') {
        return sendCsv(res, 'subscribers.csv', ['Email', 'Subscribed at'], items.map((s) => [s.email, s.createdAt?.toISOString()]));
    }
    res.json(items);
});
router.delete('/admin/subscribers/:id', async (req, res) => {
    await col().subscribers.deleteOne({ _id: toId(req.params.id) });
    res.json({ message: 'Removed' });
});

// =============== SETTINGS ===============
router.get('/admin/settings', async (_req, res) => res.json(await getSettings()));
router.put(
    '/admin/settings',
    validate(
        z.object({
            storeName: z.string().trim().min(2).max(60),
            tagline: z.string().trim().max(120).optional().default(''),
            currencySymbol: z.string().trim().min(1).max(4),
            shippingFee: z.coerce.number().min(0).max(1000),
            freeShippingThreshold: z.coerce.number().min(0).max(100000),
            taxRate: z.coerce.number().min(0).max(50),
            codEnabled: z.boolean(),
            announcement: z.string().trim().max(200).optional().default(''),
            heroBadge: z.string().trim().max(60).optional().default(''),
            contactEmail: z.string().trim().email().max(120).or(z.literal('')),
            contactPhone: z.string().trim().max(40).optional().default(''),
            address: z.string().trim().max(200).optional().default(''),
            lowStockThreshold: z.coerce.number().int().min(0).max(1000),
            social: z.object({
                instagram: z.string().trim().max(200).optional().default(''),
                facebook: z.string().trim().max(200).optional().default(''),
                x: z.string().trim().max(200).optional().default(''),
                youtube: z.string().trim().max(200).optional().default(''),
            }).optional().default({}),
        })
    ),
    async (req, res) => {
        await col().settings.updateOne({ _id: 'store' }, { $set: { ...req.body, updatedAt: new Date() } }, { upsert: true });
        res.json(await getSettings());
    }
);

// =============== IMAGE UPLOAD (key stays on the server) ===============
router.post(
    '/admin/upload',
    express.json({ limit: '8mb' }),
    validate(z.object({ image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif|avif);base64,/, 'Only PNG, JPG, WEBP, GIF or AVIF images are allowed').max(8 * 1024 * 1024) })),
    async (req, res) => {
        if (!env.imgbbKey) throw new HttpError(501, 'Image upload is not configured (IMGBB_KEY missing on the server)');
        const form = new FormData();
        form.append('image', req.body.image.split(',')[1]);
        const r = await fetch(`https://api.imgbb.com/1/upload?key=${env.imgbbKey}`, { method: 'POST', body: form });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data?.data?.url) throw new HttpError(502, 'Image upload failed, please try again');
        res.status(201).json({ url: data.data.display_url || data.data.url });
    }
);

module.exports = router;
