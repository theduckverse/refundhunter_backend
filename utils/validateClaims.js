export function validateClaims(claims) {
    if (!Array.isArray(claims)) return [];

    return claims
        .filter((claim) => {
            return (
                claim &&
                claim.sku &&
                claim.claimReason &&
                claim.estimatedValue &&
                !isNaN(parseFloat(claim.estimatedValue))
            );
        })
        .map((claim) => ({
            sku: claim.sku.trim(),
            claimReason: claim.claimReason.trim(),
            estimatedValue: parseFloat(claim.estimatedValue),
            quantity: claim.quantity || 1,
            amazonTransactionId: claim.amazonTransactionId || "N/A",
        }));
}
