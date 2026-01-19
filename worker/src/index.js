const QUESTION_MS = 20_000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS: gelen origin'i yansıt (Pages/GitHub vb. fark etmesin)
    const origin = req.headers.get("Origin") || "";
  const allowed = new Set([
  env.APP_ORIGIN,              // ör: https://asn-quiz.pages.dev
  env.APP_ORIGIN_2 || ""       // opsiyonel ikinci origin
]);

const allowOrigin = allowed.has(origin) ? origin : env.APP_ORIGIN;


    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // create game
    if (url.pathname === "/api/game/create" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const quizKey = body.quizKey || "quiz:siber";
      const gameId = crypto.randomUUID().slice(0, 8).toUpperCase();
      const hostToken = crypto.randomUUID();

      const id = env.GAME.idFromName(gameId);
      const stub = env.GAME.get(id);
      await stub.fetch("https://do/init", {
        method: "POST",
        body: JSON.stringify({ gameId, hostToken, quizKey }),
      });

      return json({ gameId, hostToken }, allowOrigin);
    }

    // proxy to DO
    const m = url.pathname.match(/^\/api\/game\/([A-Z0-9]{8})(\/.*)?$/);
    if (m) {
      const gameId = m[1];
      const rest = m[2] || "/";
      const id = env.GAME.idFromName(gameId);
      const stub = env.GAME.get(id);

      const doUrl = new URL("https://do" + rest);
      doUrl.search = url.search;

      const r = await stub.fetch(doUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });

      try {
    const r = await stub.fetch(doUrl.toString(), {...});

    const headers = new Headers(r.headers);
    headers.set("Access-Control-Allow-Origin", allowOrigin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return new Response(r.body, { status: r.status, headers });

  } catch (e) {
    // DO throw Response(...) yaptıysa buraya düşer
    if (e instanceof Response) {
      const headers = new Headers(e.headers);
      headers.set("Access-Control-Allow-Origin", allowOrigin);
      headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return new Response(e.body, { status: e.status, headers });
    }
    return new Response("Internal Error", { status: 500, headers: corsHeaders(allowOrigin) });
  }
    }

