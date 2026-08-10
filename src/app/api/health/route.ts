/**
 * GET /api/health — liveness probe (§13).
 *
 * No external dependency to check: the pipeline has no database, and pinging the VLM
 * provider on every health check would spend money on every automated probe — exactly
 * the cost discipline the rest of this system is built around. This confirms the process
 * is up and responding, nothing more.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function GET(): NextResponse {
  return NextResponse.json(
    { status: 'ok', timestamp: new Date().toISOString() },
    { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
