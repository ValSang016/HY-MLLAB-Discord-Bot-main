import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { ReportStore } from './reportStore.js';
import { getResearchScrumTemplate } from './researchTemplate.js';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const PREFIX = 'rd';
const names = new Set(['대상추가', '대상삭제', '대상목록', '수집시작']);
const stamp = date => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));

export function collectionCommands() {
  return [
    new SlashCommandBuilder().setName('대상추가').setDescription('다음 예약 시간에 DM을 받을 사람을 등록합니다')
      .addUserOption(option => option.setName('사용자').setDescription('이 서버의 수집 대상').setRequired(true)),
    new SlashCommandBuilder().setName('대상삭제').setDescription('수집 대상을 삭제하고 기존 입력 버튼을 무효화합니다')
      .addUserOption(option => option.setName('사용자').setDescription('삭제할 대상').setRequired(true)),
    new SlashCommandBuilder().setName('대상목록').setDescription('등록된 보고서 수집 대상을 확인합니다'),
    new SlashCommandBuilder().setName('수집시작').setDescription('현재 수집 시간 안에서만 작성 DM을 다시 보냅니다'),
  ].map(command => command.setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());
}

export class RecipientStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.recipients = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
    if (!Array.isArray(this.recipients) || this.recipients.some(item =>
      !item || !/^\d+$/.test(item.userId) || typeof item.token !== 'string' || !/^[a-f0-9]{32}$/.test(item.token))) {
      throw new Error('수집 대상 파일 형식이 올바르지 않습니다.');
    }
  }
  save(recipients) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(recipients, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      this.recipients = recipients;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  list() { return structuredClone(this.recipients); }
  get(userId) { return this.list().find(item => item.userId === userId); }
  add(userId, name = userId) {
    if (!/^\d+$/.test(userId)) throw new Error('사용자 ID가 올바르지 않습니다.');
    const existing = this.get(userId);
    if (existing) return existing;
    const recipient = { userId, name, token: randomUUID().replaceAll('-', '') };
    this.save([...this.recipients, recipient]);
    return recipient;
  }
  remove(userId) {
    const found = Boolean(this.get(userId));
    if (found) this.save(this.recipients.filter(item => item.userId !== userId));
    return found;
  }
}

