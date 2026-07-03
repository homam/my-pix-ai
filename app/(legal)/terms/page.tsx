import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

const LAST_UPDATED = "July 3, 2026";

export const metadata: Metadata = {
  title: `Terms of Service — ${BRAND.name}`,
};

// Template terms. Every brand-variable value (service name, legal entity,
// contact, jurisdiction) comes from lib/brand.ts. Have a lawyer review the
// substance before launch — this covers the product mechanics (credits,
// uploads, AI output) but is not legal advice.
export default function TermsPage() {
  const { name, supportEmail, legal } = BRAND;
  return (
    <article className="legal-prose">
      <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
      <p className="text-gray-500">Last updated: {LAST_UPDATED}</p>

      <h2>1. Who we are</h2>
      <p>
        {name} is operated by {legal.companyName}
        {legal.address ? `, ${legal.address}` : ""} (&quot;we&quot;,
        &quot;us&quot;). These terms govern your use of the {name} website and
        services. By creating an account or using the service you agree to
        them.
      </p>

      <h2>2. The service</h2>
      <p>
        {name} lets you upload photos, train a personal AI model on your
        likeness, and generate AI images. Model training and image generation
        are performed by third-party AI infrastructure providers acting as our
        processors.
      </p>

      <h2>3. Your content</h2>
      <p>
        You keep all rights to the photos you upload and, to the extent
        permitted by law, to the images you generate. You grant us the limited
        rights needed to operate the service: storing your uploads, passing
        them to our AI providers for training and generation, and displaying
        results back to you. You must only upload photos of yourself or of
        people who have given you their explicit consent, and you must be at
        least 18 years old.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        You may not use {name} to create content that is unlawful, deceptive
        (including non-consensual impersonation), harassing, or sexually
        explicit involving real people without their consent. We may suspend
        or terminate accounts that violate this section.
      </p>

      <h2>5. Credits and payments</h2>
      <p>
        The service is prepaid: you buy credit packs (one-time purchases, not
        subscriptions) and spend credits on training and generation. Credits
        are not redeemable for cash. If a training job fails, the credits it
        consumed are automatically refunded to your balance. For anything else,
        contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and
        we&apos;ll make it right where we reasonably can.
      </p>

      <h2>6. AI output</h2>
      <p>
        Generated images are produced by machine-learning models and may be
        inaccurate or unflattering. You are responsible for how you use them,
        including compliance with any disclosure rules that apply to synthetic
        media in your jurisdiction.
      </p>

      <h2>7. Termination and data deletion</h2>
      <p>
        You can delete your account at any time from the account page; this
        removes your uploads, trained models, and generated images. We may
        terminate accounts for breach of these terms, refunding unused paid
        credits unless the breach was willful.
      </p>

      <h2>8. Liability</h2>
      <p>
        The service is provided &quot;as is&quot;. To the maximum extent
        permitted by law, our total liability for any claim arising out of the
        service is limited to the amount you paid us in the twelve months
        before the claim.
      </p>

      {legal.jurisdiction && (
        <>
          <h2>9. Governing law</h2>
          <p>
            These terms are governed by the laws of {legal.jurisdiction},
            without regard to conflict-of-law rules.
          </p>
        </>
      )}

      <h2>{legal.jurisdiction ? "10" : "9"}. Contact</h2>
      <p>
        Questions about these terms:{" "}
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>
    </article>
  );
}
