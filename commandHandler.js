import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describeSchedule, parseWeekdays } from './reportStore.js';

const COMMAND_NAMES = new Set(['테스트전송', '알림설정', '마감설정', '알림확인', '알림끄기', '보고서생성']);

export function createCommandHandler({ guildId, store, scheduler, deadlineScheduler, service, collection, onError = console.error }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || !COMMAND_NAMES.has(interaction.commandName)) return;
    try {
      if (!interaction.inGuild() || interaction.guildId !== guildId ||
          !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '설정된 서버의 서버 관리 권한이 필요합니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let message;
      switch (interaction.commandName) {
        case '테스트전송': {
          const result = await collection.requestOne(guildId, interaction.user.id);
          message = result ? '본인에게 테스트 작성 DM을 보냈습니다. 입력한 내용으로 테스트 보고서를 Notion에 저장합니다. 정기 수집에는 반영되지 않습니다.' : '테스트 DM을 보낼 수 없습니다. DM 허용 설정을 확인하세요.';
          break;
        }
        case '보고서생성': {
          const result = await service.run();
          message = result.skipped ? result.reason : `보고서를 저장했습니다.\n${result.url}${result.notificationError ? `\n${result.notificationError}` : ''}`;
          break;
        }
        case '알림설정': {
          const schedule = scheduler.update({ weekdays: parseWeekdays(interaction.options.getString('요일', true)), time: interaction.options.getString('시간', true), enabled: true });
          message = `개인 DM 발송 일정을 저장했습니다.\n${describeSchedule(schedule)}`;
          break;
        }
        case '마감설정': {
          const active = store.getCollection();
          if (active && store.isCollecting(active.id)) throw new Error('현재 수집 기간에는 마감을 변경할 수 없습니다. 마감 후 변경하거나 /알림끄기로 수집을 먼저 중지하세요.');
          const schedule = deadlineScheduler.update({ weekdays: parseWeekdays(interaction.options.getString('요일', true)), time: interaction.options.getString('시간', true), enabled: true });
          message = `보고서 생성 마감 일정을 저장했습니다.\n${describeSchedule(schedule)}`;
          break;
        }
        case '알림끄기':
          store.disableSchedules();
          scheduler.stop();
          deadlineScheduler.stop();
          message = '예약 DM과 자동 보고서 생성을 중지하고 현재 답변 수집도 닫았습니다. /알림설정, /마감설정으로 각각 다시 켤 수 있습니다.';
          break;
        case '알림확인':
          message = `DM: ${describeSchedule(store.getSchedule())}\n마감: ${describeSchedule(store.getDeadline())}\n등록 대상: ${collection.recipients(guildId).list().length}명\n답변 대기 목록에 저장된 원문: ${store.getSubmissions().length}명`;
          break;
      }
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
    } catch (error) {
      onError(error);
      try {
        const response = { content: `❌ ${error.message}`, allowedMentions: { parse: [] } };
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
      } catch (replyError) { onError(replyError); }
    }
  };
}
