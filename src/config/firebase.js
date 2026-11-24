const admin = require('firebase-admin');
const env = require('./env');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(Buffer.from(env.firebaseServiceKey, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

module.exports = admin;
