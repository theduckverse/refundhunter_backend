export function validateClaims(rawClaims) {
    if (!Array.isArray(rawClaims)) return [];

    const cleanClaims = [];

    for (const c of rawClaims) {
        if (!c) continue;

        const sku = (c.sku || "").toString().trim();
        const reason = (c.reason || "").toString().trim();
        const qty = Number(c.quantity);
        const est = Number(c.estimatedValue);

        // Required fields
        if (!sku || !reason) continue;

        // Quantity must be > 0
        if (!qty || qty <= 0 || isNaN(qty)) continue;

        // Estimated value must be numeric
        if (!est || est <= 0 || isNaN(est)) continue;

        cleanClaims.push({
            sku,
            reason,
            quantity: qty,
            estimatedValue: Number(est.toFixed(2))
        });
    }

    return cleanClaims;
}
