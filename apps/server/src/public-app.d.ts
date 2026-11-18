import type { Server } from "node:http";
export function createPublicApp(options?: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }): {
  app: { listen(port: number, host?: string): Server };
  shopify: unknown;
  drain(): void;
  close(): Promise<void>;
};
