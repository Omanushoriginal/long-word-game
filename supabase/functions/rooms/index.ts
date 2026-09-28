import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import wordList from "../_shared/word-list.json" with { type: "json" };

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-player-id, x-player-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WORDS: string[] = wordList;
const WORD_SET = new Set(WORDS);
const LONG_WORDS = WORDS;

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const fail = (message: string, status = 400) => response(status, { error: message });
const isOxfordConfigured = () => !!(Deno.env.get("OXFORD_APP_ID") && Deno.env.get("OXFORD_APP_KEY"));
const roomDictionary = () => "Open English word list (US/UK)";

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
}
function code() { return [...crypto.getRandomValues(new Uint8Array(6))].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function newToken() { return `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`; }
function shuffle(word: string) {
  const a = word.toUpperCase().split("");
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  if (a.join("") === word.toUpperCase()) a.reverse();
  return a.join("");
}

async function dictionaryCheck(word: string) {
  if (WORD_SET.has(word)) return { valid: true, source: "word-list" };
  const id = Deno.env.get("OXFORD_APP_ID");
  const key = Deno.env.get("OXFORD_APP_KEY");
  if (!id || !key) return { valid: false, source: "word-list" };
  const result = await fetch(`https://od-api.oxforddictionaries.com/api/v2/entries/en-gb/${encodeURIComponent(word)}`, {
    headers: { app_id: id, app_key: key }, signal: AbortSignal.timeout(6000),
  });
  if (result.ok) return { valid: true, source: "oxford" };
  if (result.status === 404) return { valid: false, source: "oxford" };
  throw new Error(`Oxford API returned ${result.status}. Check the account and English dataset access.`);
}

async function broadcastRoom(roomId: string) {
  const channel = db.channel(`longword:${roomId}`, { config: { broadcast: { ack: true } } });
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = async () => { if (finished) return; finished = true; clearTimeout(timer); await db.removeChannel(channel); resolve(); };
    const timer = setTimeout(() => { void finish(); }, 1800);
    channel.subscribe(async status => {
      if (status === "SUBSCRIBED") {
        await channel.send({ type: "broadcast", event: "changed", payload: {} });
        await finish();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") await finish();
    });
  });
}

async function roomRecord(roomId: string) {
  const { data, error } = await db.from("longword_rooms").select("*").eq("id", roomId).maybeSingle();
  if (error) throw error;
  return data;
}
async function participant(roomId: string, playerId: string, token: string) {
  if (!roomId || !playerId || !token) return null;
  const { data, error } = await db.from("longword_players").select("id, room_id, name, token_hash").eq("room_id", roomId).eq("id", playerId).maybeSingle();
  if (error) throw error;
  if (!data || data.token_hash !== await hashToken(token)) return null;
  return data;
}

async function stateFor(roomId: string, playerId: string) {
  let room = await roomRecord(roomId);
  if (!room) throw new Error("Room not found. It may have ended.");
  if (room.phase === "playing" && new Date(room.deadline).getTime() <= Date.now()) {
    const { error } = await db.rpc("longword_finish_round", { room_code: roomId });
    if (error) throw error;
    await broadcastRoom(roomId);
    room = await roomRecord(roomId);
  }
  const [{ data: players, error: playersError }, { data: submissions, error: submissionsError }] = await Promise.all([
    db.from("longword_players").select("id, name, score, online").eq("room_id", roomId).order("joined_at"),
    db.from("longword_submissions").select("player_id, word, points, rank, submitted_at").eq("room_id", roomId).order("submitted_at"),
  ]);
  if (playersError) throw playersError;
  if (submissionsError) throw submissionsError;
  const playersById = new Map((players ?? []).map(p => [p.id, p]));
  const submitted = new Map((submissions ?? []).map(s => [s.player_id, s]));
  return {
    id: room.id, name: room.name, visibility: room.visibility, phase: room.phase,
    round: room.round, totalRounds: room.total_rounds, roundSeconds: room.round_seconds,
    scoring: room.scoring, letters: room.phase === "playing" ? room.letters : null,
    deadline: room.deadline, word: room.phase === "results" ? room.target : null,
    dictionary: room.dictionary, me: playerId, host: playerId === room.host_id,
    players: (players ?? []).map(p => ({
      id: p.id, name: p.name, score: p.score, online: p.online,
      host: p.id === room.host_id, submitted: submitted.has(p.id),
      ...(room.phase === "results" ? { word: submitted.get(p.id)?.word ?? null, points: submitted.get(p.id)?.points ?? 0 } : {}),
    })),
    submissions: room.phase === "results" ? Object.fromEntries((submissions ?? []).map(s => [s.player_id, {
      playerId: s.player_id, player: playersById.get(s.player_id)?.name ?? "Player",
      word: s.word, points: s.points, rank: s.rank, at: new Date(s.submitted_at).getTime(),
    }])) : null,
  };
}

