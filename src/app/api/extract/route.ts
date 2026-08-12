/**
 * POST /api/extract — the single entry point.
 *
 * Node runtime, not Edge: the barcode, MRZ, OCR and image libraries all need Node APIs.
 *
 * Contract with the client (§10): `multipart/form-data`, field `file`, optional field
 * `barcode` carrying a payload the client decoded at full resolution before downscaling
 * (G2). That payload is treated as untrusted input and is re-parsed and re-checksummed
 * server-side — it saves a decode pass, it does not confer a verdict.
 *
 * This handler never returns a stack trace and never returns a 500 for a document reason
 * (§11.6 #71). Anything the pipeline cannot resolve comes back as a 200 with a REVIEW
 * decision and machine-readable reason codes, because a review queue that receives an
 * opaque failure cannot triage it.
 */

import { NextResponse } from 'next/server';

import { PIPELINE_BUDGET_MS } from '@/types/contract';
import { deliverCrmPayload } from '@/pipeline/crm';
import { normalizeDocument } from '@/pipeline/normalize';
import { runPipeline } from '@/pipeline/router';
import { AnthropicVlmClient } from '@/pipeline/vlm-client';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Platform request cap is 4.5 MB and is infrastructure-level; refuse early and clearly. */
const MAX_UPLOAD_BYTES = 4_500_000;

/** Per-document spend ceiling for the VLM tier (§11.6 #74). */
const PER_DOCUMENT_BUDGET_USD = 0.25;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return clientError('Send the document as multipart/form-data with a "file" field.', 415);
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return clientError('No file was included in the request.', 400);
    }
    if (file.size === 0) {
      return clientError('The uploaded file is empty.', 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      // The client is supposed to downscale before sending; say so plainly rather than
      // letting the platform return an opaque 413.
      return clientError(
        'The document exceeds the 4.5 MB upload limit. Please downscale it and try again.',
        413,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const clientDecodedBarcode = readOptionalString(form.get('barcode'));
    const applicantRef = readOptionalString(form.get('applicantRef'));

    const outcome = await normalizeDocument(bytes, { declaredName: file.name });

    // Only construct the VLM client when a key is actually present. Without one the
    // pipeline still runs end to end on the deterministic and OCR tiers and reports
    // MODEL_UNAVAILABLE rather than failing the request.
    const vlmClient = process.env.ANTHROPIC_API_KEY ? new AnthropicVlmClient() : undefined;

    const result = await runPipeline({
      outcome,
      vlmClient,
      clientDecodedBarcode,
      applicantRef,
      budgetUsd: PER_DOCUMENT_BUDGET_USD,
      budgetMs: PIPELINE_BUDGET_MS,
    });

    // CRM delivery is a side effect of the verdict, not part of it (docs/DECISIONS.md §9):
    // attempted here, at the I/O boundary, after the verdict is already final. Bounded by
    // deliverCrmPayload's own timeout and never throws, so a CRM outage can change
    // crm_delivery but can never turn a correct extraction into a failed request.
    const response = result.crm_payload
      ? { ...result, crm_delivery: await deliverCrmPayload(result.crm_payload) }
      : result;

    return NextResponse.json(response, {
      status: 200,
      headers: {
        // Nothing here is cacheable and none of it should be stored (§15).
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    // A genuine server fault, not a document problem. Log the shape, never the content —
    // no document text and no extracted values reach the logs (§15).
    console.error('[extract] unhandled failure', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown',
    });
    return clientError('The extraction service failed to process this request.', 500);
  }
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: 'Use POST with multipart/form-data and a "file" field.' },
    { status: 405 },
  );
}

function clientError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function readOptionalString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
