import type { Session } from "@shopify/shopify-api";

export interface PublicStore {
  get<T = unknown>(shop: string, kind: string, id?: string): T | undefined;
  set(shop: string, kind: string, id: string, value: unknown, expires?: number | null): void;
  list<T = unknown>(shop: string, kind: string): T[];
  shops(kind: string): string[];
  entries<T = unknown>(shop: string, kind: string): { id: string; value: T }[];
  remove(shop: string, kind: string, id: string): void;
  removeKind(shop: string, kind: string): void;
  removeShop(shop: string): void;
  prune(): void;
  close(): void;
  sessionStorage: {
    storeSession(session: Session): Promise<boolean>;
    loadSession(id: string): Promise<Session | undefined>;
    deleteSession(id: string): Promise<boolean>;
    deleteSessions(ids: string[]): Promise<boolean>;
    findSessionsByShop(shop: string): Promise<Session[]>;
  };
}
export function createPublicStore(options: { path: string; encryptionKey: string }): PublicStore;
