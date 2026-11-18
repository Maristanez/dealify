# Dealify exact-basket discount

Shopify Function API 2026-10, `cart.lines.discounts.generate.run`. The server creates a single-use, non-combinable code with a native expiry and an app-owned `offer` JSON metafield. The Function grants the difference between the original subtotal and the agreed total only when every variant, quantity, original price and CAD currency matches. Added/removed lines, subscriptions and nested lines receive no discount.

Build and exercise the compiled WASM with `node scripts/test-discount.mjs` from the repository root. Rust with the `wasm32-unknown-unknown` target and Shopify CLI are required. The fixtures include one valid basket and its reordered equivalent, then attempts to alter its terms. The tests do not prove a live Shopify checkout or payment.

Ordinary one-time products in CAD are the initial pilot scope. Server eligibility excludes gift cards, required selling plans and component bundles. The app still needs installation and checkout testing on a development store before release.
