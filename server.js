// server.js  (Node 18+, "type": "module" in package.json)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Stripe from "stripe";
import admin from "firebase-admin";

import { preprocessCSV } from "./utils/parseCSV.js";
import { validateClaims } from "./utils/validateClaims.js";

// ------------------------------
// ENV CONFIG (Render Dashboard → Environment)
// ------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://theduckverse.github.io/RefundHunter/"; // change if you rename the GH page

if (!GEMINI_API_KEY) {
  console.warn("⚠️ Missing GEMINI_API_KEY env variable.");
}
if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️ Missing STRIPE_SECRET_KEY env variable.");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️ Missing STRIPE_WEBHOOK_SECRET env variable.");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ------------------------------
// FIREBASE ADMIN (for premium flag)
// ------------------------------
let firestore = null;

if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    firestore = admin.firestore();
    console.log("✅ Firestore initialized for Stripe premium updates.");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", err);
  }
} else {
  console.warn(
    "⚠️ FIREBASE_SERVICE_ACCOUNT not set. Stripe webhook will NOT update premium flags."
  );
}

// ------------------------------
// GEMINI CONFIG
// ------------------------------
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ------------------------------
// EXPRESS APP
// ------------------------------
const app = express();

// CORS
app.use(
  cors({
    origin: "*", // you can lock this down later
  })
);

// Body parser: skip JSON parsing for Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe-webhook") {
    next();
  } else {
    express.json({ limit: "20mb" })(req, res, next);
  }
});

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (req, res) => {
  res.json({ status: "FBA Money Scout backend running" });
});

// ------------------------------
// MAIN AUDIT ENDPOINT
// ------------------------------
app.post("/api/audit", async (req, res) => {
  try {
    const { csvContent, fileName, userId } = req.body;

    if (!csvContent) {
      return res.status(400).json({ error: "Missing CSV content." });
    }

    // PREPROCESS CSV BEFORE SENDING TO GEMINI
    const { rows } = preprocessCSV(csvContent);

    const prompt = `
You are an Amazon FBA Reimbursement Auditor.

Analyze ONLY the structured rows below.
Do NOT rely on raw CSV formatting, only on the fields provided.

Input rows:
${JSON.stringify(rows, null, 2)}

Rules:
• A valid claim must include: sku, reason, quantity, estimatedValue.
• estimatedValue = quantity * 8.50
• Return ONLY pure JSON array like:

[
  {
    "sku": "ABC-123",
    "claimReason": "Warehouse Lost",
    "quantity": 2,
    "estimatedValue": 17.00,
    "amazonTransactionId": "T123"
  }
]

If no valid claims exist, return [].
No comments. No markdown. No text outside JSON.
`;

    const payload = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
    };

    const gemResponse = await fetch(MODEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const gemData = await gemResponse.json();

    if (!gemResponse.ok) {
      console.error("Gemini API Error:", gemData);
      return res.status(500).json({
        error: "Gemini API error",
        details: gemData,
      });
    }

    const aiText =
      gemData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    let clean = aiText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");

    let claims = [];
    try {
      claims = JSON.parse(clean);
      claims = validateClaims(claims);
    } catch (err) {
      console.error("JSON PARSE FAIL:", clean);
      return res.status(500).json({
        error: "AI returned invalid JSON",
        raw: clean,
      });
    }

    const totalEstimatedValue = claims.reduce(
      (sum, c) => sum + (parseFloat(c.estimatedValue) || 0),
      0
    );

    // You could also generate pre-written messages here later
    const messages = [];

    return res.json({
      claims,
      totalEstimatedValue,
      messages,
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({ error: "Server error", details: err });
  }
});

// ------------------------------
// STRIPE: CREATE CHECKOUT SESSION
// ------------------------------
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, userId, email } = req.body;

    if (!priceId || !userId) {
      return res
        .status(400)
        .json({ error: "Missing priceId or userId in request body." });
    }

    const session = await stripe.checkout.sessions.create({
  mode: "subscription",

  payment_method_types: ["card", "link"],  // 🔥 THIS FIXES THE ISSUE

  line_items: [
    {
      price: priceId,
      quantity: 1,
    },
  ],

  customer_email: email || undefined,

  success_url: `${FRONTEND_URL}?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${FRONTEND_URL}?canceled=1`,

  metadata: {
    firebaseUserId: userId,
  },
});


    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe create-checkout-session error:", err);
    return res
      .status(500)
      .json({ error: "Stripe error", details: err.message });
  }
});

// ------------------------------
// STRIPE WEBHOOK
// ------------------------------
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    const sig = req.headers["stripe-signature"];

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
        case "invoice.paid": {
          const session = event.data.object;
          const firebaseUserId = session.metadata?.firebaseUserId;
          if (firebaseUserId && firestore) {
            const limitsRef = firestore.doc(
              `artifacts/default-app-id/users/${firebaseUserId}/user_data/limits`
            );
            await limitsRef.set({ isPremium: true }, { merge: true });
            console.log("✅ Marked user as premium:", firebaseUserId);
          } else if (!firestore) {
            console.warn(
              "⚠️ Webhook received but Firestore not initialized; cannot set premium."
            );
          }
          break;
        }
        default:
          console.log(`Unhandled Stripe event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Error handling webhook:", err);
      res.status(500).send("Webhook handler error");
    }
  }
);

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`🚀 FBA Money Scout backend running on port ${PORT}`)
);

