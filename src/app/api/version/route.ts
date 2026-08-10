/**
 * GET /api/version — the commit SHA a deployment is actually running (§13).
 *
 * Vercel sets `VERCEL_GIT_COMMIT_SHA` automatically on every deployment, no config
 * needed. The `git rev-parse` fallback only matters for local `next dev`, where a git
 * binary and a `.git` directory both exist — it never runs on Vercel, whose deployment
 * bundle omits `.git` entirely.
 */

import { execSync } from 'node:child_process';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function resolveCommitSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export function GET(): NextResponse {
  return NextResponse.json(
    {
      commit_sha: resolveCommitSha(),
      environment: process.env.VERCEL_ENV ?? 'development',
    },
    { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
