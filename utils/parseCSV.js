// utils/parseCSV.js
// Preprocess a LARGE Amazon FBA Inventory-style CSV into a small, AI-friendly set of rows.

export function preprocessCSV(csvText) {
  if (!csvText || typeof csvText !== "string") {
    return { rows: [] };
  }

  // Split into lines, drop empty ones
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [] };
  }

  // --- HEADER PARSING ---
  const rawHeaders = splitCsvLine(lines[0]);
  const headers = rawHeaders.map((h) => h.trim().toLowerCase());

  // helper to find column index by possible names
  const findCol = (candidates) => {
    for (const cand of candidates) {
      const idx = headers.findIndex((h) => h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  // Common Inventory Ledger / Adjustments / Inventory History column names
  const idxSku = findCol(["seller sku", "seller_sku", "sku", "product sku", "asin"]);
  const idxQty = findCol([
    "quantity",
    "qty",
    "quantity-change",
    "quantity change",
    "quantity adjusted",
    "quantity adjusted",
  ]);
  const idxReason = findCol([
    "reason",
    "event type",
    "event-type",
    "event code",
    "adjustment type",
    "adjustment-type",
    "disposition",
    "memo",
  ]);
  const idxRef = findCol(["reference id", "reference-id", "transaction id", "id", "event id"]);

  const interestingRows = [];
  const MAX_ROWS_FOR_AI = 400; // safety cap so Gemini never chokes

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cells = splitCsvLine(line);
    const sku = safeCell(cells, idxSku);
    const qtyStr = safeCell(cells, idxQty);
    const reason = safeCell(cells, idxReason);
    const referenceId = safeCell(cells, idxRef);

    const qty = parseFloat(qtyStr || "0") || 0;
    const reasonLower = (reason || "").toLowerCase();

    // --- HEURISTICS: what looks like a reimbursement-worthy event? ---
    const looksLikeLossOrDamage =
      qty < 0 ||
      /lost|missing|damaged|warehouse|dispose|scrap|found|unfound|reimburs|claim/.test(
        reasonLower
      );

    if (!looksLikeLossOrDamage) {
      continue; // skip boring rows
    }

    interestingRows.push({
      sku,
      quantity: qty,
      reason,
      referenceId,
      rawReason: reason, // keep original just in case
    });

    if (interestingRows.length >= MAX_ROWS_FOR_AI) {
      break; // stop once we have enough candidates
    }
  }

  return { rows: interestingRows };
}

// --- Helper functions ---

function safeCell(cells, idx) {
  if (idx < 0 || idx >= cells.length) return "";
  // Strip surrounding quotes and trim
  return String(cells[idx]).replace(/^"|"$/g, "").trim();
}

/**
 * Robust CSV line splitter that respects quoted fields.
 * Handles commas inside quotes and double-quote escaping.
 */
function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // Escaped quote ("")
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip second quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
}
