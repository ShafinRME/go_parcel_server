const { col } = require('../config/db');
const stripe = require('../config/stripe');
const { reserveStock, restock } = require('./store');

const STATUS_FLOW = ['pending', 'processing', 'shipped', 'out_for_delivery', 'delivered'];
const ALL_STATUSES = ['awaiting_payment', ...STATUS_FLOW, 'cancelled', 'returned'];

const STATUS_LABEL = {
    awaiting_payment: 'Awaiting payment',
    pending: 'Order placed',
    processing: 'Processing',
    shipped: 'Shipped',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    returned: 'Returned',
};

const timelineEntry = (status, note = '', by = 'system') => ({
    status,
    label: STATUS_LABEL[status] || status,
    note,
    by,
    at: new Date(),
});

/**
 * Marks a card order as paid after the PaymentIntent was verified with Stripe.
 * Idempotent: safe to call from both the client confirmation and the webhook.
 */
async function finalizePaidOrder(order, paymentIntent) {
    const now = new Date();
    const claim = await col().orders.updateOne(
        { _id: order._id, paymentStatus: { $ne: 'paid' } },
        {
            $set: {
                paymentStatus: 'paid',
                status: 'pending',
                paidAt: now,
                paymentDetails: {
                    intentId: paymentIntent.id,
                    amount: paymentIntent.amount_received ?? paymentIntent.amount,
                    currency: paymentIntent.currency,
                    brand: paymentIntent.payment_method?.card?.brand || null,
                    last4: paymentIntent.payment_method?.card?.last4 || null,
                },
                updatedAt: now,
            },
            $push: { timeline: timelineEntry('pending', 'Payment received — thank you!') },
        }
    );
    if (claim.modifiedCount !== 1) return false; // someone else already finalized it

    const failed = await reserveStock(order.items);
    if (failed.length) {
        await col().orders.updateOne(
            { _id: order._id },
            {
                $set: { stockIssue: true },
                $push: {
                    timeline: timelineEntry('pending', `Stock conflict for: ${failed.map((f) => f.title).join(', ')}. Our team will contact you.`),
                },
            }
        );
    } else {
        await col().orders.updateOne({ _id: order._id }, { $set: { stockReserved: true } });
    }
    if (order.coupon?.code) await col().coupons.updateOne({ code: order.coupon.code }, { $inc: { usedCount: 1 } });
    await col().carts.updateOne({ email: order.email }, { $set: { items: [] } });
    return true;
}

/** Cancels an order, returns stock and refunds a paid card payment. */
async function cancelOrder(order, { reason = '', by = 'system', refund = true } = {}) {
    const update = {
        $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() },
        $push: { timeline: timelineEntry('cancelled', reason, by) },
    };

    if (order.paymentStatus === 'paid' && order.paymentMethod === 'card' && refund && order.paymentIntentId) {
        const r = await stripe.refunds.create({ payment_intent: order.paymentIntentId });
        update.$set.paymentStatus = 'refunded';
        update.$set.refundId = r.id;
        update.$set.refundedAt = new Date();
    } else if (order.status === 'awaiting_payment' && order.paymentIntentId) {
        await stripe.paymentIntents.cancel(order.paymentIntentId).catch(() => {});
        update.$set.paymentStatus = 'failed';
    }

    const r = await col().orders.updateOne({ _id: order._id, status: { $nin: ['cancelled', 'delivered', 'returned'] } }, update);
    if (r.modifiedCount === 1 && order.stockReserved) {
        await restock(order.items);
        await col().orders.updateOne({ _id: order._id }, { $set: { stockReserved: false } });
    }
    return r.modifiedCount === 1;
}

module.exports = { STATUS_FLOW, ALL_STATUSES, STATUS_LABEL, timelineEntry, finalizePaidOrder, cancelOrder };
