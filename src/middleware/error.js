const env = require('../config/env');

const notFound = (req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Something went wrong';

    if (err.type === 'entity.too.large') {
        status = 413;
        message = 'Request body is too large';
    } else if (err.type === 'entity.parse.failed') {
        status = 400;
        message = 'Malformed JSON body';
    } else if (err.code === 11000) {
        status = 409;
        message = 'A record with that value already exists';
    }

    if (status >= 500) {
        console.error(`[${req.method} ${req.path}]`, err);
        // Never leak internals (stack traces, driver messages) to the client in production.
        if (env.isProd) message = 'Internal server error';
    }

    res.status(status).json({ message, ...(err.details && status < 500 ? { details: err.details } : {}) });
};

module.exports = { notFound, errorHandler };
