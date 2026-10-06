import { notFound, redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getBalance } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { composeClientConfig } from "@/lib/composite/config";
import { loadGroupView } from "@/lib/composite/view";
import { CompositeProject } from "@/components/studio/compose/CompositeProject";

// One composite project: its versions (with lineage and review), the sources
// they were made from, downloads, and the correction form.

export default async function CompositePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();

  const serviceClient = await createServiceClient();
  const [view, balance] = await Promise.all([
    loadGroupView(supabase, serviceClient, user.id, id),
    getBalance(serviceClient, user.id),
  ]);
  if (!view) notFound();

  return (
    <div className="p-8 max-w-6xl">
      <CompositeProject
        initial={view}
        config={composeClientConfig(CREDIT_COSTS.COMPOSITE)}
        creditBalance={balance}
        initialVersion={v ? Number(v) : undefined}
      />
    </div>
  );
}
