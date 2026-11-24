const { HttpError } = require('../utils/helpers');

/**
 * Validates req[source] against a zod schema and replaces it with the parsed (whitelisted) data.
 * With { onlyProvided: true } (used for PATCH) only keys the client actually sent are kept, so
 * schema `.default()` values never overwrite fields that were left out of a partial update.
 */
const validate = (schema, source = 'body', { onlyProvided = false } = {}) => (req, _res, next) => {
    const raw = req[source] ?? {};
    const result = schema.safeParse(raw);
    if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return next(new HttpError(400, details[0]?.message || 'Invalid request', details));
    }
    let data = result.data;
    if (onlyProvided && data && typeof data === 'object') {
        data = Object.fromEntries(Object.entries(data).filter(([k]) => Object.prototype.hasOwnProperty.call(raw, k)));
    }
    if (source === 'query') req.validQuery = data;
    else req[source] = data;
    next();
};

validate.patch = (schema) => validate(schema.partial(), 'body', { onlyProvided: true });

module.exports = validate;
