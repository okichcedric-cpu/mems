import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { settleOrder } from "../_shared/marketplaceOrders.ts";

// Pesapal IPN for marketplace orders (GET). Public by necessity, so it
// trusts nothing in the request: settleOrder() asks Pesapal for the real
// transaction status and checks it against our own order record.
serve(async (req) => {
  try {
    const url = new URL(req.url);
    const orderTrackingId = url.searchParams.get("OrderTrackingId");
    const merchantReference = url.searchParams.get("OrderMerchantReference");
    if (!orderTrackingId) return new Response("Missing params", { status: 400 });

    const result = await settleOrder(orderTrackingId, merchantReference);
    console.log(`marketplace-webhook ${merchantReference}: ${result.status}`);
    // Always 200 so Pesapal doesn't retry forever.
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("marketplace-webhook error:", (e as Error).message);
    return new Response("OK", { status: 200 });
  }
});
