import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

const LAST_UPDATED = "July 3, 2026";

export const metadata: Metadata = {
  title: `Privacy Policy — ${BRAND.name}`,
};

// Template privacy policy. Brand-variable values come from lib/brand.ts.
// Have a lawyer review before launch — this describes the actual data flows
// (Supabase storage, AI training providers, Stripe, transactional email) but
// is not legal advice.
export default function PrivacyPage() {
  const { name, supportEmail, legal } = BRAND;
  return (
    <article className="legal-prose">
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-gray-500">Last updated: {LAST_UPDATED}</p>

      <h2>1. Who is responsible</h2>
      <p>
        {legal.companyName}
        {legal.address ? `, ${legal.address}` : ""} operates {name} and is the
        controller of the personal data described here. Contact:{" "}
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> — your email address (we use
          passwordless magic-link login, so there is no password).
        </li>
        <li>
          <strong>Photos you upload</strong> — used solely to train your
          personal AI model and to perform edits you request.
        </li>
        <li>
          <strong>Generated images and prompts</strong> — stored so you can
          revisit and manage your library.
        </li>
        <li>
          <strong>Purchase records</strong> — credit balance and transaction
          history. Card details are handled by our payment processor and never
          touch our servers.
        </li>
      </ul>

      <h2>3. How your photos are used</h2>
      <p>
        Your photos train a model that only your account can use. We never use
        your photos or your trained model to build shared or third-party
        models, and we never sell your data.
      </p>

      <h2>4. Processors</h2>
      <p>
        We share data with the vendors required to run the service: cloud
        database and file storage, AI training and image-generation
        infrastructure, a payment processor for purchases, and a transactional
        email provider for service notifications. Each acts under contract as
        our processor and only receives what its function requires.
      </p>

      <h2>5. Retention and deletion</h2>
      <p>
        Your data is kept while your account is active. Deleting a model
        deletes its training photos and generated images; deleting your
        account (available on the account page) removes your uploads, models,
        images, and profile. Purchase records may be retained where bookkeeping
        law requires.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        export, or erase your personal data, and to object to processing.
        Write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we
        will respond within the legally required time.
      </p>

      <h2>7. Changes</h2>
      <p>
        We will post any changes to this policy on this page and update the
        date above. Material changes will be announced by email.
      </p>
    </article>
  );
}
