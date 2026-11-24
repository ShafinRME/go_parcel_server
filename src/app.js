const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { connect } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Vercel / a reverse proxy
app.use(helmet());
app.use(compression());

// CORS: only the storefront origins listed in CORS_ORIGINS may call the API.
app.use(
    cors({
        origin(origin, cb) {
            if (!origin || env.corsOrigins.includes(origin.toLowerCase())) return cb(null, true);
            return cb(null, false);
        },
        credentials: false,
        maxAge: 600,
    })
);

// Stripe webhook must see the raw body, so it is mounted before the JSON parser.
app.use(require('./routes/webhook'));

const jsonParser = express.json({ limit: '200kb' });
app.use((req, res, next) => (req.path === '/admin/upload' ? next() : jsonParser(req, res, next)));

// Rate limits
app.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many requests, please try again later' } });
app.use(['/contact', '/subscribe', '/track'], strict);
app.use('/orders', rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/', (_req, res) => res.json({ name: 'Lumen & Co. API', status: 'ok' }));
app.get('/health', async (_req, res) => {
    await connect();
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Make sure the database is ready before any route runs (works for serverless cold starts too).
app.use(async (_req, _res, next) => {
    try {
        await connect();
        next();
    } catch (err) {
        next(err);
    }
});

app.use(require('./routes/public'));
app.use('/products', require('./routes/products'));
app.use(require('./routes/account'));
app.use(require('./routes/orders'));
app.use(require('./routes/admin'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
