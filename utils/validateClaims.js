export function validateClaims(claims) {
    if (!Array.isArray(claims)) return [];

    return claims
        .filter((claim) => {
            return (
                claim &&
                claim.sku &&
                (claim.claimReason || claim.reason) &&
                claim.quantity &&
                claim.estimatedValue &&
                !isNaN(parseFloat(claim.estimatedValue))
            );
        })
        .map((claim) => ({
            sku: claim.sku.trim(),
            claimReason: (claim.claimReason || claim.reason).trim(),
            estimatedValue: parseFloat(claim.estimatedValue),
            quantity: claim.quantity || 1,
            amazonTransactionId: claim.amazonTransactionId || "N/A",
        }));
}
