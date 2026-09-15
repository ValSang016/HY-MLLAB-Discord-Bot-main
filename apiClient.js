// API 키나 사용자 원문이 오류 응답/로그에 포함되지 않도록 본문은 노출하지 않는다.
export async function requestJson(url, { token, body, headers = {}, provider, method = 'POST', timeoutMs = 60000, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${provider} 연결 실패 또는 시간 초과입니다. Notion 저장 요청이었다면 페이지 생성 여부를 확인한 후 재시도하세요.`);
  }
  if (!response.ok) {
    throw new Error(`${provider} 요청 실패 (HTTP ${response.status}). API 키, 권한, 사용 한도를 확인하세요.`);
  }
  try { return await response.json(); } catch {
    throw new Error(`${provider} 응답을 읽을 수 없습니다. Notion 저장 요청이었다면 페이지 생성 여부를 확인하세요.`);
  }
}
