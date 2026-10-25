import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.resolve(process.env.FOLIO_DATA_DIR || path.join(ROOT, 'data'));
export const PORT = Number(process.env.PORT || 4317);
export const HOST = process.env.HOST || '127.0.0.1';
export const PUBLIC_DIR = path.join(here, 'public');

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

fs.mkdirSync(DATA_DIR, { recursive: true });
