// server.js (Node 18+, "type": "module" in package.json)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Stripe from "stripe";
import admin from "firebase-admin";

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
// UTILITY FUNCTIONS (Integrated from utils/parseCSV.js and utils/validateClaims.js)
// ------------------------------

// Define the critical headers we expect and their aliases in the output data
const KEY_HEADERS = {
    'sku': 'sku',
    'product-sku': 'sku',
    'transaction-type': 'claimReason', // Used for the AI to determine claim eligibility
    'event-type': 'claimReason',
    'quantity': 'quantity',
    'shipped-quantity': 'quantity',
    'reference-id': 'amazonTransactionId', // Unique ID for tracking
    'transaction-item-id': 'amazonTransactionId',
};

/**
 * Preprocesses the raw CSV content into a structured array of objects.
 * It focuses on extracting the required fields for the audit logic.
 *
 * @param {string} csvContent The raw CSV file content.
 * @returns {{rows: Array<Object>}} An object containing the structured rows.
 */
function preprocessCSV(csvContent) {
    if (!csvContent) {
        return { rows: [] };
    }

    const lines = csvContent.trim().split('\n');
    if (lines.length === 0) {
        return { rows: [] };
    }

    // A simple way to handle common delimiters (comma or tab)
    const delimiter = csvContent.includes('\t') ? '\t' : ',';

    // 1. Parse Header
    let headers = lines[0].toLowerCase().split(delimiter).map(h => h.trim().replace(/"/g, ''));
    
    // Create a map from the current CSV header to the required output key (e.g., {'product-sku': 'sku'})
    const headerMap = {};
    headers.forEach((header, index) => {
        // Find a matching key in the KEY_HEADERS map
        const requiredKey = Object.keys(KEY_HEADERS).find(key => header.includes(key));
        if (requiredKey) {
            headerMap[index] = KEY_HEADERS[requiredKey];
        }
    });

    const rows = [];

    // 2. Parse Rows (skipping header row)
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Split line by delimiter, cleaning up quotes
        const values = line.split(delimiter).map(v => v.trim().replace(/"/g, ''));
        const rowData = {};
        
        // Map values to the standardized keys
        Object.keys(headerMap).forEach(index => {
            const key = headerMap[index];
            rowData[key] = values[index];
        });

        // Only include rows that have at least SKU and Quantity defined
        if (rowData.sku && parseInt(rowData.quantity, 10) > 0) {
            rows.push(rowData);
        }
    }

    // Limit the number of rows sent to Gemini to prevent excessively large requests
    return { rows: rows.slice(0, 500) };
}

/**
 * Validates and cleans the claims array returned by the AI.
 * It filters out malformed or invalid entries.
 *
 * @param {Array<Object>} claims The array of claim objects from the AI response.
 * @returns {Array<Object>} The array of valid, sanitized claims.
 */
function validateClaims(claims) {
    if (!Array.isArray(claims)) {
        console.error("Validation Error: Input is not an array.");
        return [];
    }

    const validClaims = [];

    for (const claim of claims) {
        // Ensure the claim is an object
        if (typeof claim !== 'object' || claim === null) {
            continue;
        }

        // Required fields check
        const requiredFields = ['sku', 'claimReason', 'quantity', 'estimatedValue'];
        const missingField = requiredFields.some(field => !claim[field]);

        if (missingField) {
            console.warn("Claim dropped due to missing required field:", claim);
            continue;
        }

        // Data type sanitization
        const quantity = parseInt(claim.quantity, 10);
        const estimatedValue = parseFloat(claim.estimatedValue);

        // Value checks
        if (isNaN(quantity) || quantity <= 0) {
            console.warn("Claim dropped: Invalid quantity.", claim);
            continue;
        }
        if (isNaN(estimatedValue) || estimatedValue <= 0) {
            console.warn("Claim dropped: Invalid estimated value.", claim);
            continue;
        }

        // Final structure for a valid claim
        const sanitizedClaim = {
            sku: String(claim.sku).trim(),
            claimReason: String(claim.claimReason).trim(),
            quantity: quantity,
            estimatedValue: parseFloat(estimatedValue.toFixed(2)), // Ensure 2 decimal places
            amazonTransactionId: claim.amazonTransactionId ? String(claim.amazonTransactionId).trim() : null,
        };

        validClaims.push(sanitizedClaim);
    }

    return validClaims;
}


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
    // Calls the locally defined function
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
      // Calls the locally defined validation function
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
