import Stripe from "stripe";

// AWS Lambda reuses warm containers across invocations. Caching the Stripe
// client at module scope means we only pay the construction cost on a cold
// start, not on every request.
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to the Lambda environment variables."
    );
  }

  cached = new Stripe(key, {
    // Pin to the SDK's default API version. Upgrading the SDK is what
    // bumps this; we don't override it here.
    apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
    // Lambda already retries failed invocations; let the API fail fast.
    maxNetworkRetries: 1,
    timeout: 20_000,
    appInfo: {
      name: "DentiPal",
      version: "1.0.0",
    },
  });

  return cached;
}
