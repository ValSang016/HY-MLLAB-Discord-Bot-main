import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { collectionCommands } from './dmCollection.js';

function scheduleCommand(name, description) {
  return new SlashCommandBuilder().setName(name).setDescription(description)
    .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('요일').setDescription('예: 일 또는 월,수,금').setRequired(true).setMaxLength(50))
    .addStringOption(option => option.setName('시간').setDescription('한국 시간, 24시간제 HH:mm. 예: 20:30').setRequired(true).setMinLength(5).setMaxLength(5));
}

export const commands = [
  ...[
    new SlashCommandBuilder().setName('테스트전송').setDescription('본인에게 연구 스크럼 DM을 보내고 테스트 Notion 보고서를 만듭니다'),
    new SlashCommandBuilder().setName('알림확인').setDescription('DM 발송 일정, 연구 스크럼 마감 일정과 대기 건수를 확인합니다'),
    new SlashCommandBuilder().setName('알림끄기').setDescription('예약 DM 발송과 자동 보고서 생성을 모두 중지합니다'),
    new SlashCommandBuilder().setName('보고서생성').setDescription('현재 모인 답변으로 즉시 연구 스크럼 보고서를 생성합니다'),
    new SlashCommandBuilder().setName('임의마감').setDescription('현재 수집을 즉시 닫고 보고서를 생성해 공지합니다'),
  ].map(command => command.setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON()),
  scheduleCommand('알림설정', '반복 요일과 개인 DM 발송 시간을 설정하고 DM 예약을 켭니다').toJSON(),
  scheduleCommand('마감설정', '연구 스크럼을 Notion 보고서로 만들 요일과 시간을 설정합니다').toJSON(),
  new SlashCommandBuilder().setName('임의시작').setDescription('지금 새 수집을 시작하고 대상자에게 DM을 보냅니다')
    .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(option => option.setName('유효시간').setDescription('답변을 받을 시간(분), 기본 180분').setMinValue(1).setMaxValue(10080)).toJSON(),
  ...collectionCommands(),
];

export async function registerCommandsToGuild(clientId, guildId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('✅ DM 수집 및 보고서 명령어 등록 완료');
}
