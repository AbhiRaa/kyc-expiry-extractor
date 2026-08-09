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
};

export default nextConfig;
