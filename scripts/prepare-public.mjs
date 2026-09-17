import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const files = ['index.html', 'app.js', 'styles.css', 'bars.json'];

await rm(pub, { recursive: true, force: true });
await mkdir(pub, { recursive: true });
for (const f of files) {
  await copyFile(join(root, f), join(pub, f));
}
console.log(`Prepared public/ (${files.join(', ')})`);
