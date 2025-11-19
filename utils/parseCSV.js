// utils/parseCSV.js
// -----------------------------------
// RefundHunter CSV Preprocessor
// Normalizes CSV rows for Gemini audit
// -----------------------------------

export function preprocessCSV(csvContent) {
    if (!csvContent || typeof csvContent !== "string") {
        return { rows: [] };
    }

    const lines = csvContent.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim());

    const rows = lines.slice(1).map(line => {
        const values = line.split(",").map(v => v.trim());
        const obj = {};

        headers.forEach((h, i) => {
            obj[h] = values[i];
        });

        // Correct SKU variations
        const sku =
            obj.sku ||
            obj.SKU ||
            obj["sku-id"] ||
            obj["seller-sku"] ||
            obj["item-sku"] ||
            "";

        // Normalize reason fields
        const reason =
            obj.reason ||
            obj.disposition ||
            obj.researching ||
            obj["reason-code"] ||
            obj["claims-reason"] ||
            "Lost inventory";

        // FIX: Convert negative quantity to positive
        let quantity = parseInt(
            obj.quantity ||
            obj.qty ||
            obj["quantity-researched"] ||
            obj["adjusted-quantity"] ||
            1
        );

        if (isNaN(quantity)) quantity = 1;

        // 🔥 FIX: Amazon sometimes uses "-1" to represent 1 lost item
        quantity = Math.abs(quantity);

        // Now compute estimated value with the FIXED quantity
        const estimatedValue = Number(quantity * 8.5).toFixed(2);

        // Normalize transaction ID
        const amazonTransactionId =
            obj["reference-id"] ||
            obj["event-id"] ||
            obj["transaction-id"] ||
            obj["amazon-order-id"] ||
            "";

        return {
            sku: String(sku).trim(),
            reason: String(reason).trim(),
            quantity,
            estimatedValue: parseFloat(estimatedValue),
            amazonTransactionId: amazonTransactionId || "N/A"
        };
    });

    return { rows };
}
