const router = require('express').Router();
const { z } = require('zod');
const { col } = require('../config/db');
const env = require('../config/env');
const stripe = require('../config/stripe');
const validate = require('../middleware/validate');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { HttpError, toId, paginate } = require('../utils/helpers');
const { priceCart, reserveStock, nextOrderNumber } = require('../utils/store');
const { timelineEntry, finalizePaidOrder, cancelOrder } = require('../utils/orders');

const itemSchema = z.object({
    productId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid product'),
    qty: z.coerce.number().int().min(1).max(99),
    color: z.string().trim().max(40).nullable().optional(),
    size: z.string().trim().max(40).nullable().optional(),
});

const quoteSchema = z.object({
    items: z.array(itemSchema).min(1, 'Your cart is empty').max(50),
    couponCode: z.string().trim().max(30).optional().nullable(),
});

const addressSchema = z.object({
    fullName: z.string().trim().min(2, 'Full name is required').max(80),
    phone: z.string().trim().min(5, 'Phone number is required').max(30),
    email: z.string().trim().toLowerCase().email().max(120).optional(),
    line1: z.string().trim().min(3, 'Street address is required').max(160),
    line2: z.string().trim().max(160).optional().default(''),
    city: z.string().trim().min(2, 'City is required').max(80),
    state: z.string().trim().max(80).optional().default(''),
    postalCode: z.string().trim().min(2, 'Postal code is required').max(20),
    country: z.string().trim().min(2).max(60),
});

const strip = ({ settings, ...rest }) => rest; // eslint-disable-line no-unused-vars

// Price preview for cart / checkout — server is the single source of truth for totals.
router.post('/orders/quote', optionalAuth, validate(quoteSchema), async (req, res) => {
    const q = await priceCart(req.body.items, req.body.couponCode, { email: req.auth?.email });
    res.json(strip(q));
});

router.post(
    '/orders',
    requireAuth,
    validate(
        quoteSchema.extend({
            shippingAddress: addressSchema,
            paymentMethod: z.enum(['card', 'cod']),
            notes: z.string().trim().max(500).optional().default(''),
        })
    ),
    async (req, res) => {
        if (!req.user) throw new HttpError(400, 'Please complete your profile first');
        const { items, couponCode, shippingAddress, paymentMethod, notes } = req.body;
        const q = await priceCart(items, couponCode, { email: req.auth.email });
        if (q.problems.length) throw new HttpError(409, q.problems[0].message, q.problems);
        if (couponCode && q.couponError) throw new HttpError(400, q.couponError);
        if (paymentMethod === 'cod' && !q.settings.codEnabled) throw new HttpError(400, 'Cash on delivery is not available');
        if (paymentMethod === 'card' && q.total < 0.5) throw new HttpError(400, 'Order total is too low for card payment');

        const now = new Date();
        const order = {
            orderNumber: await nextOrderNumber(),
            email: req.auth.email,
            userId: req.user._id,
            customerName: req.user.name || shippingAddress.fullName,
            items: q.lines,
            itemCount: q.lines.reduce((s, l) => s + l.qty, 0),
            subtotal: q.subtotal,
            discount: q.discount,
            coupon: q.coupon,
            shippingFee: q.shippingFee,
            tax: q.tax,
            total: q.total,
            currency: env.currency,
            shippingAddress,
            notes,
            paymentMethod,
            paymentStatus: paymentMethod === 'cod' ? 'unpaid' : 'pending',
            status: paymentMethod === 'cod' ? 'pending' : 'awaiting_payment',
            stockReserved: false,
            timeline: [timelineEntry(paymentMethod === 'cod' ? 'pending' : 'awaiting_payment', paymentMethod === 'cod' ? 'Order placed — pay on delivery' : 'Waiting for card payment')],
            createdAt: now,
            updatedAt: now,
        };

        if (paymentMethod === 'cod') {
            const failed = await reserveStock(q.lines);
            if (failed.length) throw new HttpError(409, `${failed[0].title} just sold out. Please update your cart.`);
            order.stockReserved = true;
            const { insertedId } = await col().orders.insertOne(order);
            if (order.coupon?.code) await col().coupons.updateOne({ code: order.coupon.code }, { $inc: { usedCount: 1 } });
            await col().carts.updateOne({ email: req.auth.email }, { $set: { items: [] } });
            return res.status(201).json({ order: { ...order, _id: insertedId } });
        }

        const { insertedId } = await col().orders.insertOne(order);
        const intent = await stripe.paymentIntents.create({
            amount: Math.round(q.total * 100),
            currency: env.currency,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            receipt_email: req.auth.email,
            metadata: { orderId: String(insertedId), orderNumber: order.orderNumber, email: req.auth.email },
        });
        await col().orders.updateOne({ _id: insertedId }, { $set: { paymentIntentId: intent.id } });
        res.status(201).json({ order: { ...order, _id: insertedId }, clientSecret: intent.client_secret });
    }
);

