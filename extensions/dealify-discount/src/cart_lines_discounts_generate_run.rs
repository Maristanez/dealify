use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct AgreedLine {
    variant_id: String,
    quantity: i32,
    unit_price: i64,
}

#[derive(Deserialize, Default, PartialEq)]
pub struct Configuration {
    currency: String,
    total: i64,
    lines: Vec<AgreedLine>,
}

fn cents(amount: &Decimal) -> Option<i64> {
    let scaled = amount.0 * 100.0;
    if !scaled.is_finite() || scaled < 0.0 || scaled > 1_000_000_000.0 || (scaled - scaled.round()).abs() > 0.00001 {
        return None;
    }
    Some(scaled.round() as i64)
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let none = || Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    if !input.discount().discount_classes().contains(&schema::DiscountClass::Order) { return none(); }
    let config: &Configuration = match input.discount().metafield() {
        Some(value) => value.json_value(),
        None => return none(),
    };
    // The initial pilot prices CAD, one-time, ordinary variants only.
    if config.currency != "CAD" || config.total <= 0 || config.lines.is_empty() || config.lines.len() > 20 { return none(); }
    let cart = input.cart().lines();
    if cart.len() != config.lines.len() { return none(); }
    let mut used = vec![false; config.lines.len()];
    let mut subtotal: i64 = 0;
    for line in cart {
        if line.selling_plan_allocation().is_some() || line.parent_relationship().is_some() { return none(); }
        let variant = match line.merchandise() {
            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(value) => value,
            _ => return none(),
        };
        let index = match config.lines.iter().position(|expected| expected.variant_id == *variant.id()) {
            Some(index) => index,
            None => return none(),
        };
        let expected = &config.lines[index];
        if used[index] || expected.quantity < 1 || expected.quantity > 10 || *line.quantity() != expected.quantity || expected.unit_price <= 0 { return none(); }
        used[index] = true;
        let cost = line.cost();
        if cost.amount_per_quantity().currency_code() != &config.currency || cost.subtotal_amount().currency_code() != &config.currency { return none(); }
        if cents(cost.amount_per_quantity().amount()) != Some(expected.unit_price) { return none(); }
        let line_total = match expected.unit_price.checked_mul(i64::from(expected.quantity)) { Some(value) => value, None => return none() };
        if cents(cost.subtotal_amount().amount()) != Some(line_total) { return none(); }
        subtotal = match subtotal.checked_add(line_total) { Some(value) => value, None => return none() };
    }
    if config.total >= subtotal { return none(); }
    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::OrderDiscountsAdd(schema::OrderDiscountsAddOperation {
            selection_strategy: schema::OrderDiscountSelectionStrategy::First,
            candidates: vec![schema::OrderDiscountCandidate {
                targets: vec![schema::OrderDiscountCandidateTarget::OrderSubtotal(schema::OrderSubtotalTarget { excluded_cart_line_ids: vec![] })],
                message: Some("Dealify agreed offer".to_string()),
                value: schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount { amount: Decimal((subtotal - config.total) as f64 / 100.0) }),
                conditions: None,
                associated_discount_code: None,
            }],
        })],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    const INPUT: &str = r#"{
      "cart":{"lines":[
        {"id":"gid://shopify/CartLine/1","quantity":1,"sellingPlanAllocation":null,"parentRelationship":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"},"cost":{"amountPerQuantity":{"amount":"100.00","currencyCode":"CAD"},"subtotalAmount":{"amount":"100.00","currencyCode":"CAD"}}},
        {"id":"gid://shopify/CartLine/2","quantity":1,"sellingPlanAllocation":null,"parentRelationship":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/2"},"cost":{"amountPerQuantity":{"amount":"40.00","currencyCode":"CAD"},"subtotalAmount":{"amount":"40.00","currencyCode":"CAD"}}}
      ]},
      "discount":{"discountClasses":["ORDER"],"metafield":{"jsonValue":{"currency":"CAD","total":11000,"lines":[{"variantId":"gid://shopify/ProductVariant/1","quantity":1,"unitPrice":10000},{"variantId":"gid://shopify/ProductVariant/2","quantity":1,"unitPrice":4000}]}}}
    }"#;

    #[test]
    fn grants_exactly_the_agreed_basket_discount() -> Result<()> {
        let result = run_function_with_input(cart_lines_discounts_generate_run, INPUT)?;
        assert_eq!(result.operations, vec![schema::CartOperation::OrderDiscountsAdd(schema::OrderDiscountsAddOperation {
            selection_strategy: schema::OrderDiscountSelectionStrategy::First,
            candidates: vec![schema::OrderDiscountCandidate {
                targets: vec![schema::OrderDiscountCandidateTarget::OrderSubtotal(schema::OrderSubtotalTarget { excluded_cart_line_ids: vec![] })],
                message: Some("Dealify agreed offer".to_string()),
                value: schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount { amount: Decimal(30.0) }),
                conditions: None, associated_discount_code: None,
            }],
        })]);
        Ok(())
    }
}
