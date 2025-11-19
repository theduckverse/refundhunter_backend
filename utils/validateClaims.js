export function validateClaims(rows) {
    if (!Array.isArray(rows)) return [];

    const claims = [];

    for (const row of rows) {
        if (!row) continue;

        const sku = row.sku?.trim();
        const qty = parseFloat(row.quantity);
        const unitCost = parseFloat(row["unit-cost"]);
        const eventType = row["transaction-type"]?.trim();
        const disposition = row.disposition?.trim();
        const reasonCode = row.reason?.trim();
        const refId = row["reference-id"] || "N/A";

        // Must have SKU + valid numbers
        if (!sku || isNaN(qty) || isNaN(unitCost)) continue;

        // Ignore positive "Found" quantities
        if (qty > 0) continue;

        // Our triggers for claims:
        let detectedReason = null;

        // LOSS PATTERNS
        if (qty < 0 && disposition === "SELLABLE") {
            detectedReason = "Lost Inventory";
        }
        else if (qty < 0 && disposition !== "SELLABLE") {
            detectedReason = "Damaged Inventory";
        }
        else if (eventType === "Adjustments" && qty < 0) {
            detectedReason = "Unexplained Adjustment Loss";
        }

        if (!detectedReason) continue;

        // Build claim object
        claims.push({
            sku,
            claimReason: detectedReason,
            quantity: Math.abs(qty),
            estimatedValue: Math.abs(qty * unitCost),
            amazonTransactionId: refId,
        });
    }

    return claims;
}

