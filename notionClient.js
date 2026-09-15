import { requestJson } from './apiClient.js';
import { MAX_SOURCE_CHARS } from './reportStore.js';

function splitText(text, limit = 1800) {
  const chunks = [];
  let chunk = '';
  // 이모지의 서로게이트 쌍이 경계에서 잘리지 않게 한다.
  for (const character of text) {
    if (chunk.length + character.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function block(type, content) {
  return { object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content } }] } };
}

function blocksForLine(line) {
  const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*$/);
  if (heading) return splitText(heading[2]).map(text => block(`heading_${heading[1].length}`, text));
  const bullet = line.match(/^\s{0,3}[-*+]\s+(.+?)\s*$/);
  if (bullet) return splitText(bullet[1]).map(text => block('bulleted_list_item', text));
  const numbered = line.match(/^\s{0,3}\d+[.)]\s+(.+?)\s*$/);
  if (numbered) return splitText(numbered[1]).map(text => block('numbered_list_item', text));
  return splitText(line.trim()).map(text => block('paragraph', text));
}

export function reportToBlocks(content) {
  if (!content?.trim() || content.length > MAX_SOURCE_CHARS + 10000) throw new Error('Notion에 저장할 보고서 길이가 올바르지 않습니다.');
  const blocks = content.replaceAll('\r\n', '\n').split('\n').filter(line => line.trim()).flatMap(blocksForLine);
  if (blocks.length > 1000) throw new Error('보고서의 Markdown 항목이 너무 많습니다. 제목과 목록 수를 줄이세요.');
  return blocks;
}

export async function saveReportToNotion({ title, content }, {
  token, parentPageId, dataSourceId, titleProperty = 'Name', fetchImpl = fetch,
}) {
  if (!token || (!parentPageId && !dataSourceId) || (parentPageId && dataSourceId)) {
    throw new Error('NOTION_TOKEN과 저장 위치(NOTION_PARENT_PAGE_ID 또는 NOTION_DATA_SOURCE_ID 중 하나)를 설정하세요.');
  }
  const property = dataSourceId ? titleProperty : 'title';
  const children = reportToBlocks(content);
  const firstChildren = children.slice(0, 100);
  const result = await requestJson('https://api.notion.com/v1/pages', {
    provider: 'Notion', token, fetchImpl,
    headers: { 'Notion-Version': '2025-09-03' },
    body: {
      parent: dataSourceId ? { type: 'data_source_id', data_source_id: dataSourceId } : { type: 'page_id', page_id: parentPageId },
      properties: { [property]: { type: 'title', title: [{ type: 'text', text: { content: title } }] } },
      children: firstChildren,
    },
  });
  if (!result.id || !result.url) throw new Error('Notion 생성 결과를 확인할 수 없습니다. 저장 위치에서 페이지 생성 여부를 확인하세요.');
  for (let offset = 100; offset < children.length; offset += 100) {
    await requestJson(`https://api.notion.com/v1/blocks/${result.id}/children`, {
      provider: 'Notion', token, fetchImpl, method: 'PATCH',
      headers: { 'Notion-Version': '2025-09-03' },
      body: { children: children.slice(offset, offset + 100) },
    });
  }
  return { id: result.id, url: result.url };
}
