import { requestJson } from './apiClient.js';

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

export function reportToBlocks(content) {
  if (!content?.trim() || content.length > 20000) throw new Error('Notion에 저장할 보고서 길이가 올바르지 않습니다.');
  const blocks = content.split(/\n\s*\n/).filter(part => part.trim()).flatMap(part => {
    const heading = part.trim().match(/^(#{1,3})\s+([^\n]+)$/);
    if (heading && heading[2].length <= 1800) return [block(`heading_${heading[1].length}`, heading[2])];
    return splitText(part.trim()).map(chunk => block('paragraph', chunk));
  });
  // 한 번의 페이지 생성 요청으로 저장하여 중간 블록 추가 실패를 피한다.
  return blocks.length <= 90 ? blocks : splitText(content).map(chunk => block('paragraph', chunk));
}

export async function saveReportToNotion({ title, content, submissions, isTest, missing = [] }, {
  token, parentPageId, dataSourceId, titleProperty = 'Name', fetchImpl = fetch,
}) {
  if (!token || (!parentPageId && !dataSourceId) || (parentPageId && dataSourceId)) {
    throw new Error('NOTION_TOKEN과 저장 위치(NOTION_PARENT_PAGE_ID 또는 NOTION_DATA_SOURCE_ID 중 하나)를 설정하세요.');
  }
  const property = dataSourceId ? titleProperty : 'title';
  const metadata = `${isTest ? '테스트 보고서' : '정기 보고서'} · 제출 ${submissions.length}건\n작성자: ${[...new Set(submissions.map(item => item.authorName))].join(', ')}${missing.length ? `\n미응답: ${missing.map(person => person.name || person.userId).join(', ')}` : ''}`;
  const children = [
    ...splitText(metadata).map(chunk => block('paragraph', chunk)),
    ...reportToBlocks(content),
  ];
  if (children.length > 100) throw new Error('보고서가 Notion 블록 한도를 초과했습니다.');
  const result = await requestJson('https://api.notion.com/v1/pages', {
    provider: 'Notion', token, fetchImpl,
    headers: { 'Notion-Version': '2025-09-03' },
    body: {
      parent: dataSourceId ? { type: 'data_source_id', data_source_id: dataSourceId } : { type: 'page_id', page_id: parentPageId },
      properties: { [property]: { type: 'title', title: [{ type: 'text', text: { content: title } }] } },
      children,
    },
  });
  if (!result.id || !result.url) throw new Error('Notion 생성 결과를 확인할 수 없습니다. 저장 위치에서 페이지 생성 여부를 확인하세요.');
  return { id: result.id, url: result.url };
}
