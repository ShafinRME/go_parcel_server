const dotenv = require('dotenv');

dotenv.config();

const required = ['DB_USER', 'DB_PASS', 'PAYMENT_GATEWAY_KEY', 'FB_SERVICE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
    // Never print the values, only which names are missing.
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

const list = (v) =>
    (v || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

module.exports = {
    isProd: process.env.NODE_ENV === 'production',
    port: Number(process.env.PORT) || 5000,
    dbUser: process.env.DB_USER,
    dbPass: process.env.DB_PASS,
    dbHost: process.env.DB_HOST || 'cluster0.pbd6wjw.mongodb.net',
    dbName: process.env.DB_NAME || 'shopDB',
    stripeSecret: process.env.PAYMENT_GATEWAY_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    firebaseServiceKey: process.env.FB_SERVICE_KEY,
    imgbbKey: process.env.IMGBB_KEY || '',
    // Comma separated list of origins allowed to call the API.
    corsOrigins: list(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173'),
    // Emails that are promoted to admin the first time they sign in.
    adminEmails: list(process.env.ADMIN_EMAILS),
    currency: (process.env.CURRENCY || 'usd').toLowerCase(),
};
