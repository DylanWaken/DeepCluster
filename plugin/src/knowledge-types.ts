/** Workspace knowledge revisions selected explicitly by the supervising client. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { OperationId } from './api-types.ts'

/** Stable caller-generated identity, retained across compare-and-swap revisions. */
export type KnowledgeRecordId = Branded<'DeepClusterKnowledgeRecordId'>

const idSchema = z.uuid().transform(value => value.toLowerCase() as KnowledgeRecordId)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1)

/** Exact immutable document revision requested at run admission. */
export const knowledgeReferenceSchema = z.strictObject({ id: idSchema, revision })
/** Exact immutable document revision requested at run admission. */
export type KnowledgeReference = z.infer<typeof knowledgeReferenceSchema>

/** Logged task evidence cited by a proposed lesson; a citation does not validate the lesson. */
export const knowledgeEvidenceSchema = z.strictObject({
  operationId: z.uuid().transform(value => value as OperationId), stepId: text.optional(),
})
/** Logged task evidence cited by a proposed lesson. */
export type KnowledgeEvidence = z.infer<typeof knowledgeEvidenceSchema>

/** Declarative checks on selected plans; these fields neither grant permissions nor execute callbacks. */
export const knowledgeConstraintsSchema = z.strictObject({
  requireReviewAfterWrites: z.array(z.enum(['reviewer', 'tester'])).min(1).max(2)
    .refine(roles => new Set(roles).size === roles.length, 'review roles must be unique').optional(),
  requiredAcceptanceLabels: z.array(text).min(1)
    .refine(labels => new Set(labels).size === labels.length, 'acceptance labels must be unique').optional(),
}).refine(value => value.requiredAcceptanceLabels === undefined || value.requireReviewAfterWrites !== undefined,
  'required acceptance labels require downstream review roles')
/** Declarative checks on selected plans. */
export type KnowledgeConstraints = z.infer<typeof knowledgeConstraintsSchema>

const content = { id: idSchema, title: text, body: z.string().min(1) }
const history = { ...content, version: z.literal(1), revision,
  previousRevision: revision.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }

/** Persisted and admitted revision, including its complete evidence and lifecycle fields. */
export const knowledgeRevisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...history, kind: z.literal('document') }),
  z.strictObject({ ...history, kind: z.literal('lesson'), evidence: z.array(knowledgeEvidenceSchema).min(1) }),
  z.strictObject({ ...history, kind: z.literal('protocol'), state: z.enum(['proposed', 'adopted', 'retired']),
    constraints: knowledgeConstraintsSchema.optional() }),
]).refine(value => value.previousRevision === (value.revision === 1 ? null : value.revision - 1),
  'knowledge revision must identify its immediate predecessor')
/** Complete immutable record revision. */
export type KnowledgeRevision = z.infer<typeof knowledgeRevisionSchema>
/** Complete revision retained at admission; later edits and retirement do not change this value. */
export type KnowledgeSnapshot = KnowledgeRevision

const expectedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
/** Full content replacement with mandatory compare-and-swap revision; zero creates a caller-chosen ID. */
export const knowledgeWriteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...content, expectedRevision, kind: z.literal('document') }),
  z.strictObject({ ...content, expectedRevision, kind: z.literal('lesson'), evidence: z.array(knowledgeEvidenceSchema).min(1) }),
  z.strictObject({ ...content, expectedRevision, kind: z.literal('protocol'), constraints: knowledgeConstraintsSchema.optional() }),
])
/** Full content replacement; protocol content writes always create a proposed revision. */
export type KnowledgeWrite = z.infer<typeof knowledgeWriteSchema>
/** Explicit supervisor lifecycle change; it is a workflow decision, not authenticated authorization. */
export const knowledgeTransitionSchema = z.strictObject({ expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
  state: z.enum(['adopted', 'retired']) })
/** Explicit compare-and-swap protocol lifecycle change. */
export type KnowledgeTransition = z.infer<typeof knowledgeTransitionSchema>

/** Deployment-owned admission limits; retained history remains readable after limits are reduced. */
export interface KnowledgeLimits {
  readonly maxRecords: number
  readonly maxBodyBytes: number
  readonly maxReferences: number
  readonly maxSnapshotBytes: number
}

/** Typed state, validation, and conflict failure adapted by the HTTP owner. */
export class KnowledgeStoreError extends Error {
  override readonly name = 'KnowledgeStoreError'

  /**
   * @param status - HTTP classification consumed by the API adapter.
   * @param code - stable failure category.
   * @param message - affected knowledge and required correction.
   * @param options - original parser or storage error.
   */
  constructor(readonly status: 400 | 404 | 409 | 413 | 503,
    readonly code: 'knowledge-invalid' | 'knowledge-not-found' | 'knowledge-conflict' | 'knowledge-limit' | 'knowledge-state',
    message: string, options?: ErrorOptions) { super(message, options) }
}

/**
 * Validate a wire content mutation against the deployment's text and reference budgets.
 * @param value - untrusted request JSON.
 * @param limits - configured store and admission bounds.
 * @returns complete validated replacement input.
 */
export function resolveKnowledgeWrite(value: unknown, limits: KnowledgeLimits): KnowledgeWrite {
  const parsed = knowledgeWriteSchema.safeParse(value)
  if (!parsed.success) throw new KnowledgeStoreError(400, 'knowledge-invalid', 'Invalid knowledge content or expected revision.', { cause: parsed.error })
  const record = parsed.data
  assertKnowledgeLimits(record, limits)
  return record
}

/**
 * Validate a supervisor lifecycle decision from wire JSON.
 * @param value - untrusted request JSON.
 * @returns the compare-and-swap lifecycle transition.
 */
export function resolveKnowledgeTransition(value: unknown): KnowledgeTransition {
  const parsed = knowledgeTransitionSchema.safeParse(value)
  if (!parsed.success) throw new KnowledgeStoreError(400, 'knowledge-invalid', 'Invalid protocol transition or expected revision.', { cause: parsed.error })
  return parsed.data
}

/**
 * Apply deployment limits without changing or truncating knowledge content.
 * @param record - validated mutation or complete revision.
 * @param limits - deployment-owned content and reference budgets.
 */
export function assertKnowledgeLimits(record: KnowledgeWrite | KnowledgeRevision, limits: KnowledgeLimits): void {
  if (Buffer.byteLength(record.body, 'utf8') > limits.maxBodyBytes || Buffer.byteLength(record.title, 'utf8') > limits.maxBodyBytes) {
    throw new KnowledgeStoreError(413, 'knowledge-limit', 'Knowledge title or body exceeds the configured byte limit.')
  }
  if ((record.kind === 'lesson' && record.evidence.length > limits.maxReferences) ||
    (record.kind === 'protocol' && (record.constraints?.requiredAcceptanceLabels?.length ?? 0) > limits.maxReferences) ||
    Buffer.byteLength(JSON.stringify(record), 'utf8') > limits.maxSnapshotBytes) {
    throw new KnowledgeStoreError(413, 'knowledge-limit', 'Knowledge references or serialized content exceed the configured limit.')
  }
}
