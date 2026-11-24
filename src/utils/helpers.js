const { ObjectId } = require('mongodb');

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

const toId = (value, label = 'id') => {
    if (typeof value !== 'string' || !ObjectId.isValid(value) || String(new ObjectId(value)) !== value) {
        throw new HttpError(400, `Invalid ${label}`);
    }
    return new ObjectId(value);
};

// Escapes user input before it is used inside a RegExp (prevents ReDoS / regex injection).
const escapeRegex = (s = '') => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100);

const slugify = (s = '') =>
    String(s)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

const paginate = (query, { defLimit = 12, maxLimit = 100 } = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defLimit));
    return { page, limit, skip: (page - 1) * limit };
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const pick = (obj, keys) =>
    keys.reduce((acc, k) => {
        if (obj[k] !== undefined) acc[k] = obj[k];
        return acc;
    }, {});

module.exports = { HttpError, toId, escapeRegex, slugify, paginate, round2, pick };
