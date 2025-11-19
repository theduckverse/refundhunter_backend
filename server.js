// server.js  (Node 18+, "type": "module" in package.json)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Stripe from "stripe";
import admin from "firebase-admin";

import { preprocessCSV } from "./utils/parseCSV.js";
import { validateClaims } from "./utils/validateClaims.js";

// ------------------------------
// ENV CONFIG
// ------------------------------
const {
  GEMINI_API_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  FIREBASE_SERVICE_ACCOUNT,
  FRONTEND_URL = "https://theduckverse.github.io/RefundHunter/",
} = process.env;

// This is the appId / namespace we’ve been using in Firestore
const APP_ID = "fbamoneyscout";

if (!GEMINI_API_KEY) {
  console.warn("⚠️ Missing GEMINI_API_KEY env variable.");
}
if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️ Missing STRIPE_SECRET_KEY env variable.");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️ Missing STRIPE_WEBHOOK_SECRET env variable.");
}

// ------------------------------
// STRIPE CLIENT
// ------------------------------
const stripe = new Stripe(STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

// ------------------------------
// FIREBASE ADMIN (for premium flags & history)
// ------------------------------
let firestore = null;
let FieldValue = null;

if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    firestore = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    console.log("✅ Firestore initialized for backend updates.");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", err);
  }
} else {
  console.warn(
    "⚠️ FIREBASE_SERVICE_ACCOUNT not set. Backend cannot write premium flags or audit history."
  );
}

// Convenience helpers for paths
const userLimitsDoc = (userId) =>
  firestore.doc(
    `artifacts/${APP_ID}/users/${userId}/user_data/limits`
  );

const userHistoryCollection = (userId) =>
  firestore.collection(
    `artifacts/${APP_ID}/users/${userId}/audit_history`
  );

// ------------------------------
// GEMINI CONFIG
// ------------------------------
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ------------------------------
// EXPRESS APP
// ------------------------------
const app = express();

// CORS (you can tighten this later to your exact origin)
app.use(
  cors({
    origin: "*",
  })
);

// Body parser: skip JSON parsing for Stripe webhook (Stripe needs raw body)
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/stripe-webhook")) {
    return next();
  }
  return express.json({ limit: "20mb" })(req, res, next);
});

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (_req, res) => {
  res.json({ status: "FBA Money Scout backend running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

    // Clean up possible ```json wrappers / trailing commas
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

    // Optional messages placeholder
    const messages = [];

    // --------------------------
    // FIRESTORE: auditsUsed + history
    // --------------------------
    if (firestore && userId) {
      try {
        // Increment auditsUsed in limits doc
        const limitsRef = userLimitsDoc(userId);

        await firestore.runTransaction(async (tx) => {
          const snap = await tx.get(limitsRef);
          const data = snap.exists ? snap.data() : {};

          const maxFreeAudits = data.maxFreeAudits ?? 5; // default 5 free
          const newCount = (data.auditsUsed ?? 0) + 1;

          tx.set(
            limitsRef,
            {
              auditsUsed: newCount,
              maxFreeAudits,
            },
            { merge: true }
          );
        });

        // Append a history record
        const historyRef = userHistoryCollection(userId);
        await historyRef.add({
          createdAt: FieldValue.serverTimestamp(),
          fileName: fileName || "Unknown.csv",
          totalEstimatedValue,
          totalClaims: claims.length,
          sampleSku: claims[0]?.sku || null,
          sampleReason: claims[0]?.claimReason || null,
        });
      } catch (err) {
        console.error("⚠️ Failed to update Firestore for audit:", err);
      }
    } else if (!firestore && userId) {
      console.warn(
        "⚠️ Firestore not initialized; cannot track audits/history."
      );
    }

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
// USER STATUS (for login gating + UI)
// ------------------------------
app.get("/api/user-status/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!firestore) {
    return res.status(500).json({ error: "Firestore not configured" });
  }
  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  try {
    const limitsSnap = await userLimitsDoc(userId).get();
    const data = limitsSnap.exists ? limitsSnap.data() : {};

    return res.json({
      isPremium: !!data.isPremium,
      auditsUsed: data.auditsUsed ?? 0,
      maxFreeAudits: data.maxFreeAudits ?? 5,
    });
  } catch (err) {
    console.error("Error fetching user status:", err);
    return res.status(500).json({ error: "Failed to fetch user status" });
  }
});

// ------------------------------
// AUDIT HISTORY FETCH
// ------------------------------
app.get("/api/audit-history/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!firestore) {
    return res.status(500).json({ error: "Firestore not configured" });
  }
  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  try {
    const snap = await userHistoryCollection(userId)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    const history = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ history });
  } catch (err) {
    console.error("Error fetching audit history:", err);
    return res.status(500).json({ error: "Failed to fetch audit history" });
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
      payment_method_types: ["card", "link"], // Enable card + Link

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
// STRIPE WEBHOOK (subscription lifecycle)
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

    if (!firestore) {
      console.warn(
        "⚠️ Webhook received but Firestore not initialized; cannot update premium flags."
      );
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const firebaseUserId = session.metadata?.firebaseUserId;

          if (firestore && firebaseUserId) {
            await userLimitsDoc(firebaseUserId).set(
              { isPremium: true },
              { merge: true }
            );
            console.log("✅ Premium enabled after checkout:", firebaseUserId);
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "invoice.paid": {
          const subscription = event.data.object;
          const firebaseUserId = subscription.metadata?.firebaseUserId;

          if (firestore && firebaseUserId) {
            await userLimitsDoc(firebaseUserId).set(
              { isPremium: true },
              { merge: true }
            );
            console.log("🔁 Subscription active/renewed:", firebaseUserId);
          }
          break;
        }

        case "customer.subscription.deleted":
        case "invoice.payment_failed": {
          const subscription = event.data.object;
          const firebaseUserId = subscription.metadata?.firebaseUserId;

          if (firestore && firebaseUserId) {
            await userLimitsDoc(firebaseUserId).set(
              { isPremium: false },
              { merge: true }
            );
            console.log("⚠️ Subscription canceled or past due:", firebaseUserId);
          }
          break;
        }

        default:
          console.log("ℹ️ Unhandled Stripe event type:", event.type);
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

app.listen(PORT, () => {
  console.log(`🚀 FBA Money Scout backend running on port ${PORT}`);
});
