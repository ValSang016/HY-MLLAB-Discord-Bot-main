import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const DEFAULT_SCHEDULE = { weekdays: [0], time: '20:00', enabled: true };
export const DEFAULT_DEADLINE = { weekdays: [0], time: '23:00', enabled: true };
export const MAX_SOURCE_CHARS = 60000;

export function parseWeekdays(value) {
  const days = String(value).trim().split(/[,\s]+/).map(day => WEEKDAYS.indexOf(day.replace(/요일$/, '')));
  if (!days.length || days.some(day => day < 0)) {
    throw new Error('요일은 월,수,금처럼 입력하세요.');
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

export function validateSchedule(schedule) {
  if (!schedule || !Array.isArray(schedule.weekdays) || !schedule.weekdays.length ||
      schedule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('반복 요일이 올바르지 않습니다.');
  }
  if (typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error('시간은 한국 시간 기준 HH:mm 형식으로 입력하세요. 예: 20:30');
  }
  if (typeof schedule.enabled !== 'boolean') throw new Error('알림 활성화 설정이 올바르지 않습니다.');
  return { weekdays: [...new Set(schedule.weekdays)].sort((a, b) => a - b), time: schedule.time, enabled: schedule.enabled };
}

export function scheduleToCron(schedule) {
  const { weekdays, time } = validateSchedule(schedule);
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * ${weekdays.join(',')}`;
}

export function describeSchedule(schedule) {
  return `${schedule.enabled ? '켜짐' : '꺼짐'} · 매주 ${schedule.weekdays.map(day => WEEKDAYS[day]).join(', ')}요일 ${schedule.time} (한국 시간)`;
}

// Asia/Seoul은 UTC+09:00이며 일광 절약 시간을 사용하지 않는다.
export function nextOccurrence(schedule, after = new Date()) {
  validateSchedule(schedule);
  if (!schedule.enabled) throw new Error('먼저 /마감설정으로 보고서 마감을 켜세요.');
  const local = new Date(after.getTime() + 9 * 3600000);
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offset, hour - 9, minute));
    const weekday = new Date(candidate.getTime() + 9 * 3600000).getUTCDay();
    if (candidate > after && schedule.weekdays.includes(weekday)) return candidate;
  }
  throw new Error('다음 마감 시간을 계산할 수 없습니다.');
}

// 한 봇 프로세스가 사용하는 저장소. 임시 파일을 완성한 후 교체한다.
export class ReportStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, schedule: structuredClone(DEFAULT_SCHEDULE), deadline: structuredClone(DEFAULT_DEADLINE), collection: null, submissions: [], reports: [] };
    if (fs.existsSync(filePath)) {
      const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.submissions) || !Array.isArray(state.reports) ||
          state.submissions.some(entry => !entry || !['id', 'authorId', 'authorName', 'content', 'createdAt'].every(key => typeof entry[key] === 'string'))) {
        throw new Error('보고서 저장 파일 형식이 올바르지 않습니다. 원본 파일을 확인하세요.');
      }
      this.state = { ...state, schedule: validateSchedule(state.schedule), deadline: validateSchedule(state.deadline ?? DEFAULT_DEADLINE) };
      const window = this.state.collection;
      if (window && (!/^[a-f\d]{12}$/.test(window.id) || !Number.isFinite(Date.parse(window.openedAt)) ||
          !Number.isFinite(Date.parse(window.closesAt)) || Date.parse(window.closesAt) <= Date.parse(window.openedAt) ||
          !Array.isArray(window.participants))) throw new Error('수집 기간 저장 정보가 올바르지 않습니다.');
    }
  }

  commit(next) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      this.state = next;
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  getSchedule() { return structuredClone(this.state.schedule); }
  getDeadline() { return structuredClone(this.state.deadline); }
  getSubmissions() { return structuredClone(this.state.submissions); }
  getCollection() { return structuredClone(this.state.collection ?? null); }

  isCollecting(id, now = new Date()) {
    const window = this.state.collection;
    return Boolean(window && window.id === id && !window.closedAt &&
      now.getTime() >= Date.parse(window.openedAt) && now.getTime() < Date.parse(window.closesAt));
  }

  beginCollection(participants, now = new Date()) {
    if (this.state.collection && this.isCollecting(this.state.collection.id, now)) return this.getCollection();
    if (this.state.submissions.length) throw new Error('이전 기간의 보고서가 아직 저장되지 않았습니다. /보고서생성으로 처리한 후 다음 수집을 시작하세요.');
    const closesAt = nextOccurrence(this.state.deadline, now).toISOString();
    const window = { id: randomUUID().replaceAll('-', '').slice(0, 12), openedAt: now.toISOString(), closesAt, closedAt: null, participants };
    this.commit({ ...this.state, collection: window });
    return structuredClone(window);
  }

  closeCollection(now = new Date()) {
    if (!this.state.collection || this.state.collection.closedAt) return;
    this.commit({ ...this.state, collection: { ...this.state.collection, closedAt: now.toISOString() } });
  }

  setSchedule(schedule) {
    const validated = validateSchedule(schedule);
    this.commit({ ...this.state, schedule: validated });
    return structuredClone(validated);
  }

  setDeadline(schedule) {
    const validated = validateSchedule(schedule);
    this.commit({ ...this.state, deadline: validated });
    return structuredClone(validated);
  }

  disableSchedules() {
    this.commit({ ...this.state, schedule: { ...this.state.schedule, enabled: false }, deadline: { ...this.state.deadline, enabled: false },
      collection: this.state.collection ? { ...this.state.collection, closedAt: new Date().toISOString() } : null });
  }

  submit({ authorId, authorName, content, collectionId }, now = new Date()) {
    if (!this.isCollecting(collectionId, now)) throw new Error('지금은 수집 시간이 아닙니다. 답변을 저장하지 않았습니다.');
    if (!this.state.collection.participants.some(person => person.userId === authorId)) throw new Error('이번 수집 대상이 아닙니다.');
    const text = content?.trim();
    if (!text || text.length > 4000) throw new Error('보고서 내용은 1~4,000자로 입력하세요.');
    // 같은 사람이 다시 제출하면 아직 보고되지 않은 이전 원문을 교체한다.
    const remaining = this.state.submissions.filter(entry => entry.authorId !== authorId);
    const entry = { id: randomUUID(), authorId, authorName, content: text, collectionId, createdAt: now.toISOString() };
    const submissions = [...remaining, entry];
    if (JSON.stringify(submissions).length > MAX_SOURCE_CHARS) {
      throw new Error('대기 중인 보고서 분량이 한도를 초과했습니다. 내용을 줄이거나 정기 보고서 생성 후 다시 제출하세요.');
    }
    this.commit({ ...this.state, submissions });
    return entry;
  }

  recordReport({ id, title, url, submissionIds, isTest }, now = new Date()) {
    const completedIds = new Set(submissionIds);
    this.commit({
      ...this.state,
      // 생성 중에 다시 제출한 내용은 새 ID를 가지므로 다음 보고서에 남는다.
      submissions: isTest ? this.state.submissions : this.state.submissions.filter(entry => !completedIds.has(entry.id)),
      reports: [...this.state.reports, { id, title, url, isTest, createdAt: now.toISOString(), submissionIds }].slice(-100),
    });
  }
}
