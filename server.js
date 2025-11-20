// server.js
//
// FBA Money Scout backend
// - POST /api/audit       : JSON body { csvContent, fileName, userId }  (works with your current frontend)
// - POST /api/audit-upload: multipart/form-data with a CSV file (for future, true streaming)
//
// Uses heuristic CSV parsing to generate claims + messages.
// If OPENAI_API_KEY is set, it also asks OpenAI once for a short summary.
//

const express = require("express");
const cors = require("cors");
const { parse } = require("csv-parse/sync");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csvStreamParser = require("csv-parser");
const fetch = require("node-fetch");

const app = express();

// ----------- CONFIG ----------
const JSON_SIZE_LIMIT_MB = 25;   // Max JSON csvContent size
const UPLOAD_SIZE_LIMIT_MB = 100; // Max uploaded file size
const MAX_CLAIMS = 50;           // Cap #claims so UI isn't flooded

// Express middlewares
app.use(cors());
// --- STRIPE WEBHOOK (must use raw body) ---
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe sends events here
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("⚠️  Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        // This is where we decide the plan
        // You can use:
        // - session.metadata.plan_type
        // - session.amount_total
        // - session.mode / line_items
        //
        // For now we just log it so we know it's working.
        console.log("✅ Checkout completed:", {
          id: session.id,
          customer_email: session.customer_details?.email,
          amount_total: session.amount_total,
          metadata: session.metadata
        });

        // TODO (next step): look up Firebase user by email or metadata,
        // then mark them as premium / add single-audit credit.
        break;
      }

      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    // Must respond 2xx so Stripe knows we received it
    res.json({ received: true });
  }
);
app.use(express.json({ limit: `${JSON_SIZE_LIMIT_MB}mb` }));

// Multer for streaming uploads (file is written to /tmp and streamed from disk)
const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: UPLOAD_SIZE_LIMIT_MB * 1024 * 1024
  }
});

// ---------- UTILITIES ----------

function findFieldName(record, candidates) {
  const keys = Object.keys(record || {});
  const lowered = keys.map((k) => k.toLowerCase());
  for (const cand of candidates) {
    const idx = lowered.findIndex((k) => k.includes(cand));
    if (idx !== -1) return keys[idx];
  }
  return null;
}

function buildClaimsFromRecords(records) {
  if (!records || records.length === 0) {
    return { claims: [], totalEstimatedValue: 0, messages: [] };
  }

  const sample = records[0];

  const skuField =
    findFieldName(sample, ["seller-sku", "msku", "sku"]) || null;
  const qtyField =
    findFieldName(sample, ["quantity", "qty", "units", "change"]) || null;
  const valueField = findFieldName(sample, [
    "amount",
    "value",
    "reimbursement",
    "estimated",
    "unit-price",
    "price"
  ]);
  const reasonField = findFieldName(sample, [
    "reason",
    "event",
    "event-type",
    "disposition"
  ]);
  const txnField = findFieldName(sample, [
    "transaction-id",
    "event-id",
    "reference",
    "id"
  ]);

  let claims = [];
  let messages = [];
  let totalEstimatedValue = 0;

  for (let i = 0; i < records.length && claims.length < MAX_CLAIMS; i++) {
    const row = records[i];

    const sku = skuField ? String(row[skuField] || "").trim() : "";
    const rawQty = qtyField ? row[qtyField] : 1;
    const quantity = Number(rawQty) || 1;

    let value = 0;
    if (valueField && row[valueField] != null) {
      const parsedVal = parseFloat(
        String(row[valueField]).replace(/[^0-9\.-]/g, "")
      );
      if (Number.isFinite(parsedVal)) value = Math.abs(parsedVal);
    }
    if (!value || value <= 0) {
      // Fallback heuristic if no value column found
      value = quantity > 0 ? quantity * 10 : 5;
    }

    const amazonTransactionId = txnField
      ? String(row[txnField] || "").trim()
      : "";

    const reasonRaw = reasonField ? String(row[reasonField] || "").trim() : "";
    const claimReason =
      reasonRaw ||
      "Inventory discrepancy detected based on ledger / history records.";

    const claim = {
      sku: sku || `UNKNOWN-SKU-${i + 1}`,
      quantity,
      amazonTransactionId: amazonTransactionId || `N/A-${i + 1}`,
      estimatedValue: value,
      claimReason
    };

    totalEstimatedValue += value;
    claims.push(claim);

    const msg = {
      sku: claim.sku,
      reason: claimReason,
      message: `Hello Amazon FBA Support,

We have identified a potential inventory discrepancy for SKU ${claim.sku} in our inventory ledger / daily history report.

Key details:
- SKU: ${claim.sku}
- Quantity affected: ${claim.quantity}
- Estimated reimbursement value: $${claim.estimatedValue.toFixed(2)}
- Reference / Transaction ID: ${claim.amazonTransactionId}

Please investigate this discrepancy and reimburse any missing / damaged units according to your FBA reimbursement policy.

Thank you.`
    };
    messages.push(msg);
  }

  return { claims, totalEstimatedValue, messages };
}

