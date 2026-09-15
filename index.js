import http from 'node:http';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from 'dotenv';
import { readReportConfig, startRuntime } from './botRuntime.js';

config();

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN을 .env에 설정하세요.');
  const reportConfig = readReportConfig();
  // DM 버튼/입력창으로만 수집한다. 일반 메시지 본문을 읽는 intent는 필요 없다.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let runtime;
  let server;
  let closing = false;
  function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    runtime?.close();
    client.destroy();
    server?.close();
    process.exitCode = code;
  }
  client.on(Events.Error, error => console.error(`Discord 오류: ${error.message}`));
  client.once(Events.ClientReady, async () => {
    try {
      runtime = await startRuntime(client, reportConfig, token);
      if (closing) { runtime.close(); return; }
      console.log(`✅ 보고서 봇 로그인: ${client.user.tag}`);
    } catch (error) {
      console.error(`시작 실패: ${error.message}`);
      shutdown(1);
    }
  });
  server = http.createServer((req, res) => {
    const ready = !closing && client.isReady() && Boolean(runtime);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ready ? 'OK' : 'NOT READY');
  });
  server.on('error', error => { console.error(`HTTP 서버 오류: ${error.message}`); shutdown(1); });
  server.listen(process.env.PORT || 3000);
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());
  try { await client.login(token); } catch (error) { shutdown(1); throw error; }
}

main().catch(error => { console.error(`❌ ${error.message}`); process.exitCode = 1; });
