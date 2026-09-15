import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const templatePath = fileURLToPath(new URL('./templates/research-scrum.md', import.meta.url));
let cachedTemplate;

export function getResearchScrumTemplate() {
  if (cachedTemplate === undefined) cachedTemplate = fs.readFileSync(templatePath, 'utf8').trim();
  return cachedTemplate;
}
