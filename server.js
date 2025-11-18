import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set.");
}

app.use(cors({
  origin: [
    "https://theduckverse.github.io",           // GitHub Pages root
    "https://theduckverse.github.io/RefundHunter" // your app
  ],
}));
app.use(express.json({ limit: "5mb" })); // CSV text fits fine

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "RefundHunter-backend" });
});

// Main audit endpoint
app.post("/api/audit", async (req, res) => {
  try {
    const { csvContent, fileName, userId } = req.body || {};

    if (!csvContent || !fileName) {
      return res.status(400).json({ error: "csvContent and fileName are required." });
    }

    const promptText = `
      You are an expert Amazon FBA reimbursement auditor.

      Analyze this CSV (could be Inventory Ledger, Daily Inventory, or similar).
      First infer column meanings from headers, then find claim-worthy discrepancies.

      Focus on these scenarios:
      1) Inventory lost or damaged in Amazon warehouse / fulfillment pipeline.
      2) Customer returns not properly reimbursed or returned to sellable inventory.
      3) Items disposed of by Amazon without reimbursement.

      Output ONLY a JSON array. Each object:
      - sku: string
      - amazonTransactionId: string
      - quantity: integer
      - claimReason: string
      - estimatedValue: number

      If nothing qualifies, return [].

      --- CSV START (truncated at 30k chars) ---
      ${csvContent.substring(0, 30000)}
      --- CSV END ---
    `;

    const jsonSchema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          sku: { type: "STRING" },
          amazonTransactionId: { type: "STRING" },
          quantity: { type: "INTEGER" },
          claimReason: { type: "STRING" },
          estimatedValue: { type: "NUMBER" },
        },
        propertyOrdering: [
          "sku",
          "amazonTransactionId",
          "quantity",
          "claimReason",
          "estimatedValue",
        ],
      },
    };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      systemInstruction: {
        parts: [{
          text: "Return ONLY a JSON array of claim objects following the schema. If no claims: []."
        }]
      },
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Gemini error:", response.status, text);
      return res.status(500).json({ error: "Gemini API error", status: response.status });
    }

    const result = await response.json();
    const jsonString = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    let claims = [];
    if (jsonString) {
      try {
        claims = JSON.parse(jsonString);
      } catch (e) {
        console.error("Failed to parse claims JSON:", e);
        claims = [];
      }
    }

    const totalEstimatedValue = claims.reduce(
      (sum, c) => sum + (parseFloat(c.estimatedValue) || 0),
      0
    );

    res.json({
      claims,
      totalEstimatedValue,
      fileName,
      userId: userId || null,
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`RefundHunter backend listening on port ${PORT}`);
});
