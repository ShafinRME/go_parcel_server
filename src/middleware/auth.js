const admin = require('../config/firebase');
const { col } = require('../config/db');
const { HttpError } = require('../utils/helpers');

const readToken = (req) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
};

// Requires a valid Firebase ID token. Sets req.auth = { uid, email, name, picture }.
const requireAuth = async (req, _res, next) => {
    const token = readToken(req);
    if (!token) return next(new HttpError(401, 'Authentication required'));
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        if (!decoded.email) return next(new HttpError(401, 'Account has no email'));
        req.auth = {
            uid: decoded.uid,
            email: decoded.email.toLowerCase(),
            name: decoded.name || '',
            picture: decoded.picture || '',
        };
        const user = await col().users.findOne({ email: req.auth.email });
        if (user?.status === 'blocked') return next(new HttpError(403, 'Your account has been suspended'));
        req.user = user; // may be null until /users/sync is called
        next();
    } catch {
        next(new HttpError(401, 'Session expired, please sign in again'));
    }
};

// Same as requireAuth but never fails: used for routes that behave differently when signed in.
const optionalAuth = async (req, res, next) => {
    if (!readToken(req)) return next();
    return requireAuth(req, res, (err) => next(err && err.status === 403 ? err : undefined));
};

const requireRole = (...roles) => (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'Forbidden'));
    next();
};

const requireAdmin = [requireAuth, requireRole('admin')];

module.exports = { requireAuth, optionalAuth, requireRole, requireAdmin };
