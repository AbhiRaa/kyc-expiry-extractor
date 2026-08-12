import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Keep the native and WASM-backed pipeline dependencies out of the bundler.
   *
   * These packages load platform binaries or `.wasm` blobs at runtime rather than through
   * a normal import graph, so bundling them either fails outright or produces a bundle
   * that cannot find its own assets. `zxing-wasm` is the concrete case: its loader is a
   * generated file whose single-letter module references the bundler tries — and fails —
   * to resolve ("Can't resolve 'a'"). Marking them external makes Node `require` them from
   * `node_modules` at runtime, which is what they expect.
   *
   * This is also why the extract route pins `runtime = 'nodejs'` rather than Edge: every
   * one of these needs Node APIs.
   */
  serverExternalPackages: [
    'zxing-wasm',
    'sharp',
    'tesseract.js',
    'pdfjs-dist',
    'heic-convert',
    'bwip-js',
  ],

  /**
   * `serverExternalPackages` stops the bundler from touching these, but Vercel's deploy-time
   * file TRACER is a separate step that decides which files actually ship in the deployed
   * function — and it works by statically following `require`/`import` calls. tesseract.js's
   * Node worker spawns `worker-script/node/index.js` as a real file via `worker_threads`, and
   * that file does `require('..')` (a bare parent-directory relative require), a
   * runtime-computed `require('tesseract.js-core/tesseract-core-<variant>')` chosen by
   * detected SIMD support, and further requires its own dependencies (`bmp-js`, `zlibjs`,
   * `node-fetch`, ...) the same way — every one of those is a pattern a static tracer cannot
   * follow, so trying to enumerate the closure package-by-package is a whack-a-mole exercise
   * that breaks again the next time tesseract.js's internals change. `node_modules` is 660 MB,
   * comfortably inside Vercel's 5 GB Fluid Compute function limit, so including all of it for
   * this one route trades a larger bundle for not having this class of bug at all.
   */
  outputFileTracingIncludes: {
    '/api/extract': ['./node_modules/**/*'],
    // /api/eval-gate runs the same tesseract.js-dependent pipeline (runPipeline, via the
    // gate's OCR presurvey and TB_OCR) against the eval corpus — same failure mode, same
    // fix. Found live in production (not locally: `next dev`/`next build` never run
    // Vercel's separate deploy-time file tracer at all), the exact scenario the comment
    // above already documents for /api/extract — this route was just never added when it
    // was created.
    '/api/eval-gate': ['./node_modules/**/*'],
  },
};

export default nextConfig;
