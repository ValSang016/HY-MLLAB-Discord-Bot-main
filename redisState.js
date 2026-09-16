import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class RedisStateSync {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.queues = new Map();
  }

  key(filePath) {
    return `nmnb:${path.basename(filePath, '.json')}`;
  }

  async command(parts) {
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('Upstash Redis 연결 실패 또는 시간 초과입니다.');
    }
    if (!response.ok) throw new Error(`Upstash Redis 요청 실패 (HTTP ${response.status}). URL과 토큰을 확인하세요.`);
    const data = await response.json().catch(() => { throw new Error('Upstash Redis 응답을 읽을 수 없습니다.'); });
    if (data.error) throw new Error(`Upstash Redis 요청 실패: ${data.error}`);
    return data.result;
  }

  async restore(filePath) {
    const value = await this.command(['GET', this.key(filePath)]);
    if (value === null) return false;
    try { JSON.parse(value); } catch { throw new Error(`Upstash Redis의 ${this.key(filePath)} 데이터가 올바른 JSON이 아닙니다.`); }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return true;
  }

  persist(filePath, state) {
    const key = this.key(filePath);
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.command(['SET', key, JSON.stringify(state)]));
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
}
