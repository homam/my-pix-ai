import Stripe from "stripe";
import { CREDIT_PACKS } from "@/types";

// Stripe is optional. Consumers must check `isStripeConfigured()` first, or
// handle the `StripeNotConfiguredError` thrown by helpers below.

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured (STRIPE_SECRET_KEY is missing)");
    this.name = "StripeNotConfiguredError";
  }
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!isStripeConfigured()) throw new StripeNotConfiguredError();
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2025-02-24.acacia",
    });
  }
  return _stripe;
}

export async function createCheckoutSession(
  packId: string,
  userId: string,
  userEmail: string
): Promise<string> {
  const stripe = getStripe();

  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error("Invalid pack");

  const priceId = process.env[pack.priceId];
  if (!priceId) throw new Error(`Missing env var ${pack.priceId}`);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      userId,
      packId,
      credits: pack.credits.toString(),
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?payment=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
  });

  return session.url!;
}

export async function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
) {
  const stripe = getStripe();
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}