export class DmCollection {
  constructor(client, { dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR, reportStoreForGuild, allowedGuildId,
    onTestSubmitted, onError = console.error, now = () => new Date() } = {}) {
    Object.assign(this, { client, dataDir, reportStoreForGuild, allowedGuildId, onTestSubmitted, onError, now });
    this.stores = new Map();
    this.reportStores = new Map();
    this.sending = new Set();
    this.tests = new Map();
  }
  checkGuild(guildId) {
    if (!/^\d+$/.test(guildId) || (this.allowedGuildId && guildId !== this.allowedGuildId)) throw new Error('설정된 서버가 아닙니다.');
  }
  recipients(guildId) {
    this.checkGuild(guildId);
    if (!this.stores.has(guildId)) this.stores.set(guildId, new RecipientStore(path.join(this.dataDir, `recipients-${guildId}.json`)));
    return this.stores.get(guildId);
  }
  reports(guildId) {
    this.checkGuild(guildId);
    if (this.reportStoreForGuild) return this.reportStoreForGuild(guildId);
    if (!this.reportStores.has(guildId)) this.reportStores.set(guildId, new ReportStore(path.join(this.dataDir, `reports-${guildId}.json`)));
    return this.reportStores.get(guildId);
  }
  async sendRequest(guild, recipient, window, isTest = false) {
    const member = await guild.members.fetch({ user: recipient.userId, force: true });
    if (member.user.bot) throw new Error('봇 계정은 수집 대상이 될 수 없습니다.');
    if (isTest) {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('서버 관리 권한이 필요합니다.');
    } else if (this.recipients(guild.id).get(recipient.userId)?.token !== recipient.token ||
        !this.reports(guild.id).isCollecting(window.id, this.now())) {
      throw new Error('수집 시간이 아니거나 대상에서 삭제되었습니다.');
    }
    const button = new ButtonBuilder().setCustomId(`${PREFIX}:o:${guild.id}:${recipient.userId}:${recipient.token}:${window.id}`)
      .setLabel(isTest ? '테스트 보고서 작성' : '보고서 작성').setStyle(ButtonStyle.Primary);
    await member.user.send({
      content: `**${guild.name} — ${isTest ? '테스트 ' : ''}연구 스크럼 작성 요청**\n마감: ${stamp(window.closesAt)} (한국 시간)\n마감 시간 이후에는 답변을 저장하지 않습니다.\n제출 내용은 작성자별 원문 그대로 취합해 Notion에 저장합니다.${isTest ? '\n이 테스트는 정기 수집과 별개이며 답변 즉시 테스트 보고서를 만듭니다.' : '\n마감 전 재제출하면 본인의 이전 답변을 교체합니다.'}\n\n${getResearchScrumTemplate()}`,
      components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] },
    });
  }
  async requestAll(guildId, { scheduled = false, durationMinutes = null } = {}) {
    this.checkGuild(guildId);
    if (this.sending.has(guildId)) throw new Error('이미 DM 요청을 보내고 있습니다.');
    this.sending.add(guildId);
    try {
      const store = this.reports(guildId);
      const recipients = this.recipients(guildId).list();
      if (!recipients.length) return { sent: [], failed: [] };
      const participants = recipients.map(({ userId, name }) => ({ userId, name }));
      const window = scheduled
        ? store.beginCollection(participants, this.now())
        : durationMinutes
          ? store.beginCollection(participants, this.now(), new Date(this.now().getTime() + durationMinutes * 60000))
          : store.getCollection();
      if (!window || !store.isCollecting(window.id, this.now())) throw new Error('지금은 수집 시간이 아닙니다. 예약 시간에만 수집을 시작합니다.');
      const guild = await this.client.guilds.fetch(guildId);
      const result = { sent: [], failed: [] };
      for (const recipient of recipients.filter(person => window.participants.some(item => item.userId === person.userId))) {
        try { await this.sendRequest(guild, recipient, window); result.sent.push(recipient.userId); }
        catch { result.failed.push(recipient.userId); }
      }
      return result;
    } finally { this.sending.delete(guildId); }
  }
  async requestOne(guildId, userId) {
    this.checkGuild(guildId);
    const window = { id: randomUUID().replaceAll('-', '').slice(0, 12), closesAt: new Date(this.now().getTime() + 10 * 60000).toISOString() };
    const recipient = { userId, token: randomUUID().replaceAll('-', '') };
    const key = `${guildId}:${userId}`;
    this.tests.set(key, { ...window, token: recipient.token });
    try {
      const guild = await this.client.guilds.fetch(guildId);
      await this.sendRequest(guild, recipient, window, true);
      return true;
    } catch { this.tests.delete(key); return false; }
  }
  async handle(interaction) {
    const command = interaction.isChatInputCommand() && names.has(interaction.commandName);
    const component = (interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith(`${PREFIX}:`);
    if (!command && !component) return false;
    try {
      if (command) await this.handleCommand(interaction);
      else await this.handleResponse(interaction);
    } catch (error) {
      this.onError(`DM 수집 처리 실패: ${error.message}`);
      const content = `❌ ${error.message}`;
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch { this.onError('DM 수집 오류 안내 전송 실패'); }
    }
    return true;
  }
  async handleCommand(interaction) {
    if (!interaction.inGuild() || (this.allowedGuildId && interaction.guildId !== this.allowedGuildId) ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '설정된 서버의 서버 관리 권한이 필요합니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = await this.client.guilds.fetch(interaction.guildId);
    const store = this.recipients(guild.id);
    const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    if (interaction.commandName === '대상목록') {
      const users = store.list();
      if (users.length > 50) {
        await interaction.editReply({ content: `등록된 수집 대상: ${users.length}명`, files: [{ attachment: Buffer.from(users.map(item => `${item.name || ''} ${item.userId}`).join('\n')), name: 'recipients.txt' }] });
      } else await reply(users.length ? users.map(item => `<@${item.userId}>`).join('\n') : '등록된 수집 대상이 없습니다.');
    } else if (interaction.commandName === '수집시작') {
      const result = await this.requestAll(guild.id);
      const failures = result.failed.slice(0, 30).map(id => `<@${id}>`).join(', ');
      await reply(`DM 성공 ${result.sent.length}명 / 실패 ${result.failed.length}명${failures ? `\n실패 대상: ${failures}\nDM 허용 설정과 서버 가입 상태를 확인하세요.` : ''}`);
    } else {
      const user = interaction.options.getUser('사용자', true);
      if (interaction.commandName === '대상삭제') {
        await reply(store.remove(user.id) ? `<@${user.id}>을 삭제했습니다. 이전 DM 버튼도 무효화했습니다.` : '등록되지 않은 사용자입니다.');
        return;
      }
      if (user.bot) { await reply('봇 계정은 등록할 수 없습니다.'); return; }
      const member = await guild.members.fetch({ user: user.id, force: true });
      store.add(user.id, member.displayName);
      await reply(`<@${user.id}>을 등록했습니다. 다음 예약 수집부터 개인 DM을 보냅니다.`);
    }
  }
  async handleResponse(interaction) {
    const match = interaction.customId.match(/^rd:(o|s):(\d+):(\d+):([a-f0-9]{32}):([a-f0-9]{12})$/);
    if (!match || interaction.inGuild() || interaction.user.id !== match[3] ||
        (this.allowedGuildId && match[2] !== this.allowedGuildId)) {
      await interaction.reply({ content: '본인에게 발송된 유효한 요청만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, action, guildId, userId, token, windowId] = match;
    const key = `${guildId}:${userId}`;
    const testWindow = this.tests.get(key);
    const isTest = Boolean(testWindow && testWindow.id === windowId && testWindow.token === token);
    const valid = () => isTest
      ? this.tests.get(key) === testWindow && this.now().getTime() < Date.parse(testWindow.closesAt)
      : this.recipients(guildId).get(userId)?.token === token && this.reports(guildId).isCollecting(windowId, this.now()) &&
        this.reports(guildId).getCollection().participants.some(person => person.userId === userId);
    if (!valid()) {
      await interaction.reply({ content: '수집 시간이 아니거나 만료된 요청입니다. 답변을 저장하지 않았습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'o' && interaction.isButton()) {
      const input = new TextInputBuilder().setCustomId('content').setLabel('연구 스크럼 내용')
        .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(4000).setRequired(true)
        .setPlaceholder('연구 목표, 진행 내용, 결과와 근거, 문제, 다음 계획을 작성해주세요.');
      const previous = !isTest && this.reports(guildId).getSubmissions().find(entry => entry.authorId === userId);
      input.setValue(previous?.content || getResearchScrumTemplate());
      const modal = new ModalBuilder().setCustomId(`rd:s:${guildId}:${userId}:${token}:${windowId}`).setTitle(isTest ? '테스트 연구 스크럼' : '연구 스크럼 작성')
        .addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    } else if (action === 's' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      // 입력창을 열어 둔 채 마감을 넘기거나 REST 조회 중 삭제된 경우에도 저장하지 않는다.
      if (!valid()) { await interaction.editReply('수집 시간이 끝났거나 대상에서 삭제되었습니다. 답변을 저장하지 않았습니다.'); return; }
      const content = interaction.fields.getTextInputValue('content').trim();
      if (!content || content.length > 4000) { await interaction.editReply('내용은 1~4,000자로 입력해주세요.'); return; }
      if (content === getResearchScrumTemplate()) { await interaction.editReply('템플릿에 연구 내용을 작성한 뒤 제출해주세요.'); return; }
      const entry = { authorId: userId, authorName: member.displayName, content, collectionId: windowId };
      if (isTest) {
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('서버 관리 권한이 필요합니다.');
        if (!this.onTestSubmitted) throw new Error('테스트 보고서 서비스가 연결되지 않았습니다.');
        this.tests.delete(key);
        const result = await this.onTestSubmitted(entry);
        await interaction.editReply({ content: `테스트 보고서를 저장했습니다.\n${result.url}${result.notificationError ? `\n${result.notificationError}` : ''}`, allowedMentions: { parse: [] } });
      } else {
        this.reports(guildId).submit(entry, this.now());
        await interaction.editReply('답변을 저장했습니다. 마감 전에는 같은 버튼으로 수정할 수 있습니다. 마감 후 답변은 저장하지 않습니다.');
      }
    }
  }
}
