const env = require('./env');

module.exports = require('stripe')(env.stripeSecret);