// Optional: ask OpenAI for a short overall summary (does NOT affect claims structure)
async function maybeSummarizeWithOpenAI(claims, totalEstimatedValue, fileName) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    if (!claims || claims.length === 0) return null;

    const topClaims = claims.slice(0, 10);
    const bulletLines = topClaims
      .map(
        (c, idx) =>
          `${idx + 1}. SKU ${c.sku}, qty ${c.quantity}, approx $${c.estimatedValue.toFixed(
            2
          )}, reason: ${c.claimReason}`
      )
      .join("\n");

    const prompt = `
You are helping an Amazon FBA seller understand a reimbursement audit.

Total estimated reimbursement: $${totalEstimatedValue.toFixed(2)}
Report file name: ${fileName || "N/A"}

Here are some of the top claim candidates:
${bulletLines}

Write a short (2–4 sentences) plain-English summary explaining what this audit found and what the seller should do next. Do NOT mention that you are an AI. Speak directly to the seller.
`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a concise FBA reimbursement audit assistant." },
          { role: "user", content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 300
      })
    });

    if (!res.ok) {
      console.error("OpenAI API error status:", res.status);
      return null;
    }
    const data = await res.json();
    const summary =
      data.choices?.[0]?.message?.content?.trim() ||
      null;
    return summary;
  } catch (err) {
    console.error("Error calling OpenAI:", err);
    return null;
  }
}

// ---------- ROUTES ----------

// Health check
app.get("/", (req, res) => {
  res.send("RefundHunter / FBA Money Scout backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * POST /api/audit
 * Body: { csvContent, fileName, userId }
 * This is what your current frontend calls today.
 */
app.post("/api/audit", async (req, res) => {
  try {
    const { csvContent, fileName, userId } = req.body || {};

    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({
        error:
          "csvContent string is required in the request body. (frontend currently uses JSON mode)"
      });
    }

    const sizeMB =
      Buffer.byteLength(csvContent, "utf8") / (1024 * 1024);
    if (sizeMB > JSON_SIZE_LIMIT_MB) {
      // Protect the instance and give a clear message
      return res.status(413).json({
        error: `CSV file too large for JSON upload mode (${sizeMB.toFixed(
          1
        )} MB). Please reduce date range or switch to file upload endpoint /api/audit-upload.`
      });
    }

    let records;
    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true
      });
    } catch (csvErr) {
      console.error("CSV parse error (JSON mode):", csvErr);
      return res.status(400).json({
        error:
          "Failed to parse CSV content. Please ensure it's a valid Amazon CSV export."
      });
    }

    // For safety, only use up to e.g. 10k rows in JSON mode
    const MAX_ROWS_JSON_MODE = 10000;
    if (records.length > MAX_ROWS_JSON_MODE) {
      records = records.slice(0, MAX_ROWS_JSON_MODE);
    }

    const { claims, totalEstimatedValue, messages } =
      buildClaimsFromRecords(records);

    const summary = await maybeSummarizeWithOpenAI(
      claims,
      totalEstimatedValue,
      fileName
    );

    return res.status(200).json({
      claims,
      totalEstimatedValue,
      messages,
      summary,
      meta: {
        mode: "json",
        userId: userId || null,
        truncatedRows: records.length > MAX_ROWS_JSON_MODE
      }
    });
  } catch (err) {
    console.error("Unhandled /api/audit error:", err);
    return res.status(500).json({
      error: "Internal error while analyzing report."
    });
  }
});

/**
 * POST /api/audit-upload
 * multipart/form-data
 * Fields:
 *   - file: CSV file
 *   - fileName (optional)
 *   - userId  (optional)
 *
 * This is the **streaming** path for future very large files.
 */
app.post(
  "/api/audit-upload",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ error: "CSV file (field name 'file') is required." });
      }

      const filePath = req.file.path;
      const fileName = req.body.fileName || req.file.originalname;
      const userId = req.body.userId || null;

      const rows = [];
      let rowCount = 0;

      // Stream from disk to keep memory usage low
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csvStreamParser())
          .on("data", (row) => {
            rowCount++;
            if (rows.length < MAX_CLAIMS * 4) {
              // buffer enough rows to build claims, but don't keep everything
              rows.push(row);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      // Clean up the temp file
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("Failed to delete temp upload:", e);
      }

      if (rows.length === 0) {
        return res.status(200).json({
          claims: [],
          totalEstimatedValue: 0,
          messages: [],
          summary: null,
          meta: {
            mode: "upload",
            userId,
            rowCount: rowCount
          }
        });
      }

      const { claims, totalEstimatedValue, messages } =
        buildClaimsFromRecords(rows);

      const summary = await maybeSummarizeWithOpenAI(
        claims,
        totalEstimatedValue,
        fileName
      );

      return res.status(200).json({
        claims,
        totalEstimatedValue,
        messages,
        summary,
        meta: {
          mode: "upload",
          userId,
          rowCount
        }
      });
    } catch (err) {
      console.error("Unhandled /api/audit-upload error:", err);
      return res.status(500).json({
        error: "Internal error while analyzing uploaded CSV."
      });
    }
  }
);

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RefundHunter backend listening on port ${PORT}`);
});

