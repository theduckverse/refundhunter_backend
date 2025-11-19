// RefundHunter Backend API (Gemini 2.0 Compliant)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { preprocessCSV } from "./utils/parseCSV.js";
import { validateClaims } from "./utils/validateClaims.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ------------------------------
// CONFIG
// ------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (req, res) => {
  res.json({ status: "RefundHunter backend running" });
});

// ------------------------------
// MAIN AUDIT ENDPOINT
// ------------------------------
app.post("/api/audit", async (req, res) => {
  try {
const { csvContent, fileName, userId } = req.body;

if (!userId || userId === "anonymous") {
    return res.status(403).json({ error: "User not authenticated." });
}

    // ------------------------------
    // PREPROCESS CSV BEFORE SENDING TO GEMINI
    // ------------------------------
    const { rows } = preprocessCSV(csvContent);
    console.log("PARSED CSV ROWS:", rows);

    // ------------------------------
    // REIMBURSEMENT + MESSAGE PROMPT
    // ------------------------------
    const prompt = `
You are an expert Amazon FBA reimbursement auditor.

You will receive a list of inventory ledger rows as JSON.
Each row can include fields like:
- sku
- transaction-type
- quantity
- reference-id
- event-date
- fulfillment-center
- disposition
- researching
- location
- reason
- unit-cost

Your job is:

1) Identify inventory issues that should be filed as FBA reimbursement claims.
2) For each claim, calculate:
   - sku
   - claimReason (short text like "Lost inventory" or "Warehouse damaged")
   - quantity (positive integer units to claim)
   - estimatedValue (quantity * 8.50 in USD, numeric)
   - amazonTransactionId (if you can infer one from the data, else "N/A")

3) Generate ready-to-send Amazon case messages for the seller to copy/paste.
   Each message should:
   - Be written in polite professional English.
   - Reference the sku, quantity, and situation.
   - Clearly request investigation and reimbursement.

IMPORTANT RULES:
- Only create claims where there is a clear issue (missing, lost, damaged, destroyed, etc).
- estimatedValue MUST be numeric, not a string, and equal to quantity * 8.50.
- If no valid claims exist, return empty arrays.

Return PURE JSON ONLY with THIS EXACT STRUCTURE:

{
  "claims": [
    {
      "sku": "TEST-SKU-001",
      "claimReason": "Lost inventory",
      "quantity": 2,
      "estimatedValue": 17.0,
      "amazonTransactionId": "123-456" 
    }
  ],
  "messages": [
    {
      "sku": "TEST-SKU-001",
      "reason": "Lost inventory",
      "message": "Hello Amazon Support, ... full case message text ..."
    }
  ]
}

- Do NOT wrap in markdown.
- Do NOT add explanations.
- ONLY return this JSON object.

InputRows:
${JSON.stringify(rows, null, 2)}
`;

    // ------------------------------
    // GEMINI PAYLOAD
    // ------------------------------
    const payload = {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    };

    // ------------------------------
    // CALL GEMINI
    // ------------------------------
    const gemResponse = await fetch(MODEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const gemData = await gemResponse.json();

    if (!gemResponse.ok) {
      console.error("Gemini API Error:", gemData);
      return res.status(500).json({
        error: "Gemini API error",
        details: gemData
      });
    }

    // Extract text response
    const aiText =
      gemData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    // ------------------------------
    // FORCE-REPAIR JSON (strip fences / trailing commas)
    // ------------------------------
    let clean = aiText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");

    console.log("RAW AI TEXT:", aiText);
    console.log("CLEANED AI TEXT:", clean);

    // ------------------------------
    // PARSE JSON FROM AI
    // ------------------------------
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (err) {
      console.error("JSON PARSE FAIL:", clean);
      return res.status(500).json({
        error: "AI returned invalid JSON",
        raw: clean
      });
    }

    // Support both new structure {claims, messages} and legacy [claims]
    const rawClaims = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.claims)
      ? parsed.claims
      : [];

    let claims = validateClaims(rawClaims);

    // Normalize messages
    let messages = [];
    if (parsed && Array.isArray(parsed.messages)) {
      messages = parsed.messages
        .map((m) => ({
          sku: (m.sku || "").trim(),
          reason: (m.reason || "").trim(),
          message: (m.message || "").trim()
        }))
        .filter((m) => m.message.length > 0);
    }

    console.log("FINAL CLAIMS:", claims);
    console.log("FINAL MESSAGES:", messages);

    // ------------------------------
    // CALCULATE TOTAL
    // ------------------------------
    const totalEstimatedValue = claims.reduce(
      (sum, c) => sum + (parseFloat(c.estimatedValue) || 0),
      0
    );

    // ------------------------------
    // SEND BACK TO FRONTEND
    // ------------------------------
    return res.json({
      claims,
      totalEstimatedValue,
      messages
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({ error: "Server error", details: err.message || err });
  }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`RefundHunter backend running on port ${PORT}`)
);

