const express = require('express');
const { ObjectId } = require('mongodb');
const env = require('../config/env');
const stripe = require('../config/stripe');
const { connect, col } = require('../config/db');
const { finalizePaidOrder } = require('../utils/orders');

const router = express.Router();

// Stripe webhook (optional but recommended in production). Needs the RAW body for signature checks.
router.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!env.stripeWebhookSecret) return res.status(501).json({ message: 'Webhook not configured' });
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.stripeWebhookSecret);
    } catch {
        return res.status(400).json({ message: 'Invalid signature' });
    }

    await connect();
    if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId && ObjectId.isValid(orderId)) {
            const order = await col().orders.findOne({ _id: new ObjectId(orderId), paymentIntentId: pi.id });
            if (order && pi.amount === Math.round(order.total * 100)) await finalizePaidOrder(order, pi);
        }
    } else if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object;
        await col().orders.updateOne(
            { paymentIntentId: pi.id, paymentStatus: 'pending' },
            { $set: { lastPaymentError: pi.last_payment_error?.message || 'Payment failed' } }
        );
    }
    res.json({ received: true });
});

module.exports = router;
