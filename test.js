import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReportStore, nextOccurrence, parseWeekdays, scheduleToCron } from './reportStore.js';
import { reportToBlocks } from './notionClient.js';
import { generateReport } from './reportGenerator.js';
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

test('OpenAI 응답의 텍스트를 보고서로 반환한다', async () => {
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '# 요약\n완료' }] }] }), { status: 200 });
  };
  const report = await generateReport([{ authorName: '홍길동', content: '작업 완료', createdAt: new Date().toISOString() }], { apiKey: 'test', model: 'test-model', fetchImpl });
  assert.equal(report, '# 요약\n완료');
});

test('긴 보고서를 Notion 제한 안의 블록으로 나눈다', () => {
  const blocks = reportToBlocks(`본문 ${'가'.repeat(4500)}`);
  assert.ok(blocks.length >= 3);
  assert.ok(blocks.every(block => block[block.type].rich_text[0].text.content.length <= 1800));
});
