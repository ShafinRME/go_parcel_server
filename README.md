# Lumen & Co. — Store API

Express 5 + MongoDB + Firebase Auth + Stripe REST API for the Lumen & Co. storefront and admin dashboard.

## Setup

```bash
npm install
cp .env.example .env      # fill in the values
npm run seed              # demo catalog (only if the DB is empty)
npm run dev               # http://localhost:5000
```

First admin: put your email in `ADMIN_EMAILS` (comma separated) **or** sign in once on the site and run
`npm run make-admin -- you@example.com`.

| Script | What it does |
| --- | --- |
| `npm run dev` / `npm start` | Start the API |
| `npm run seed` | Seed categories, products, reviews, banners, coupons (skips if products exist) |
| `npm run seed:fresh` | Wipe catalog collections and reseed (users and orders are kept) |
| `npm run make-admin -- <email>` | Promote an existing user to admin |

## Environment

See `.env.example`. Secrets stay on the server: Stripe secret key, Firebase service account, imgbb key.

## Security model

- Identity always comes from a verified Firebase ID token — the client can never set its own role.
- Admin routes (`/admin/*`) require `role: admin`; blocked users are rejected everywhere.
- Prices, discounts, shipping and tax are recalculated on the server from the database for every quote and order.
- Card orders are only marked paid after the PaymentIntent is retrieved from Stripe and its status, amount, currency and order id match (plus optional signed webhook at `/webhooks/stripe`).
- Stock is reserved atomically (`$inc` with a `$gte` guard) and returned on cancel/refund.
- helmet, CORS allow-list, rate limiting, JSON body limits, zod validation on every write, escaped regex search, CSV formula-injection guard, generic 500 messages in production.

## Main endpoints

Public: `GET /settings`, `/banners`, `/categories`, `/testimonials`, `/products`, `/products/facets`, `/products/suggest`, `/products/:slug`, `/products/:id/reviews`, `GET /track`, `POST /subscribe`, `/contact`, `/orders/quote`

Customer (Bearer token): `POST /users/sync`, `GET|PATCH /users/me`, addresses CRUD, `GET|PUT /cart`, wishlist, `POST /orders`, `/orders/:id/confirm`, `/orders/:id/pay`, `/orders/:id/cancel`, `GET /orders/mine`, `/orders/:id`, `POST /products/:id/reviews`

Admin: `/admin/stats`, products (+ bulk), categories, orders (+ CSV export, status/tracking, refund), users (role/block), reviews, coupons, banners, messages, subscribers, settings, image upload.

## Deploy (Vercel)

`vercel.json` routes everything to `index.js`, which exports the Express app. Set all env vars in the Vercel project, set `NODE_ENV=production`, and add your storefront URL to `CORS_ORIGINS`.
