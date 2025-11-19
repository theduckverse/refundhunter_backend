// ==============================
// ========== IMPORTS ===========
// ==============================
import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { fileURLToPath } from "url";
import { dirname } from "path";

import {
  initializeApp,
  cert
} from "firebase-admin/app";

import {
  getFirestore,
  FieldValue,
} from "firebase-admin/firestore";

import parseCSV from "./utils/parseCSV.js";
import validateClaims from "./utils/validateClaims.js";

// ==============================
// ========== CONSTANTS =========
// ==============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

// Stripe raw body required for webhook validation
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==============================
// ===== FIREBASE ADMIN INIT ====
// ==============================

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();


// ==============================================================
// ============ HEALTH CHECK ENDPOINT ===========================
// ==============================================================

app.get("/", (req, res) => {
  res.send("RefundHunter Backend Running ✔");
});


// ==============================================================
// ============ CSV PARSE & CLAIM VALIDATION ====================
// ==============================================================

app.post("/audit", async (req, res) => {
  try {
    const { csvText, userId, appId } = req.body;

    if (!csvText || !userId || !appId) {
      return res.status(400).json({ error: "Missing required parameters." });
    }

    // Parse CSV → Convert to JSON
    const parsed = await parseCSV(csvText);

    // Validate claims
    const claims = validateClaims(parsed);

    // Store audit entry
    const docRef = db
      .collection(`artifacts/${appId}/users/${userId}/audits`)
      .doc();

    await docRef.set({
      createdAt: Date.now(),
      results: claims,
      rawCount: parsed.length,
    });

    return res.json({ claims });
  } catch (error) {
    console.error("Audit error:", error);
    return res.status(500).json({ error: "Audit failed." });
  }
});


// ==============================================================
// ============ STRIPE CHECKOUT SESSION =========================
// ==============================================================

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { userId, appId } = req.body;

    if (!userId || !appId) {
      return res.status(400).json({ error: "Missing userId or appId" });
    }

    const YOUR_DOMAIN = "https://www.fbamoneyscout.com";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "FBA Money Scout – Premium Upgrade",
            },
            unit_amount: 1499, // $14.99
          },
          quantity: 1,
        },
      ],

      success_url: `${YOUR_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/pricing`,

      metadata: {
        userId,
        appId,
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout session error:", error);
    return res.status(500).json({ error: "Could not create checkout session" });
  }
});


// ==============================================================
// ===================== STRIPE WEBHOOK =========================
// ==============================================================

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }), // required
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Successful payment
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.metadata.userId;
      const appId = session.metadata.appId;

      if (userId && appId) {
        console.log("Marking user as premium:", userId);

        const limitsRef = db.doc(
          `artifacts/${appId}/users/${userId}/user_data/limits`
        );

        await limitsRef.set(
          {
            isPremium: true,
            upgradedAt: Date.now(),
          },
          { merge: true }
        );
      }
    }

    res.json({ received: true });
  }
);


// ==============================================================
// =============== PORT / STARTUP ===============================
// ==============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 RefundHunter backend running on port ${PORT}`);
});
