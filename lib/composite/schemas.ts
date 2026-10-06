// Request bodies of the /api/composites routes.

import { z } from "zod";
import { ACCEPTED_PHOTO_TYPES, ACCEPTED_VIDEO_TYPES } from "@/lib/composite/config";
import { COMPOSITE_ASPECTS } from "@/lib/composite/types";

const settings = {
  scenePriority: z.string().trim().max(500).nullable().optional(),
  mustPreserve: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  style: z.enum(["faithful", "polished"]).optional(),
  aspectRatio: z.enum(COMPOSITE_ASPECTS as [string, ...string[]]).optional(),
};

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ...settings,
});

export const patchGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ...settings,
  anchorSourceId: z.string().uuid().nullable().optional(),
  selection: z
    .array(z.object({ id: z.string().uuid(), selected: z.boolean(), pinned: z.boolean().optional() }))
    .max(200)
    .optional(),
  removeSourceIds: z.array(z.string().uuid()).max(200).optional(),
});

const hash = z.string().regex(/^[0-9a-f]{16}$/);

const common = {
  clientId: z.string().min(1).max(64),
  originalName: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive(),
  sequence: z.number().int().min(0).max(10_000),
  selected: z.boolean().optional(),
  pinned: z.boolean().optional(),
};

export const registerSourcesSchema = z.object({
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("photo"),
          ...common,
          mimeType: z.enum(ACCEPTED_PHOTO_TYPES),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          sharpness: z.number().nonnegative().nullable().optional(),
          phash: hash.nullable().optional(),
        }),
        z.object({
          kind: z.literal("video"),
          ...common,
          mimeType: z.enum(ACCEPTED_VIDEO_TYPES),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          durationS: z.number().positive(),
        }),
        z.object({
          kind: z.literal("frame"),
          ...common,
          mimeType: z.literal("image/jpeg"),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          frameTimeS: z.number().min(0),
          // The video it came from: in this same batch, or already registered.
          parentClientId: z.string().min(1).max(64).optional(),
          parentSourceId: z.string().uuid().optional(),
          sharpness: z.number().nonnegative().nullable().optional(),
          phash: hash.nullable().optional(),
        }),
      ])
    )
    .min(1)
    .max(80),
});
export type RegisterSourceInput = z.infer<typeof registerSourcesSchema>["sources"][number];

export const completeSourcesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const renderSchema = z.object({ idempotencyKey });

const unit = z.number().min(0).max(1);
export const correctSchema = z
  .object({
    idempotencyKey,
    instruction: z.string().trim().min(3).max(1000),
    mode: z.enum(["text", "area", "move"]),
    marks: z
      .object({
        what: z.object({ x: unit, y: unit, r: z.number().min(0.01).max(0.25) }).optional(),
        where: z.object({ x: unit, y: unit }).optional(),
      })
      .nullable()
      .optional(),
    evidenceSourceIds: z.array(z.string().uuid()).max(5).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode !== "text" && !v.marks?.what) {
      ctx.addIssue({ code: "custom", message: "mark the area on the image first", path: ["marks", "what"] });
    }
    if (v.mode === "move" && !v.marks?.where) {
      ctx.addIssue({ code: "custom", message: "mark where it should go", path: ["marks", "where"] });
    }
  });
