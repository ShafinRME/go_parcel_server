const { MongoClient, ServerApiVersion } = require('mongodb');
const env = require('./env');

const uri = `mongodb+srv://${encodeURIComponent(env.dbUser)}:${encodeURIComponent(env.dbPass)}@${env.dbHost}/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
    maxPoolSize: 20,
});

let dbPromise = null;
let collections = null;

async function ensureIndexes(db) {
    await Promise.all([
        db.collection('users').createIndex({ email: 1 }, { unique: true }),
        db.collection('products').createIndex({ slug: 1 }, { unique: true }),
        db.collection('products').createIndex({ category: 1, status: 1 }),
        db.collection('products').createIndex({ createdAt: -1 }),
        db.collection('categories').createIndex({ slug: 1 }, { unique: true }),
        db.collection('orders').createIndex({ orderNumber: 1 }, { unique: true }),
        db.collection('orders').createIndex({ email: 1, createdAt: -1 }),
        db.collection('orders').createIndex({ status: 1, createdAt: -1 }),
        db.collection('reviews').createIndex({ productId: 1, createdAt: -1 }),
        db.collection('reviews').createIndex({ productId: 1, userEmail: 1 }, { unique: true }),
        db.collection('coupons').createIndex({ code: 1 }, { unique: true }),
        db.collection('carts').createIndex({ email: 1 }, { unique: true }),
        db.collection('wishlists').createIndex({ email: 1 }, { unique: true }),
        db.collection('subscribers').createIndex({ email: 1 }, { unique: true }),
    ]);
}

async function connect() {
    if (!dbPromise) {
        dbPromise = (async () => {
            await client.connect();
            const db = client.db(env.dbName);
            await ensureIndexes(db);
            collections = {
                db,
                users: db.collection('users'),
                products: db.collection('products'),
                categories: db.collection('categories'),
                orders: db.collection('orders'),
                reviews: db.collection('reviews'),
                coupons: db.collection('coupons'),
                carts: db.collection('carts'),
                wishlists: db.collection('wishlists'),
                banners: db.collection('banners'),
                settings: db.collection('settings'),
                subscribers: db.collection('subscribers'),
                messages: db.collection('messages'),
                counters: db.collection('counters'),
            };
            return collections;
        })().catch((err) => {
            dbPromise = null; // allow a retry on the next request
            throw err;
        });
    }
    return dbPromise;
}

const col = () => {
    if (!collections) throw new Error('Database not connected');
    return collections;
};

module.exports = { connect, col, client };
