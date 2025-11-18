// ------------------------------
// RefundHunter Backend API
// ------------------------------

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

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

        if (!csvContent) {
            return res.status(400).json({ error: "Missing CSV content." });
        }

        // ------------------------------
        // PROMPT FOR GEMINI
        // ------------------------------
        const promptText = `
You are an expert Amazon FBA reimbursement auditor.

Analyze the following raw Inventory Adjustment report data and extract ONLY valid claims where
Amazon owes reimbursement.

Return JSON ONLY, in this exact format:

[
  {
    "sku": "ABC-123",
    "reason": "Warehouse Lost",
    "quantity": 3,
    "estimatedValue": 25.50
  }
]

Use $8.50 per unit as the estimated reimbursement value.

--- RAW DATA BELOW ---
${csvContent.substring(0, 25000)}
        `;

        // ------------------------------
        // GEMINI PAYLOAD (CLEAN — NO DEPRECATED FIELDS)
        // ------------------------------
        const payload = {
            contents: [
                {
                    parts: [
                        { text: promptText }
                    ]
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
            console.error("Gemini Error:", gemData);
            return res.status(500).json({
                error: "Gemini API error",
                details: gemData
            });
        }

        // Extract text
        const aiText =
            gemData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // ------------------------------
        // TRY PARSING JSON FROM AI
        // ------------------------------
        let claims = [];
        try {
            claims = JSON.parse(aiText);
            if (!Array.isArray(claims)) throw new Error("Not array");
        } catch (err) {
            console.error("JSON parse failed. Raw AI text:", aiText);
            return res.status(500).json({
                error: "AI returned invalid JSON",
                raw: aiText
            });
        }

        // Calculate total
        const totalEstimatedValue = claims.reduce(
            (sum, c) => sum + (parseFloat(c.estimatedValue) || 0),
            0
        );

        // ------------------------------
        // SEND BACK TO FRONTEND
        // ------------------------------
        return res.json({
            claims,
            totalEstimatedValue
        });

    } catch (err) {
        console.error("Server error:", err);
        return res.status(500).json({ error: "Server error", details: err });
    }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`RefundHunter backend running on ${PORT}`));
