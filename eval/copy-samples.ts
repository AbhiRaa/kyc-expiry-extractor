/**
 * Copies the documents the UI's one-tap sample buttons load (§10) out of the generated
 * corpus into `public/samples/`.
 *
 * §10 is emphatic about those buttons — "Do not skip this. Assume he will open the link on
 * his phone between meetings." They must work on a cold clone with no upload, so this runs
 * as part of `npm run generate:corpus` rather than being a manual step somebody forgets.
 *
 * The file list is read from `src/lib/sample-docs.ts` so there is exactly one source of
 * truth: if the UI adds a sample, this copies it without anyone remembering to.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { SAMPLE_DOCS, sampleFileName } from '@/lib/sample-docs';
import { CORPUS_DIR } from './generate-corpus';

const PUBLIC_SAMPLES_DIR = path.join(process.cwd(), 'public', 'samples');

async function main(): Promise<void> {
  await mkdir(PUBLIC_SAMPLES_DIR, { recursive: true });

  let copied = 0;
  const missing: string[] = [];

  for (const doc of SAMPLE_DOCS) {
    const filename = sampleFileName(doc);
    const source = path.join(CORPUS_DIR, filename);
    try {
      // Fail loudly per-file rather than aborting: a partially-populated samples
      // directory still gives the UI something to load, and the UI degrades gracefully
      // on the ones that are absent.
      await readFile(source);
      await copyFile(source, path.join(PUBLIC_SAMPLES_DIR, filename));
      copied++;
    } catch {
      missing.push(filename);
    }
  }

  console.log(`Copied ${copied}/${SAMPLE_DOCS.length} sample documents to public/samples/`);
  if (missing.length > 0) {
    console.warn(
      `  Not found in the corpus (run "npm run generate:corpus" first): ${missing.join(', ')}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
