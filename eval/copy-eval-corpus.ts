/**
 * Copies the full 35-document eval corpus into `public/eval-corpus/`, plus a
 * `manifest.json` classifying each file as adversarial or not — the data
 * `src/app/api/eval-gate` reads at request time to run a real, live admission-gate check
 * against the real corpus (docs/DECISIONS.md's live gate-check entry).
 *
 * `eval/corpus/` itself is deliberately gitignored (reproducible, avoid bloating every
 * clone — see `eval/generate-corpus.ts`'s own header) and `next build` never regenerates
 * it, so none of it exists in a deployed build on its own. `public/samples/`
 * (`eval/copy-samples.ts`) already solves exactly this problem for the 6 one-tap sample
 * documents; this is the same mechanism, extended to the whole corpus specifically so the
 * live gate check has something real to run against in production, not just locally.
 * `public/` carries no gitignore rule, so — like `public/samples/` already does — this
 * output is meant to be committed, a deliberate, documented exception to `eval/corpus/`'s
 * own policy. At ~1.7 MB across all 35 files, the cost of that exception is trivial.
 *
 * Wired into `npm run generate:corpus` as the third step, after `copy-samples.ts`, so a
 * regenerated corpus always keeps `public/eval-corpus/` in sync automatically.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CORPUS_DIR, GROUND_TRUTH_PATH } from './generate-corpus';
import { isAdversarial, parseCsv } from './run';

const PUBLIC_EVAL_CORPUS_DIR = path.join(process.cwd(), 'public', 'eval-corpus');

interface ManifestEntry {
  filename: string;
  expectedClass: string;
  adversarial: boolean;
}

async function main(): Promise<void> {
  await mkdir(PUBLIC_EVAL_CORPUS_DIR, { recursive: true });

  const csv = await readFile(GROUND_TRUTH_PATH, 'utf8');
  const rows = parseCsv(csv);

  let copied = 0;
  const missing: string[] = [];
  const manifest: ManifestEntry[] = [];

  for (const row of rows) {
    const source = path.join(CORPUS_DIR, row.filename);
    try {
      // Fail loudly per-file rather than aborting: a partially-populated directory still
      // lets the live check run against whatever is present (copy-samples.ts's own
      // reasoning, applied here too).
      await readFile(source);
      await copyFile(source, path.join(PUBLIC_EVAL_CORPUS_DIR, row.filename));
      copied++;
      manifest.push({
        filename: row.filename,
        expectedClass: row.expected_class,
        adversarial: isAdversarial(row),
      });
    } catch {
      missing.push(row.filename);
    }
  }

  await writeFile(
    path.join(PUBLIC_EVAL_CORPUS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  console.log(`Copied ${copied}/${rows.length} eval corpus documents to public/eval-corpus/`);
  console.log(
    `  ${manifest.filter((m) => m.adversarial).length} adversarial, ` +
      `${manifest.filter((m) => !m.adversarial).length} non-adversarial (manifest.json)`,
  );
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
