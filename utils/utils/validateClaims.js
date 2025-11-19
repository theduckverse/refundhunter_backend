export default function validateClaims(claims) {
    if (!Array.isArray(claims)) return [];

    return claims.filter(c => {
        return (
            typeof c.sku === "string" &&
            typeof c.reason === "string" &&
            typeof c.quantity === "number" &&
            typeof c.estimatedValue === "number" &&
            c.quantity > 0 &&
            c.estimatedValue >= 0
        );
    });
}