const loadOwnOrder = async (req) => {
    const order = await col().orders.findOne({ _id: toId(req.params.id, 'order id') });
    if (!order) throw new HttpError(404, 'Order not found');
    const isAdmin = req.user?.role === 'admin';
    // Ownership check — fixes the old IDOR where any user could read anyone's data.
    if (order.email !== req.auth.email && !isAdmin) throw new HttpError(404, 'Order not found');
    return order;
};

// Resume payment for an order that is still awaiting it
router.post('/orders/:id/pay', requireAuth, async (req, res) => {
    const order = await loadOwnOrder(req);
    if (order.status !== 'awaiting_payment' || !order.paymentIntentId) throw new HttpError(400, 'This order does not need payment');
    const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId);
    if (intent.status === 'succeeded') {
        await finalizePaidOrder(order, intent);
        return res.json({ paid: true });
    }
    res.json({ clientSecret: intent.client_secret });
});

// Client calls this after Stripe confirms the card. We VERIFY with Stripe before marking paid.
router.post('/orders/:id/confirm', requireAuth, async (req, res) => {
    const order = await loadOwnOrder(req);
    if (order.paymentStatus === 'paid') return res.json({ order });
    if (!order.paymentIntentId) throw new HttpError(400, 'No payment found for this order');

    const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId, { expand: ['payment_method'] });
    const valid =
        intent.status === 'succeeded' &&
        intent.metadata?.orderId === String(order._id) &&
        intent.amount === Math.round(order.total * 100) &&
        intent.currency === order.currency;
    if (!valid) throw new HttpError(402, 'Payment has not been completed');

    await finalizePaidOrder(order, intent);
    res.json({ order: await col().orders.findOne({ _id: order._id }) });
});

router.get('/orders/mine', requireAuth, async (req, res) => {
    const { page, limit, skip } = paginate(req.query, { defLimit: 10, maxLimit: 50 });
    const filter = { email: req.auth.email };
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    const [items, total] = await Promise.all([
        col().orders.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).project({ timeline: 0 }).toArray(),
        col().orders.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

router.get('/orders/:id', requireAuth, async (req, res) => {
    res.json(await loadOwnOrder(req));
});

router.post(
    '/orders/:id/cancel',
    requireAuth,
    validate(z.object({ reason: z.string().trim().max(300).optional().default('Cancelled by customer') })),
    async (req, res) => {
        const order = await loadOwnOrder(req);
        if (!['awaiting_payment', 'pending', 'processing'].includes(order.status)) {
            throw new HttpError(400, 'This order can no longer be cancelled');
        }
        const ok = await cancelOrder(order, { reason: req.body.reason, by: 'customer' });
        if (!ok) throw new HttpError(409, 'Order could not be cancelled');
        res.json(await col().orders.findOne({ _id: order._id }));
    }
);

module.exports = router;
