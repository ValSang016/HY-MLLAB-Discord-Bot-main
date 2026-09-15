import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReportStore, nextOccurrence, parseWeekdays, scheduleToCron } from './reportStore.js';
import { reportToBlocks, saveReportToNotion } from './notionClient.js';
import { compileResearchScrum } from './reportService.js';
import { getResearchScrumTemplate } from './researchTemplate.js';

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnb-report-'));
  try { return run(new ReportStore(path.join(directory, 'state.json'))); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('요일과 시간 설정을 cron으로 변환한다', () => {
  assert.deepEqual(parseWeekdays('월, 수,금요일'), [1, 3, 5]);
  assert.equal(scheduleToCron({ weekdays: [1, 3, 5], time: '20:30', enabled: true }), '30 20 * * 1,3,5');
  assert.throws(() => parseWeekdays('월,휴일'), /요일/);
});

test('단일 연구 스크럼 템플릿에 필수 항목이 있다', () => {
  const template = getResearchScrumTemplate();
  for (const heading of ['연구 목표와 핵심 질문', '진행한 연구', '주요 결과와 근거', '문제와 위험 요소', '다음 연구 계획', '공유·결정 사항']) {
    assert.match(template, new RegExp(heading));
  }
  assert.ok(template.length < 1500);
});

test('다음 마감 시각을 한국 시간으로 계산한다', () => {
  const after = new Date('2026-09-13T11:00:00.000Z');
  assert.equal(nextOccurrence({ weekdays: [0], time: '23:00', enabled: true }, after).toISOString(), '2026-09-13T14:00:00.000Z');
});

test('수집 기간 안의 대상자 답변만 저장한다', () => withStore(store => {
  const openedAt = new Date('2026-09-13T11:00:00.000Z');
  const window = store.beginCollection([{ userId: '123', name: '홍길동' }], openedAt);
  store.submit({ authorId: '123', authorName: '홍길동', content: '진행 내용', collectionId: window.id }, new Date('2026-09-13T12:00:00.000Z'));
  assert.equal(store.getSubmissions().length, 1);
  assert.throws(() => store.submit({ authorId: '456', authorName: '외부인', content: '무시', collectionId: window.id }, new Date('2026-09-13T12:00:00.000Z')), /대상이 아닙니다/);
}));

test('마감 시각 이후 답변은 저장하지 않는다', () => withStore(store => {
  const window = store.beginCollection([{ userId: '123', name: '홍길동' }], new Date('2026-09-13T11:00:00.000Z'));
  assert.throws(() => store.submit({ authorId: '123', authorName: '홍길동', content: '늦은 답변', collectionId: window.id }, new Date(window.closesAt)), /수집 시간이 아닙니다/);
  assert.equal(store.getSubmissions().length, 0);
}));

test('새 수집 기간은 이전 버튼 ID를 무효화한다', () => withStore(store => {
  const first = store.beginCollection([{ userId: '123', name: '홍길동' }], new Date('2026-09-13T11:00:00.000Z'));
  store.closeCollection(new Date('2026-09-13T14:00:00.000Z'));
  const second = store.beginCollection([{ userId: '123', name: '홍길동' }], new Date('2026-09-20T11:00:00.000Z'));
  assert.notEqual(first.id, second.id);
  assert.equal(store.isCollecting(first.id, new Date('2026-09-20T12:00:00.000Z')), false);
}));

test('임의 수집은 지정한 유효시간으로 열린다', () => withStore(store => {
  const openedAt = new Date('2026-09-13T11:00:00.000Z');
  const closesAt = new Date(openedAt.getTime() + 45 * 60000);
  const window = store.beginCollection([{ userId: '123', name: '홍길동' }], openedAt, closesAt);
  assert.equal(window.closesAt, '2026-09-13T11:45:00.000Z');
  assert.equal(store.isCollecting(window.id, new Date('2026-09-13T11:44:59.000Z')), true);
  assert.equal(store.isCollecting(window.id, closesAt), false);
}));

test('답변을 수정하지 않고 작성자별로 취합한다', () => {
  const first = '# 연구 스크럼\n\n실험 결과: 정확도 91.7%';
  const second = '가설 B는 기각하지 못함';
  const report = compileResearchScrum([
    { authorName: '홍길동', content: first },
    { authorName: '김연구', content: second },
  ], [{ userId: '789', name: '박미응답' }]);
  assert.match(report, /응답 2명: 홍길동, 김연구/);
  assert.match(report, /미응답 1명: 박미응답/);
  assert.ok(report.includes(first));
  assert.ok(report.includes(second));
});

test('긴 보고서를 Notion 제한 안의 블록으로 나눈다', () => {
  const blocks = reportToBlocks(`본문 ${'가'.repeat(4500)}`);
  assert.ok(blocks.length >= 3);
  assert.ok(blocks.every(block => block[block.type].rich_text[0].text.content.length <= 1800));
});

test('연구 템플릿 Markdown을 Notion 제목과 목록 블록으로 변환한다', () => {
  const blocks = reportToBlocks('# 연구 스크럼\n\n## 진행한 연구\n- 문헌 조사\n1. 실험 실행\n일반 본문');
  assert.deepEqual(blocks.map(item => item.type), [
    'heading_1', 'heading_2', 'bulleted_list_item', 'numbered_list_item', 'paragraph',
  ]);
  assert.equal(blocks[1].heading_2.rich_text[0].text.content, '진행한 연구');
  assert.equal(blocks[2].bulleted_list_item.rich_text[0].text.content, '문헌 조사');
});

test('100개가 넘는 Notion 블록은 페이지 생성 후 이어 붙인다', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => requests.length === 1 ? { id: 'page-id', url: 'https://notion.test/page' } : {} };
  };
  await saveReportToNotion({ title: '테스트', content: Array.from({ length: 101 }, (_, index) => `- 항목 ${index}`).join('\n') }, {
    token: 'secret', dataSourceId: '12345678123412341234123456789012', titleProperty: '이름', fetchImpl,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.children.length, 100);
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].body.children.length, 1);
});
