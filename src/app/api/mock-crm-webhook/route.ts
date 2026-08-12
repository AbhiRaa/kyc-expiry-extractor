/**
 * POST /api/mock-crm-webhook — a stand-in for a real CRM's inbound webhook (§9).
 *
 * Nothing in this repository has a real CRM to integrate with, so this endpoint exists
 * purely to make the round trip demonstrable: point CRM_WEBHOOK_URL (.env.local) at this
 * route and every non-REJECTED /api/extract call actually delivers somewhere observable,
 * with a real HTTP round trip and a real crm_delivery outcome, rather than a payload that
 * only ever exists as an inert field in the response body.
 *
 * Deliberately light validation — this simulates a receiver, not a CRM's own API surface.
 * A real CRM's webhook would apply its own schema and auth; this one only confirms the
 * shape buildCrmPayload() actually produces (src/pipeline/crm.ts) matches what a receiver
 * would expect: `properties` plus `associations`, HubSpot's own object-write shape.
 */

import { NextResponse } from 'next/server';

import type { CrmPayload } from '@/types/contract';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  let payload: CrmPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  if (
    typeof payload?.objectType !== 'string' ||
    typeof payload?.idempotencyKey !== 'string' ||
    typeof payload?.properties !== 'object' ||
    payload.properties === null
  ) {
    return NextResponse.json(
      { error: 'Expected { objectType, idempotencyKey, properties, associations }.' },
      { status: 400 },
    );
  }

  // Properties are decision metadata (a decision, a date, a code) never document pixels
  // (§15) — safe to log in full, unlike the extraction pipeline's own document-content logs.
  console.log('[mock-crm-webhook] received', {
    objectType: payload.objectType,
    idempotencyKey: payload.idempotencyKey,
    associationCount: payload.associations?.length ?? 0,
    properties: payload.properties,
  });

  return NextResponse.json(
    { received: true, objectType: payload.objectType, idempotencyKey: payload.idempotencyKey },
    { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: 'Use POST with a CRM payload body — see src/pipeline/crm.ts.' },
    { status: 405 },
  );
}
