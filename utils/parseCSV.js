// utils/parseCSV.js
// -------------------------------
// RefundHunter CSV Preprocessor
// Normalizes CSV rows for Gemini audit
// -------------------------------

export function preprocessCSV(csvContent) {
    if (!csvContent || typeof csvContent !== "string") {
        return { rows: [] };
    }

    // Split lines and extract headers
    const lines = csvContent.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim());

    // Convert CSV lines into structured row objects
    const rows = lines.slice(1).map(line => {
        const values = line.split(",").map(v => v.trim());
        const obj = {};

        headers.forEach((h, i) => {
            obj[h] = values[i];
        });

        // Normalize possible header variations across Amazon inventory reports
        const sku =
            obj.sku ||
            obj.SKU ||
            obj["sku-id"] ||
            obj["seller-sku"] ||
            obj["item-sku"] ||
            "";

        const reason =
            obj.reason ||
            obj["disposition"] ||
            obj["researching"] ||
            obj["reason-code"] ||
            obj["claims-reason"] ||
            "Lost inventory";

        const quantity = parseInt(
            obj.quantity ||
            obj.qty ||
            obj["quantity-researched"] ||
            obj["adjusted-quantity"] ||
            1
        );

        // Estimated reimbursement calculation
        // (Simple model — can be upgraded later)
        const estimatedValue = Number(quantity * 8.5).toFixed(2);

        const amazonTransactionId =
            obj["reference-id"] ||
            obj["event-id"] ||
            obj["transaction-id"] ||
            obj["amazon-order-id"] ||
            "";

        return {
            sku: String(sku).trim(),
            reason: String(reason).trim(),
            quantity: quantity || 1,
            estimatedValue: parseFloat(estimatedValue),
            amazonTransactionId: amazonTransactionId || "N/A"
        };
    });

    return { rows };
}