async function doStart(room: Record<string, any>, playerId: string) {
  if (playerId !== room.host_id) throw new Error("Only the host can start the game.");
  if (room.phase === "playing") throw new Error("The round is still in progress.");
  if (room.round >= room.total_rounds) throw new Error("All rounds have been played.");
  const target = LONG_WORDS[Math.floor(Math.random() * LONG_WORDS.length)];
  const { error } = await db.rpc("longword_start_round", {
    room_code: room.id, requesting_player: playerId, round_word: target,
    letter_rack: shuffle(target), source_name: roomDictionary(),
  });
  if (error) throw error;
  await broadcastRoom(room.id);
  return stateFor(room.id, playerId);
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Use POST for this endpoint.", 405);
  try {
    const input = await req.json();
    const action = String(input.action ?? "");
    const roomId = String(input.roomId ?? "").toUpperCase();

    if (action === "health") return response(200, { ok: true, oxford: isOxfordConfigured() });
    if (action === "list") {
      const { data: rooms, error } = await db.from("longword_rooms").select("id, name, total_rounds, round_seconds, scoring").eq("visibility", "public").eq("phase", "lobby").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      const ids = (rooms ?? []).map(r => r.id);
      const { data: participants, error: pError } = ids.length ? await db.from("longword_players").select("room_id").in("room_id", ids) : { data: [], error: null };
      if (pError) throw pError;
      const counts = new Map<string, number>();
      for (const p of participants ?? []) counts.set(p.room_id, (counts.get(p.room_id) ?? 0) + 1);
      return response(200, { rooms: (rooms ?? []).map(r => ({ id: r.id, name: r.name, rounds: r.total_rounds, seconds: r.round_seconds, scoring: r.scoring, players: counts.get(r.id) ?? 0 })) });
    }

    if (action === "create") {
      const roomId = code();
      const playerId = crypto.randomUUID();
      const token = newToken();
      const playerName = String(input.playerName || "Player").trim().slice(0, 18) || "Player";
      const room = {
        id: roomId, name: String(input.name || `${playerName}’s room`).slice(0, 32),
        visibility: input.visibility === "private" ? "private" : "public", phase: "lobby", round: 0,
        total_rounds: Math.max(1, Math.min(20, Number(input.rounds) || 5)),
        round_seconds: Math.max(15, Math.min(300, Number(input.seconds) || 60)),
        scoring: input.scoring === "placement" ? "placement" : "letters",
        target: null, letters: null, deadline: null, dictionary: roomDictionary(), host_id: playerId,
      };
      const { error: rError } = await db.from("longword_rooms").insert(room);
      if (rError) throw rError;
      const { error: pError } = await db.from("longword_players").insert({ room_id: roomId, id: playerId, token_hash: await hashToken(token), name: playerName });
      if (pError) { await db.from("longword_rooms").delete().eq("id", roomId); throw pError; }
      return response(201, { ...await stateFor(roomId, playerId), token });
    }

    if (action === "join") {
      const room = await roomRecord(roomId);
      if (!room) return fail("Room not found. Check the code and try again.", 404);
      if (room.phase !== "lobby") return fail("This game has already started.", 409);
      const { count, error: cError } = await db.from("longword_players").select("id", { count: "exact", head: true }).eq("room_id", roomId);
      if (cError) throw cError;
      if ((count ?? 0) >= 12) return fail("This room is full.", 409);
      const playerId = crypto.randomUUID();
      const token = newToken();
      const name = String(input.playerName || "Player").trim().slice(0, 18) || "Player";
      const { error } = await db.from("longword_players").insert({ room_id: roomId, id: playerId, token_hash: await hashToken(token), name });
      if (error) throw error;
      await broadcastRoom(roomId);
      return response(201, { ...await stateFor(roomId, playerId), token });
    }

    if (action === "leave") {
      const p = await participant(roomId, String(input.playerId || ""), String(input.token || ""));
      if (!p) return fail("Join this room first.", 401);
      const room = await roomRecord(roomId);
      const { error } = await db.from("longword_players").delete().eq("room_id", roomId).eq("id", p.id);
      if (error) throw error;
      const { count } = await db.from("longword_players").select("id", { count: "exact", head: true }).eq("room_id", roomId);
      if (!count) await db.from("longword_rooms").delete().eq("id", roomId);
      else if (room?.host_id === p.id) {
        const { data: next } = await db.from("longword_players").select("id").eq("room_id", roomId).order("joined_at").limit(1).single();
        if (next) await db.from("longword_rooms").update({ host_id: next.id }).eq("id", roomId);
      }
      if (count) await broadcastRoom(roomId);
      return response(200, { ok: true });
    }

    const player = await participant(roomId, String(input.playerId || ""), String(input.token || ""));
    if (!player) return fail("Join this room first.", 401);
    if (action === "state") return response(200, await stateFor(roomId, player.id));
    if (action === "start") return response(200, await doStart(await roomRecord(roomId), player.id));
    if (action === "submit") {
      const word = String(input.word || "").toLowerCase().trim();
      if (!/^[a-z]{8,32}$/.test(word)) return fail("Enter a word with at least 8 letters.");
      const check = await dictionaryCheck(word);
      if (!check.valid) return fail(`“${word}” was not found in the ${check.source === "oxford" ? "Oxford dictionary" : "open English word list"}.`, 422);
      const { error } = await db.rpc("longword_submit", { room_code: roomId, requesting_player: player.id, submitted_word: word, source_name: check.source });
      if (error) {
        if (error.code === "23505") return fail("You have already submitted a word.", 409);
        throw error;
      }
      await broadcastRoom(roomId);
      return response(200, { ok: true, source: check.source });
    }
    return fail("Unknown action.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    return fail(message, 400);
  }
});
