import type { Settlement } from "@bazaar/contracts";
import type { PublicStore } from "./infra/public-store.js";

type Context = { store: PublicStore; shop: string; apiKey?: string; graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> };
type Offer = { offerId: string; total: number; expiresAt: Date; items: { variantId: string; qty?: number; list: number }[] };
export const FIND_DISCOUNT: string;
export const CREATE_DISCOUNT: string;
export const CONFIGURE_DISCOUNT: string;
export const DEACTIVATE_DISCOUNT: string;
export function mintPublicDiscount(context: Context & { apiKey: string }, offer: Offer): Promise<Settlement & { discountId?: string }>;
export function revokePublicDiscount(context: Context, offerId: string): Promise<void>;
export function retryPublicRevocations(context: Context): Promise<void>;
