# 📦 GO Parcel — Server Side

> **"Delivering trust, one parcel at a time."**

This is the backend REST API for **GO Parcel** — a full-stack parcel delivery management system. It handles authentication, parcel management, rider assignment, real-time tracking, and payment processing.

🌐 **Live API:** [Click Here](https://go-parcel-server-six.vercel.app/)
🔗 **Frontend Repo:** [Visit Here](https://github.com/ShafinRME/go_parcel_client)

---

## 🚀 Features

- JWT-based authentication using **Firebase Admin SDK**
- Role-based access control (User / Rider / Admin)
- Full parcel CRUD with status tracking
- Rider assignment and management system
- Stripe payment integration
- Real-time parcel tracking endpoints
- Secure environment variable management

---

## 🧰 Tech Stack

### Backend
| Technology | Link |
|---|---|
| Node.js | [nodejs.org](https://nodejs.org) |
| Express.js v5 | [expressjs.com](https://expressjs.com) |

### Database
| Technology | Link |
|---|---|
| MongoDB Atlas | [mongodb.com](https://www.mongodb.com) |

### Others
| Technology | Link |
|---|---|
| Firebase Admin SDK | [firebase.google.com](https://firebase.google.com) |
| Stripe API | [stripe.com](https://stripe.com) |
| Vercel | [vercel.com](https://vercel.com) |
| dotenv | [npmjs.com/package/dotenv](https://www.npmjs.com/package/dotenv) |
| CORS | [npmjs.com/package/cors](https://www.npmjs.com/package/cors) |
| Nodemon | [nodemon.io](https://nodemon.io) |

---

## 📡 API Endpoints

### Parcels
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/parcels/delivery/status-count` | Public | Get parcel count by status |
| GET | `/parcels` | Auth | Get all or filtered parcels |
| GET | `/parcels/:id` | Auth | Get single parcel |
| POST | `/parcels` | Auth | Create new parcel |
| PATCH | `/parcels/:id/assign` | Admin | Assign rider to parcel |
| PATCH | `/parcels/:id/status` | Auth | Update delivery status |
| PATCH | `/parcels/:id/cashout` | Rider | Cashout delivery earning |
| DELETE | `/parcels/:id` | Admin | Delete a parcel |

### Users
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/users/search` | Public | Search users by email |
| GET | `/users/:email/role` | Public | Get user role |
| POST | `/users` | Public | Create new user |
| PATCH | `/users/:id/role` | Admin | Update user role |

### Riders
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/riders/pending` | Admin | Get pending rider applications |
| GET | `/riders/available` | Public | Get available riders by district |
| GET | `/riders/active` | Admin | Get active riders |
| GET | `/rider/parcels` | Rider | Get assigned deliveries |
| GET | `/rider/completed-parcels` | Rider | Get completed deliveries |
| POST | `/riders` | Public | Submit rider application |
| PATCH | `/riders/:id/status` | Admin | Approve or reject rider |

### Trackings
| Method | Endpoint | Access | Description |
|---|---|---|---|
| POST | `/trackings/admin` | Admin | Create tracking update |
| POST | `/trackings` | Public | Add tracking entry |
| GET | `/trackings/parcel/:parcelId` | Public | Get tracking by parcel ID |
| GET | `/trackings/:trackingId` | Public | Get tracking by tracking ID |
| PATCH | `/trackings/:trackingId` | Admin | Update tracking entry |
| DELETE | `/trackings/:trackingId` | Admin | Delete tracking entry |

### Payments
| Method | Endpoint | Access | Description |
|---|---|---|---|
| POST | `/create-payment-intent` | Public | Create Stripe payment intent |
| GET | `/payments` | Auth | Get payment history |
| POST | `/payments` | Auth | Record new payment |

---

## ⚙️ Run Locally

### 1. Clone the repository
```bash
git clone https://github.com/ShafinRME/go_parcel_server.git
cd go_parcel_server
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables

Create a `.env` file in the root directory:
```env
DB_USER=your_mongodb_username
DB_PASS=your_mongodb_password
PAYMENT_GATEWAY_KEY=your_stripe_secret_key
FB_SERVICE_KEY=your_base64_encoded_firebase_service_account
```

> **FB_SERVICE_KEY** should be your Firebase service account JSON encoded in Base64.

### 4. Start the development server
```bash
npm run dev
```

The server will run at `http://localhost:5000`

---

## 🔮 Future Improvements

- Add global error handling middleware
- Add request rate limiting
- Integrate local Bangladeshi payment gateways (bKash, Nagad)
- Add OTP-based user verification
- Implement push notification service

---

## 👨‍💻 Author

**Md. Shafin Ahmed**
- GitHub: [@ShafinRME](https://github.com/ShafinRME)
