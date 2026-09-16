import { randomUUID } from 'node:crypto';
import { saveReportToNotion } from './notionClient.js';

export function reportTitle(date, isTest) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${isTest ? '[TEST] ' : ''}연구 스크럼 · ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function safeHeading(value) {
  return String(value).replace(/[\r\n#]+/g, ' ').trim().slice(0, 80) || '이름 없음';
}

export function compileResearchScrum(submissions, missing = []) {
  if (!submissions.length) throw new Error('수집 시간 안에 제출된 연구 스크럼이 없습니다.');
  const respondentNames = submissions.map(item => safeHeading(item.authorName));
  const missingNames = missing.map(item => safeHeading(item.name || item.userId));
  const status = [
    '# 연구 스크럼 취합',
    '',
    '## 응답 현황',
    `- 응답 ${submissions.length}명: ${respondentNames.join(', ')}`,
    `- 미응답 ${missing.length}명${missingNames.length ? `: ${missingNames.join(', ')}` : ''}`,
  ];
  const responses = submissions.flatMap(item => [
    '',
    `## ${safeHeading(item.authorName)}`,
    '',
    item.content.trim(),
  ]);
  return [...status, ...responses].join('\n');
}

export class ReportService {
  constructor({ store, notion, notify, recipients = () => [], save = saveReportToNotion, now = () => new Date() }) {
    Object.assign(this, { store, notion, notify, recipients, save, now });
    this.running = false;
    this.needsReconciliation = false;
  }

  async run({ isTest = false, content, authorId = 'test', authorName = '테스트' } = {}) {
    if (this.running) throw new Error('이미 보고서를 생성하고 있습니다. 완료 후 다시 실행하세요.');
    if (this.needsReconciliation) throw new Error('이전 Notion 저장 후 로컬 기록에 실패했습니다. Notion과 저장 파일을 확인한 후 봇을 재시작하세요.');
    this.running = true;
    try {
      const now = this.now();
      if (!isTest) {
        this.store.closeCollection(now);
        await this.store.flush();
      }
      const submissions = content?.trim()
        ? [{ id: randomUUID(), authorId, authorName, content: content.trim(), createdAt: now.toISOString() }]
        : this.store.getSubmissions();
      if (!submissions.length) return { skipped: true, reason: '수집 기간 내 제출된 내용이 없어 보고서를 만들지 않았습니다.' };
      const title = reportTitle(now, isTest);
      const respondents = new Set(submissions.map(item => item.authorId));
      const missing = isTest ? [] : this.recipients().filter(person => !respondents.has(person.userId));
      const report = compileResearchScrum(submissions, missing);
      const page = await this.save({ title, content: report }, this.notion);
      const outputUrl = this.notion.outputUrl || page.url;
      try {
        this.store.recordReport({ ...page, title, isTest, submissionIds: submissions.map(entry => entry.id) }, now);
        await this.store.flush();
      } catch {
        this.needsReconciliation = true;
        throw new Error(`Notion에는 저장했지만 로컬 기록에 실패했습니다. 중복 생성을 막기 위해 실행을 중지했습니다: ${page.url}`);
      }
      // Notion 저장/대기 목록 반영 후 알림. 알림 실패로 같은 보고서를 다시 만들지 않는다.
      let notificationError = null;
      try {
        const notice = `${isTest ? '🧪 테스트' : '📝 팀'} 보고서가 Notion에 저장되었습니다.\n${outputUrl}`;
        await this.notify(report.length <= 1700
          ? `${notice}\n\n${report}`
          : { content: `${notice}\n\n취합 내용은 첨부 파일에서 확인하세요.`, files: [{ attachment: Buffer.from(report, 'utf8'), name: 'research-scrum.txt' }] });
      } catch {
        notificationError = 'Notion 저장은 완료됐지만 Discord 알림 전송에 실패했습니다. 채널과 권한을 확인하세요.';
      }
      return { ...page, url: outputUrl, title, notificationError, skipped: false };
    } finally {
      this.running = false;
    }
  }
}