return new Response("Not found", { status: 404, headers: corsHeaders(allowOrigin) });

  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/init" && req.method === "POST") {
      const { gameId, hostToken, quizKey } = await req.json();
      await this.state.storage.put("gameId", gameId);
      await this.state.storage.put("hostToken", hostToken);
      await this.state.storage.put("quizKey", quizKey);

      await this.state.storage.put("phase", "lobby"); // lobby | question | leaderboard | finished
      await this.state.storage.put("qIndex", -1);
      await this.state.storage.put("qTotal", null);

      await this.state.storage.put("players", {}); // {playerId:{name,scoreMs,correct,token}}
      await this.state.storage.put("answers", {}); // {playerId:{choice,t}}

      return new Response("ok");
    }

    if (path === "/join" && req.method === "POST") {
      const { name } = await req.json();
      const players = (await this.state.storage.get("players")) || {};
      const playerId = crypto.randomUUID().slice(0, 6).toUpperCase();
      const playerToken = crypto.randomUUID();

      // scoreMs: toplam süre (ms) - küçük iyi, correct: doğru sayısı
      players[playerId] = {
        name: String(name || "Anon"),
        scoreMs: 0,
        correct: 0,
        token: playerToken,
      };
      await this.state.storage.put("players", players);

      return this.ok({ playerId, playerToken });
    }

    if (path === "/state" && req.method === "GET") {
      const phase = (await this.state.storage.get("phase")) || "lobby";
      const qIndex = (await this.state.storage.get("qIndex")) ?? -1;
      const qTotal = (await this.state.storage.get("qTotal")) ?? null;
      const endsAt = (await this.state.storage.get("endsAt")) || null;
      const qPublic = (await this.state.storage.get("qPublic")) || null;
      const players = (await this.state.storage.get("players")) || {};

      // önce correct desc, eşitse scoreMs asc
      const top4 = Object.entries(players)
        .map(([id, p]) => ({
          id,
          name: p.name,
          correct: p.correct ?? 0,
          scoreMs: p.scoreMs ?? 0,
        }))
        .sort((a, b) => (b.correct - a.correct) || (a.scoreMs - b.scoreMs))
        .slice(0, 4);

      return this.ok({
        phase,
        qIndex,
        qTotal,
        endsAt,
        q: qPublic,
        playerCount: Object.keys(players).length,
        top4,
      });
    }

    if (path === "/start" && req.method === "POST") {
      await this.mustBeHost(req);
      await this.state.storage.put("phase", "lobby");
      await this.state.storage.put("qIndex", -1);
      await this.nextQuestion();
      return this.ok({ ok: true });
    }

    if (path === "/next" && req.method === "POST") {
      await this.mustBeHost(req);
      await this.nextQuestion();
      return this.ok({ ok: true });
    }

    if (path === "/answer" && req.method === "POST") {
      const { playerId, playerToken, choice } = await req.json();
      const phase = await this.state.storage.get("phase");
      if (phase !== "question") return this.bad("Not accepting answers now");

      const players = (await this.state.storage.get("players")) || {};
      const p = players[playerId];
      if (!p || p.token !== playerToken) return this.bad("Bad player");

      const endsAt = await this.state.storage.get("endsAt");
      if (!endsAt || Date.now() > endsAt) return this.bad("Time is up");

      const answers = (await this.state.storage.get("answers")) || {};
      if (answers[playerId]) return this.bad("Already answered");

      answers[playerId] = { choice: Number(choice), t: Date.now() };
      await this.state.storage.put("answers", answers);

      return this.ok({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  ok(obj) {
    return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
  }
  bad(msg, status = 400) {
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async mustBeHost(req) {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace("Bearer ", "");
    const hostToken = await this.state.storage.get("hostToken");
    if (!token || token !== hostToken) throw new Response("Unauthorized", { status: 401 });
  }

  async nextQuestion() {
    const quizKey = await this.state.storage.get("quizKey");
    const raw = await this.env.QUIZ_KV.get(quizKey);
    if (!raw) throw new Error("Quiz not found in KV: " + quizKey);
    const quiz = JSON.parse(raw);

    await this.state.storage.put("qTotal", quiz.length);

    let qIndex = (await this.state.storage.get("qIndex")) ?? -1;
    qIndex += 1;

    if (qIndex >= quiz.length) {
      await this.state.storage.put("phase", "finished");
      await this.state.storage.delete("qPublic");
      await this.state.storage.delete("qCorrect");
      await this.state.storage.delete("endsAt");
      return;
    }

    const q = quiz[qIndex];
    await this.state.storage.put("qIndex", qIndex);
    await this.state.storage.put("qCorrect", Number(q.correct));
    await this.state.storage.put("qPublic", { text: q.q, choices: q.choices });

    await this.state.storage.put("answers", {});
    await this.state.storage.put("phase", "question");

    const endsAt = Date.now() + QUESTION_MS;
    await this.state.storage.put("endsAt", endsAt);
    await this.state.storage.setAlarm(endsAt);
  }

  async alarm() {
    const phase = await this.state.storage.get("phase");
    if (phase !== "question") return;

    const correct = await this.state.storage.get("qCorrect");
    const endsAt = await this.state.storage.get("endsAt");
    const answers = (await this.state.storage.get("answers")) || {};
    const players = (await this.state.storage.get("players")) || {};

    const qStart = (endsAt ?? Date.now()) - QUESTION_MS;

    // Her oyuncu için: doğruysa elapsed ekle, yanlış/cevapsızsa QUESTION_MS ceza
    for (const [playerId, p] of Object.entries(players)) {
      if (typeof p.scoreMs !== "number") p.scoreMs = 0;
      if (typeof p.correct !== "number") p.correct = 0;

      const ans = answers[playerId];

      if (!ans) {
        p.scoreMs += QUESTION_MS;
        continue;
      }

      if (ans.choice !== correct) {
        p.scoreMs += QUESTION_MS;
        continue;
      }

      const t = Math.min(ans.t, endsAt);
      const elapsed = Math.max(0, Math.min(QUESTION_MS, t - qStart));
      p.scoreMs += elapsed;
      p.correct += 1;
    }

    await this.state.storage.put("players", players);
    await this.state.storage.put("phase", "leaderboard");
  }
}
