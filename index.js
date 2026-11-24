const env = require('./src/config/env');
const app = require('./src/app');
const { connect } = require('./src/config/db');

// On Vercel the app is exported as a serverless handler; locally we start a server.
if (!process.env.VERCEL) {
    connect()
        .then(() => console.log(`MongoDB connected (db: ${env.dbName})`))
        .catch((err) => console.error('MongoDB connection failed:', err.message));
    app.listen(env.port, () => console.log(`API listening on http://localhost:${env.port}`));
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

module.exports = app;
