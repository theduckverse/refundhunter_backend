import Papa from "papaparse";

export function preprocessCSV(raw) {
    // Try both comma and tab separated
    const parsed = Papa.parse(raw, {
        delimiter: "",   // autoguess
        header: true,
        skipEmptyLines: true
    });

    if (!parsed.data || parsed.data.length === 0) {
        return { rows: [], message: "No valid rows found" };
    }

    const rows = parsed.data;

    // Normalize headers
    const normalizeKey = (key) => {
        return key
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/-/g, "_");
    };

    // Map each row to normalized keys
    const normalized = rows.map(row => {
        const clean = {};
        Object.keys(row).forEach(key => {
            clean[normalizeKey(key)] = row[key];
        });
        return clean;
    });

    // Filter ONLY rows relevant to reimbursement
    const reimbursementReasons = [
        "lost",
        "missing",
        "damaged",
        "warehouse",
        "dispose",
        "defective",
        "destroy",
        "mismatch",
        "misplaced",
        "not returned",
        "customer_return",
        "adjustment",
        "missing_from_inventory"
    ];

    const relevant = normalized.filter(row => {
        const reason = String(row.adjustment_reason || row.reason || "").toLowerCase();
        const qty = parseFloat(row.quantity || row.qty || row.adjusted_quantity || 0);

        return (
            reimbursementReasons.some(r => reason.includes(r)) &&
            qty !== 0
        );
    });

    // Convert negative quantities to absolute
    const cleaned = relevant.map(r => {
        const quantity = Math.abs(parseFloat(
            r.quantity || r.qty || r.adjusted_quantity || 0
        ));

        return {
            sku: r.sku || r.product_code || r.fnsku || "UNKNOWN",
            reason: r.adjustment_reason || r.reason || "Unknown",
            quantity
        };
    });

    return {
        rows: cleaned,
        message: `Extracted ${cleaned.length} relevant rows`
    };
}
