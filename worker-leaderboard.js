/**
 * 무영씨엠 총무팀 대시보드 — 공용 등수표 저장소
 * Cloudflare Worker (무료 범위)
 *
 * 이 코드가 하는 일
 *   GET  /            → 게임별 상위 20위 목록을 돌려준다
 *   POST /            → 점수 한 건을 받는다  {g:"react"|"memory"|"math", name:"...", dept:"...", v:숫자}
 *
 * 대시보드 자료(집기비품·안전용품·통신공사)와는 아무 연결이 없습니다.
 * 이 저장소에는 이름과 점수만 들어갑니다.
 */

const GAMES = {
  react:  { label: "반응 속도",  lower: true,  min: 90,  max: 2000 },  // ms
  memory: { label: "짝 맞추기",  lower: true,  min: 16,  max: 200  },  // 뒤집기 횟수
  math:   { label: "30초 암산",  lower: false, min: 0,   max: 80   }   // 맞힌 문제
};
const KEEP = 20;                 // 게임마다 보관할 상위 기록 수
const MAX_PER_DAY_PER_IP = 60;   // 같은 곳에서 하루에 보낼 수 있는 점수 수

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};
const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS)
  });

/* 이름에서 위험한 문자를 걷어낸다 (화면에 그대로 나가므로) */
function cleanName(v, max) {
  return String(v == null ? "" : v)
    .replace(/[<>&"'`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 12);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.SCORES) return json({ error: "저장소(KV)가 연결되지 않았습니다" }, 500);

    /* ── 목록 보기 ── */
    if (request.method === "GET") {
      const out = {};
      for (const g of Object.keys(GAMES)) {
        out[g] = JSON.parse((await env.SCORES.get("board:" + g)) || "[]");
      }
      return json({ ok: true, boards: out, at: new Date().toISOString() });
    }

    /* ── 점수 보내기 ── */
    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "형식 오류" }, 400); }

      const g = String(body.g || "");
      const G = GAMES[g];
      if (!G) return json({ error: "알 수 없는 게임" }, 400);

      const v = Number(body.v);
      if (!isFinite(v) || v < G.min || v > G.max) {
        return json({ error: "점수 범위를 벗어났습니다" }, 400);
      }

      const name = cleanName(body.name, 12);
      if (!name) return json({ error: "이름을 넣어 주세요" }, 400);
      const dept = cleanName(body.dept, 10);

      // 같은 곳에서 너무 많이 보내면 막는다
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const cntKey = "cnt:" + today() + ":" + ip;
      const cnt = Number((await env.SCORES.get(cntKey)) || 0);
      if (cnt >= MAX_PER_DAY_PER_IP) {
        return json({ error: "오늘은 충분히 하셨습니다 🙂 내일 다시 도전해 주세요" }, 429);
      }
      await env.SCORES.put(cntKey, String(cnt + 1), { expirationTtl: 60 * 60 * 26 });

      // 등수표에 넣는다 — 사람마다 그 게임의 '최고 기록 한 줄'만 남긴다
      const key = "board:" + g;
      const list = JSON.parse((await env.SCORES.get(key)) || "[]");
      const who = name + "|" + dept;
      const mine = list.findIndex(r => (r.n + "|" + (r.t || "")) === who);
      const better = mine < 0 || (G.lower ? v < list[mine].v : v > list[mine].v);

      if (mine >= 0 && !better) {
        return json({ ok: true, updated: false, board: list, rank: mine + 1 });
      }
      if (mine >= 0) list.splice(mine, 1);
      list.push({ n: name, t: dept, v: Math.round(v * 100) / 100, d: today().slice(5) });
      list.sort((a, b) => (G.lower ? a.v - b.v : b.v - a.v));
      const trimmed = list.slice(0, KEEP);
      await env.SCORES.put(key, JSON.stringify(trimmed));

      const rank = trimmed.findIndex(r => (r.n + "|" + (r.t || "")) === who) + 1;
      return json({ ok: true, updated: true, board: trimmed, rank: rank || null });
    }

    return json({ error: "지원하지 않는 방식" }, 405);
  }
};
