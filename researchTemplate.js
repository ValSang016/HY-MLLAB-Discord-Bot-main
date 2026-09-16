import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const templatePath = fileURLToPath(new URL('./templates/research-scrum.md', import.meta.url));

export function getResearchScrumTemplate() {
  const template = fs.readFileSync(templatePath, 'utf8').trim();
  if (!template) throw new Error('연구 스크럼 템플릿이 비어 있습니다.');
  if (template.length > 3500) throw new Error('연구 스크럼 템플릿은 3,500자 이하여야 합니다.');
  return template;
}
