import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, Events } from 'discord.js';
import { ReportStore, describeSchedule } from './reportStore.js';
import { ReportScheduler } from './reportScheduler.js';
import { ReportService } from './reportService.js';
import { DmCollection } from './dmCollection.js';
import { createCommandHandler } from './commandHandler.js';
import { registerCommandsToGuild } from './commandRegister.js';
import { RedisStateSync } from './redisState.js';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export function readReportConfig(env = process.env) {
  const channelId = env.REPORT_CHANNEL_ID || env.BACKEND_CHANNEL_ID || env.MOBILE_CHANNEL_ID;
  if (!channelId || !/^\d{17,20}$/.test(channelId)) throw new Error('REPORT_CHANNEL_ID에 알림을 보낼 Discord 채널 ID를 설정하세요.');
  for (const key of ['NOTION_TOKEN']) {
    if (!env[key]?.trim()) throw new Error(`${key}를 .env에 설정하세요.`);
  }
  const parentPageId = env.NOTION_PARENT_PAGE_ID?.trim();
  const dataSourceId = env.NOTION_DATA_SOURCE_ID?.trim();
  if ((!parentPageId && !dataSourceId) || (parentPageId && dataSourceId)) {
    throw new Error('NOTION_PARENT_PAGE_ID 또는 NOTION_DATA_SOURCE_ID 중 하나만 설정하세요.');
  }
  if (![parentPageId, dataSourceId].filter(Boolean).every(id => /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id))) {
    throw new Error('Notion 저장 위치에는 URL이 아닌 페이지/데이터 소스 ID를 입력하세요.');
  }
  const redisUrl = env.UPSTASH_REDIS_REST_URL?.trim();
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (Boolean(redisUrl) !== Boolean(redisToken)) throw new Error('UPSTASH_REDIS_REST_URL과 UPSTASH_REDIS_REST_TOKEN을 함께 설정하세요.');
  if (redisUrl && !/^https:\/\//i.test(redisUrl)) throw new Error('UPSTASH_REDIS_REST_URL은 https:// 주소여야 합니다.');
  return {
    channelId, guildId: env.DISCORD_GUILD_ID || null,
    dataDirectory: path.resolve(rootDirectory, env.DATA_DIR || 'data'),
    notion: {
      token: env.NOTION_TOKEN,
      parentPageId,
      dataSourceId,
      titleProperty: env.NOTION_TITLE_PROPERTY || 'Name',
      outputUrl: env.NOTION_OUTPUT_URL?.trim() || null,
    },
    redis: redisUrl ? { url: redisUrl, token: redisToken } : null,
  };
}

export async function createRuntime(client, config) {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('REPORT_CHANNEL_ID는 서버의 일반 텍스트 채널 또는 공지 채널이어야 합니다.');
  }
  if (config.guildId && channel.guildId !== config.guildId) throw new Error('알림 채널과 DISCORD_GUILD_ID의 서버가 다릅니다.');
  const guildId = channel.guildId;
  const reportFile = path.join(config.dataDirectory, `reports-${guildId}.json`);
  const recipientFile = path.join(config.dataDirectory, `recipients-${guildId}.json`);
  const stateSync = config.redis ? new RedisStateSync(config.redis) : null;
  let reportRestored = false;
  let recipientsRestored = false;
  if (stateSync) {
    [reportRestored, recipientsRestored] = await Promise.all([stateSync.restore(reportFile), stateSync.restore(recipientFile)]);
    console.log('✅ Upstash Redis 상태 저장 연결 완료');
  } else {
    console.warn('⚠️ Upstash Redis 미설정: 로컬 JSON에만 저장합니다. 무료 클라우드 재시작 시 데이터가 사라질 수 있습니다.');
  }
  const store = new ReportStore(reportFile, { onPersist: stateSync ? (file, state) => stateSync.persist(file, state) : null });
  const notify = async message => {
    const destination = await client.channels.fetch(config.channelId);
    const payload = typeof message === 'string' ? { content: message } : message;
    await destination.send({ ...payload, allowedMentions: { parse: [] } });
  };
  const service = new ReportService({ store, notion: config.notion, notify });
  const collection = new DmCollection(client, {
    dataDir: config.dataDirectory,
    allowedGuildId: guildId,
    reportStoreForGuild: id => {
      if (id !== guildId) throw new Error('설정된 서버가 아닙니다.');
      return store;
    },
    onTestSubmitted: async entry => service.run({ isTest: true, ...entry }),
    stateSync,
  });
  const recipientStore = collection.recipients(guildId);
  if (stateSync) {
    if (!reportRestored) await store.persistNow();
    if (!recipientsRestored) await recipientStore.persistNow();
  }
  service.recipients = () => store.getCollection()?.participants || [];
  const scheduler = new ReportScheduler(store, async () => {
    const result = await collection.requestAll(guildId, { scheduled: true });
    console.log(`✅ 예약 DM: 성공 ${result.sent.length}명, 실패 ${result.failed.length}명`);
    if (!result.sent.length && !result.failed.length) {
      await notify('ℹ️ 등록된 수집 대상이 없어 예약 수집을 시작하지 않았습니다. /대상추가로 대상자를 등록하세요.');
      return;
    }
    const window = store.getCollection();
    const closesAt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(window.closesAt));
    await notify(`📨 연구 스크럼 수집을 시작했습니다.\n마감: ${closesAt} (한국 시간)\nDM 성공 ${result.sent.length}명 / 실패 ${result.failed.length}명`);
    if (result.failed.length) await notify(`⚠️ 보고서 작성 DM을 ${result.failed.length}명에게 보내지 못했습니다. /대상목록과 DM 허용 설정을 확인하세요.`);
  }, { onError: error => console.error(`❌ 예약 DM 실패: ${error.message}`) });
  const deadlineScheduler = new ReportScheduler({ getSchedule: () => store.getDeadline(), setSchedule: value => store.setDeadline(value), flush: () => store.flush() }, async () => {
    const window = store.getCollection();
    if (!window || new Date() < new Date(window.closesAt)) return;
    const result = await service.run();
    if (result.skipped) await notify(`ℹ️ 보고서 마감: ${result.reason}`);
    else if (result.notificationError) console.error(`${result.notificationError} ${result.url}`);
  }, { onError: error => {
    console.error(`❌ 보고서 생성 실패: ${error.message}`);
    notify(`❌ 보고서 생성에 실패했습니다. 원문은 보관되어 있습니다.\n${error.message}`)
      .catch(() => console.error('실패 알림을 전송하지 못했습니다.'));
  } });
  return { guildId, store, service, collection, scheduler, deadlineScheduler, notify };
}

export async function startRuntime(client, config, token) {
  const runtime = await createRuntime(client, config);
  await registerCommandsToGuild(client.user.id, runtime.guildId, token);
  const commands = createCommandHandler(runtime);
  const handler = async interaction => {
    try { if (!await runtime.collection.handle(interaction)) await commands(interaction); }
    catch (error) { console.error(`명령 처리 실패: ${error.message}`); }
  };
  client.on(Events.InteractionCreate, handler);
  runtime.scheduler.start();
  runtime.deadlineScheduler.start();
  console.log(`✅ 개인 DM 일정: ${describeSchedule(runtime.store.getSchedule())}`);
  console.log(`✅ 보고서 마감: ${describeSchedule(runtime.store.getDeadline())}`);
  return { ...runtime, close() { runtime.scheduler.stop(); runtime.deadlineScheduler.stop(); client.off(Events.InteractionCreate, handler); } };
}
