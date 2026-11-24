/**
 * Promote an existing user (who has signed in at least once) to admin.
 *   npm run make-admin -- someone@example.com
 */
const { connect, client } = require('../src/config/db');

(async () => {
    const email = (process.argv[2] || '').trim().toLowerCase();
    if (!email) {
        console.log('Usage: npm run make-admin -- <email>');
        return;
    }
    const db = await connect();
    const r = await db.users.updateOne({ email }, { $set: { role: 'admin', status: 'active' } });
    console.log(r.matchedCount ? `${email} is now an admin.` : `No user with email ${email}. Sign in on the site once first.`);
})()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => client.close());
