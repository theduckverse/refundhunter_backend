// ----------------------
// REFUNDHUNTER BACKEND
// ----------------------

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const app = express();
app.use(cors());

// ----------------------
// CONFIG
// ----------------------
const JSON_SIZE_LIMIT_MB = 25;
const UPLOAD_SIZE_LIMIT_MB = 100;
const MAX_CLAIMS = 50;

// ----------------------
// STRIPE WEBHOOK (RAW BODY)
// ----------------------
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("⚠️ Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("🔥 STRIPE EVENT RECEIVED:", event.type);

    // --------------------------
    // CHECKOUT SESSION COMPLETED
    // --------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("Checkout completed:", {
        email: session.customer_details?.email,
        amount: session.amount_total,
        metadata: session.metadata,
        client_reference_id: session.client_reference_id,
      });

      const userId = session.client_reference_id; // Firebase UID from frontend
      const total = session.amount_total; // cents

      if (!userId) {
        console.error("❌ No Firebase UID in client_reference_id!");
        return res.json({ received: true });
      }

      // Determine plan type
      let planType = "unknown";

      if (total === 9900) planType = "single";       // $99 single audit
      if (total === 19900) planType = "monthly";     // $199 monthly
      if (total === 2000) planType = "monthly";      // $20 monthly (testing)

      console.log("🔥 Upgrading user:", userId, "Plan:", planType);

      const userRef = admin.firestore().collection("users").doc(userId);

      try {
        if (planType === "monthly") {
          await userRef.set(
            {
              isPremium: true,
              planType: "monthly",
              auditsUsed: 0,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if (planType === "single") {
          await userRef.set(
            {
              extraAuditCredits: admin.firestore.FieldValue.increment(1),
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        console.log("🔥 Firestore entitlement updated!");
      } catch (err) {
        console.error("❌ Firestore update failed:", err);
      }
    }

    res.json({ received: true });
  }
);

// ----------------------
// NORMAL JSON BODY PARSING
// (Must come AFTER webhook)
// ----------------------
app.use(express.json({ limit: `${JSON_SIZE_LIMIT_MB}mb` }));

// ----------------------
// MULTER FILE UPLOAD
// ----------------------
const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: UPLOAD_SIZE_LIMIT_MB * 1024 * 1024,
  },
});

// ----------------------
// AI AUDIT ENDPOINT
// ----------------------
app.post("/api/audit-upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;

    let rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", async () => {
        fs.unlinkSync(filePath);

        if (rows.length > 500000) {
          return res.status(413).json({
            error: "File too large for AI. Try a smaller date range.",
          });
        }

        const csvContent = JSON.stringify(rows).slice(0, 20000); // Cap content

        const prompt = `
You are an FBA reimbursement auditor.
Analyze the CSV rows and detect ANY lost/missing/damaged/overcharge issues.
Respond with structured JSON:
{
  "claims": [{ "reason": "", "sku": "", "qty": 0, "value": 0, "refId": "" }],
  "summary": {
    "totalClaims": 0,
    "totalReimbursement": 0,
    "breakdown": {}
  }
}
Limit to ${MAX_CLAIMS} claims.
CSV DATA:
${csvContent}
        `;

        const aiRes = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              input: prompt,
            }),
          }
        );

        const aiJson = await aiRes.json();
        const parsed = JSON.parse(aiJson.output[0].content[0].text);

        return res.json(parsed);
      });
  } catch (err) {
    console.error("Audit error:", err);
    res.status(500).json({ error: "Server error analyzing file." });
  }
});

// ----------------------
// HEALTH CHECK
// ----------------------
app.get("/", (req, res) => {
  res.send("RefundHunter backend running");
});

// ----------------------
// START SERVER
// ----------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🔥 Server running on port ${PORT}`));
