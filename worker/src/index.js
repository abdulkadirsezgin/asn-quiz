const QUESTION_MS = 20_000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // --- CORS: allowlist (Pages + opsiyonel ikinci origin) ---
    const origin = req.headers.get("Origin") || "";
    const allowed = new Set([env.APP_ORIGIN, env.APP_ORIGIN_2 || ""]);
    const allowOrigin = allowed.has(origin) ? origin : env.APP_ORIGIN;

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // --- Create game ---
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

    // --- Proxy to Durable Object ---
    const m = url.pathname.match(/^\/api\/game\/([A-Z0-9]{8})(\/.*)?$/);
    if (m) {
      const gameId = m[1];
      const rest = m[2] || "/";

      const id = env.GAME.idFromName(gameId);
      const stub = env.GAME.get(id);

      const doUrl = new URL("https://do" + rest);
      doUrl.search = url.search;

      try {
        const r = await stub.fetch(doUrl.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        });

        return withCors(r, allowOrigin);
      } catch (e) {
        // DO tarafı throw Response(...) yaparsa buraya düşebilir.
        if (e instanceof Response) return withCors(e, allowOrigin);
        return new Response("Internal Error", { status: 500, headers: corsHeaders(allowOrigin) });
      }
    }

    // Not found (CORS header'lı)
    return new Response("Not found", { status: 404, headers: corsHeaders(allowOrigin) });
  },
};

function withCors(resp, origin) {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return new Response(resp.body, { status: resp.status, headers });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function json(obj, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ===================================================================
// Durable Object: GameRoom
// ===================================================================

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---------------- init ----------------
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
      await this.state.storage.delete("endsAt");
      await this.state.storage.delete("qPublic");
      await this.state.storage.delete("qCorrect");

      return new Response("ok");
    }

    // ---------------- join ----------------
    if (path === "/join" && req.method === "POST") {
      const { name } = await req.json();

      const players = (await this.state.storage.get("players")) || {};
      const playerId = crypto.randomUUID().slice(0, 6).toUpperCase();
      const playerToken = crypto.randomUUID();

      players[playerId] = {
        name: String(name || "Anon"),
        scoreMs: 0,  // toplam süre: küçük daha iyi
        correct: 0,  // doğru sayısı: büyük daha iyi
        token: playerToken,
      };

      await this.state.storage.put("players", players);
      return this.ok({ playerId, playerToken });
    }

    // ---------------- state ----------------
    if (path === "/state" && req.method === "GET") {
      const phase = (await this.state.storage.get("phase")) || "lobby";
      const qIndex = (await this.state.storage.get("qIndex")) ?? -1;
      const qTotal = (await this.state.storage.get("qTotal")) ?? null;
      const endsAt = (await this.state.storage.get("endsAt")) ?? null;
      const qPublic = (await this.state.storage.get("qPublic")) ?? null;

      const players = (await this.state.storage.get("players")) || {};

      // Sıralama: correct desc, sonra scoreMs asc
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

    // ---------------- start ----------------
    if (path === "/start" && req.method === "POST") {
      await this.mustBeHost(req);

      await this.state.storage.put("phase", "lobby");
      await this.state.storage.put("qIndex", -1);

      // İstersen burada skor resetleme yapabilirsin:
      // const players = (await this.state.storage.get("players")) || {};
      // for (const p of Object.values(players)) { p.scoreMs = 0; p.correct = 0; }
      // await this.state.storage.put("players", players);

      await this.nextQuestion();
      return this.ok({ ok: true });
    }

    // ---------------- next ----------------
    if (path === "/next" && req.method === "POST") {
      await this.mustBeHost(req);
      await this.nextQuestion();
      return this.ok({ ok: true });
    }

    // ---------------- answer ----------------
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

    if (!token || token !== hostToken) {
      // throw yerine Response döndürmek daha stabil (proxy catch'e gerek kalmadan)
      throw new Response("Unauthorized", { status: 401 });
    }
  }

  async nextQuestion() {
    const quizKey = await this.state.storage.get("quizKey");

    const raw = await this.env.QUIZ_KV.get(quizKey);
    if (!raw) throw new Error("Quiz not found in KV: " + quizKey);

    const quiz = JSON.parse(raw);
    await this.state.storage.put("qTotal", quiz.length);

    let qIndex = (await this.state.storage.get("qIndex")) ?? -1;
    qIndex += 1;

    // Quiz bitti
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

    // Kural:
    // - Doğru cevap: elapsed ekle (küçük daha iyi)
    // - Yanlış veya boş: QUESTION_MS ceza ekle
    for (const [playerId, p] of Object.entries(players)) {
      if (typeof p.scoreMs !== "number") p.scoreMs = 0;
      if (typeof p.correct !== "number") p.correct = 0;

      const ans = answers[playerId];

      // cevap yok -> ceza
      if (!ans) {
        p.scoreMs += QUESTION_MS;
        continue;
      }

      // yanlış -> ceza
      if (ans.choice !== correct) {
        p.scoreMs += QUESTION_MS;
        continue;
      }

      // doğru -> süre ekle + correct++
      const t = Math.min(ans.t, endsAt ?? ans.t);
      const elapsed = Math.max(0, Math.min(QUESTION_MS, t - qStart));
      p.scoreMs += elapsed;
      p.correct += 1;
    }

    await this.state.storage.put("players", players);
    await this.state.storage.put("phase", "leaderboard");
  }
}
