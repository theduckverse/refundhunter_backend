// ------------------------------
// RefundHunter Backend API (Gemini 2.0 Compliant)
// ------------------------------

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

        if (!csvContent) {
            return res.status(400).json({ error: "Missing CSV content." });
        }

        // ------------------------------
        // REIMBURSEMENT AUDIT PROMPT
        // ------------------------------
// ------------------------------
// PREPROCESS CSV BEFORE SENDING TO GEMINI
// ------------------------------
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
    "reason": "Warehouse Lost",
    "quantity": 2,
    "estimatedValue": 17.00
  }
]

If no valid claims exist, return [].
No comments. No markdown. No text outside JSON.
`;

        // ------------------------------
        // GEMINI PAYLOAD
        // Clean. New. No deprecated fields.
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
        // FORCE-REPAIR JSON (Gemini sometimes adds trailing commas)
        // ------------------------------
        let clean = aiText
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .replace(/,\s*}/g, "}")
            .replace(/,\s*]/g, "]");

        // ------------------------------
        // PARSE JSON FROM AI
        // ------------------------------
        let claims = [];
        try {
            claims = JSON.parse(clean);
            claims = validateClaims(claims);
        } catch (err) {
            console.error("JSON PARSE FAIL:", clean);
            return res.status(500).json({
                error: "AI returned invalid JSON",
                raw: clean
            });
        }

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
            totalEstimatedValue
        });

    } catch (err) {
        console.error("Server Error:", err);
        return res.status(500).json({ error: "Server error", details: err });
    }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
    console.log(`RefundHunter backend running on port ${PORT}`)
);




