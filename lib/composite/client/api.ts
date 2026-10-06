"use client";

// Typed fetch wrappers for the /api/composites routes. Every failure throws an
// Error carrying the server's message — never a silent empty result.

import type { ExportPlan } from "@/lib/composite/dimensions";
import type { CompositeGroup, CompositeSource, CompositeVersion, CorrectionMarks, CorrectionMode } from "@/lib/composite/types";
import type { GroupView, PublicJob } from "@/lib/composite/view";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  return body as T;
}

export interface UploadSlotDto {
  clientId: string;
  id: string;
  original?: { path: string; token: string };
  reference?: { path: string; token: string };
}

export type VersionDto = CompositeVersion & { previewUrl: string | null; plan: ExportPlan };

export const composeApi = {
  createGroup: (body: Record<string, unknown>) =>
    call<{ group: CompositeGroup }>("/api/composites", { method: "POST", body: JSON.stringify(body) }),
  getGroup: (id: string) => call<GroupView>(`/api/composites/${id}`),
  patchGroup: (id: string, body: Record<string, unknown>) =>
    call<GroupView>(`/api/composites/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGroup: (id: string) => call<{ ok: true }>(`/api/composites/${id}`, { method: "DELETE" }),
  registerSources: (id: string, sources: Record<string, unknown>[]) =>
    call<{ sources: CompositeSource[]; uploads: UploadSlotDto[] }>(`/api/composites/${id}/sources`, {
      method: "POST",
      body: JSON.stringify({ sources }),
    }),
  completeSources: (id: string, ids: string[]) =>
    call<{ status: string; missing: string[] }>(`/api/composites/${id}/sources/complete`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  render: (id: string, idempotencyKey: string) =>
    call<{ job: PublicJob; duplicate: boolean }>(`/api/composites/${id}/render`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey }),
    }),
  correct: (
    versionId: string,
    body: {
      idempotencyKey: string;
      instruction: string;
      mode: CorrectionMode;
      marks?: CorrectionMarks | null;
      evidenceSourceIds?: string[];
    }
  ) =>
    call<{ job: PublicJob; duplicate: boolean }>(`/api/composites/versions/${versionId}/correct`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  job: (id: string) => call<{ job: PublicJob; version: VersionDto | null }>(`/api/composites/jobs/${id}`),
  cancel: (id: string) => call<{ job: PublicJob }>(`/api/composites/jobs/${id}`, { method: "DELETE" }),
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function versionMediaUrl(
  versionId: string,
  variant: "preview" | "native" | "upscaled",
  download = false
): string {
  return `/api/composites/media/version/${versionId}?variant=${variant}${download ? "&download=1" : ""}`;
}
