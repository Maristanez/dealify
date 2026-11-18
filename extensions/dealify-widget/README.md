# Dealify app embed

Enable the Dealify shopkeeper in the theme editor from the embedded app's setup link. The embed appears on product pages, uses Shopify's signed app proxy, and makes no API request until the shopper opens it. It does not edit theme source or use third-party scripts/fonts.

The widget exposes variant and quantity selection, safe text replies, the exact offered basket, explicit acceptance, owner-approval updates and conversation deletion. Payment stays in Shopify Checkout. Only CAD is supported in this pilot. A full-price basket explicitly has no price hold. Messages are scoped in shadow DOM; dynamic content is inserted as text.

Run `node node_modules/vitest/vitest.mjs run apps/web/src/widget.test.ts` for public behavior tests. Live theme compatibility, mobile rendering, accessibility and performance still need development-store acceptance.
