const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const rooms = new Map();
const dictionaryCache = new Map();
const WORDS = require('./supabase/functions/_shared/word-list.json');
const WORD_SET = new Set(WORDS);
const LONG_WORDS = WORDS;

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' }); res.end(JSON.stringify(data)); };
function body(req) { return new Promise((resolve,reject) => { let s=''; req.on('data',c=>{s+=c;if(s.length>50000)req.destroy()}); req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Invalid JSON'))}}); req.on('error',reject); }); }
function safe(room, viewer = null) { return { id:room.id, name:room.name, visibility:room.visibility, phase:room.phase, round:room.round, totalRounds:room.totalRounds, roundSeconds:room.roundSeconds, scoring:room.scoring, letters:room.phase==='playing'?room.letters:null, deadline:room.deadline, word:room.phase==='results'?room.target:null, dictionary:room.dictionary, players:[...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score,online:p.online,host:p.id===room.host,submitted:!!room.submissions[p.id],word:room.phase==='results'?room.submissions[p.id]?.word||null:undefined,points:room.phase==='results'?room.submissions[p.id]?.points:undefined})), me:viewer, host:viewer===room.host, submissions:room.phase==='results'?room.submissions:null }; }
function publish(room) { const data=JSON.stringify(safe(room)); for(const c of room.clients){try{c.write(`data: ${data}\n\n`)}catch{room.clients.delete(c)}} }
function chooseWord() { return LONG_WORDS[Math.floor(Math.random()*LONG_WORDS.length)]; }
function shuffle(word) { const a=word.toUpperCase().split(''); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a.join(''); }
function playerFor(room, req) { const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const id=req.headers['x-player-id']||u.searchParams.get('player'); const token=req.headers['x-player-token']||u.searchParams.get('token'); const p=room?.players.get(id); return p && p.token===token?p:null; }
async function dictionaryCheck(word) {
  const key=word.toLowerCase(); if(dictionaryCache.has(key))return dictionaryCache.get(key);
  if(WORD_SET.has(key)){const data={valid:true,source:'word-list'};dictionaryCache.set(key,data);return data}
  const id=process.env.OXFORD_APP_ID, secret=process.env.OXFORD_APP_KEY;
  if(id&&secret){
    try {
      const r=await fetch(`https://od-api.oxforddictionaries.com/api/v2/entries/en-gb/${encodeURIComponent(key)}`,{headers:{app_id:id,app_key:secret},signal:AbortSignal.timeout(6000)});
      if(r.ok){const data={valid:true,source:'oxford'};dictionaryCache.set(key,data);return data;}
      if(r.status===404){const data={valid:false,source:'oxford'};dictionaryCache.set(key,data);return data;}
      console.warn(`Oxford API returned ${r.status}; using the bundled English word list.`);
    } catch(e) { console.warn(`Oxford API lookup failed: ${e.message}; using the bundled English word list.`); }
  }
  const data={valid:false,source:'word-list'}; dictionaryCache.set(key,data); return data;
}
async function startRound(room) {
  room.phase='starting';
  const target=chooseWord();
  room.phase='playing'; room.round++; room.target=target; room.letters=shuffle(room.target); room.deadline=Date.now()+room.roundSeconds*1000; room.submissions={};
  if(room.timer)clearTimeout(room.timer);
  room.timer=setTimeout(()=>endRound(room),room.roundSeconds*1000);
  publish(room);
}
async function endRound(room) {
  if(room.phase!=='playing')return;
  if(room.timer)clearTimeout(room.timer); room.phase='results'; room.deadline=null;
  const list=Object.values(room.submissions).sort((a,b)=>b.word.length-a.word.length || a.at-b.at);
  list.forEach((s,i)=> { const p=room.players.get(s.playerId); if(!p)return; s.rank=i+1; s.points=room.scoring==='placement'?(i===0?3:i===1?2:i===2?1:0):s.word.length; p.score+=s.points; });
  publish(room);
}
function route(req,res){
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const parts=u.pathname.split('/').filter(Boolean);
  if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,oxford:!!(process.env.OXFORD_APP_ID&&process.env.OXFORD_APP_KEY),rooms:rooms.size});
  if(req.method==='GET'&&u.pathname==='/api/rooms')return json(res,200,{rooms:[...rooms.values()].filter(r=>r.visibility==='public'&&r.phase==='lobby').map(r=>({id:r.id,name:r.name,players:r.players.size,rounds:r.totalRounds,seconds:r.roundSeconds,scoring:r.scoring}))});
  if(parts[0]!=='api'||parts[1]!=='rooms')return serveStatic(req,res,u.pathname);
  if(req.method==='POST'&&parts.length===2){return body(req).then(({name,playerName,visibility,rounds,seconds,scoring})=>{
    const rid=crypto.randomBytes(6).toString('hex').toUpperCase(); const room={id:rid,name:String(name||`${playerName||'Player'}’s room`).slice(0,32),visibility:visibility==='private'?'private':'public',phase:'lobby',round:0,totalRounds:Math.max(1,Math.min(20,Number(rounds)||5)),roundSeconds:Math.max(15,Math.min(300,Number(seconds)||60)),scoring:scoring==='placement'?'placement':'letters',target:null,letters:null,deadline:null,submissions:{},players:new Map(),clients:new Set(),host:null,timer:null,dictionary:'Open English word list · SCOWL size 70 (US + UK)'};
    const player={id:crypto.randomUUID(),name:String(playerName||'Player').trim().slice(0,18)||'Player',token:crypto.randomBytes(24).toString('hex'),score:0,online:true}; room.host=player.id;room.players.set(player.id,player);rooms.set(rid,room);return json(res,201,{...safe(room,player.id),token:player.token});
  }).catch(e=>json(res,400,{error:e.message}));}
  if(parts.length<3)return json(res,404,{error:'Not found'});
  const room=rooms.get(parts[2]); if(!room)return json(res,404,{error:'Room not found. It may have ended.'});
  if(req.method==='POST'&&parts[3]==='join')return body(req).then(({playerName})=>{
    if(room.phase!=='lobby')return json(res,409,{error:'This game has already started.'});if(room.players.size>=12)return json(res,409,{error:'This room is full.'});
    const p={id:crypto.randomUUID(),name:String(playerName||'Player').trim().slice(0,18)||'Player',token:crypto.randomBytes(24).toString('hex'),score:0,online:true};room.players.set(p.id,p);publish(room);return json(res,201,{...safe(room,p.id),token:p.token});
  }).catch(e=>json(res,400,{error:e.message}));
  const player=playerFor(room,req); if(!player)return json(res,401,{error:'Join this room first.'});
  if(req.method==='POST'&&parts[3]==='leave'){
    room.players.delete(player.id);delete room.submissions[player.id];
    if(room.players.size===0){if(room.timer)clearTimeout(room.timer);rooms.delete(room.id)}
    else{if(room.host===player.id)room.host=room.players.keys().next().value;publish(room)}
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[3]==='events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});room.clients.add(res);res.write(`data: ${JSON.stringify(safe(room,player.id))}\n\n`);player.online=true;
    req.on('close',()=>{room.clients.delete(res);player.online=false;publish(room)});return;
  }
  if(req.method==='GET'&&parts.length===3)return json(res,200,safe(room,player.id));
  if(req.method==='POST'&&parts[3]==='start'){
    if(player.id!==room.host)return json(res,403,{error:'Only the host can start the game.'});if(room.phase!=='lobby'&&room.phase!=='results')return json(res,409,{error:'The round is still in progress.'});if(room.round>=room.totalRounds)return json(res,409,{error:'All rounds have been played.'});return startRound(room).then(()=>json(res,200,safe(room,player.id))).catch(e=>json(res,503,{error:e.message}));
  }
  if(req.method==='POST'&&parts[3]==='submit')return body(req).then(async({word})=>{
    if(room.phase!=='playing')return json(res,409,{error:'This round is closed.'});if(room.submissions[player.id])return json(res,409,{error:'You have already submitted a word.'});
    const value=String(word||'').toLowerCase().trim();if(!/^[a-z]{8,32}$/.test(value))return json(res,400,{error:'Enter a word with at least 8 letters.'});
    const available={};for(const ch of room.letters.toLowerCase())available[ch]=(available[ch]||0)+1;for(const ch of value){if(!available[ch])return json(res,400,{error:'That word cannot be made from these letters.'});available[ch]--;}
    const check=await dictionaryCheck(value);if(!check.valid)return json(res,422,{error:`“${value}” was not found in the ${check.source==='oxford'?'Oxford dictionary':'open English word list'}.`});
    if(room.phase!=='playing')return json(res,409,{error:'Time ran out before your word could be checked.'});room.submissions[player.id]={playerId:player.id,player:player.name,word:value,points:0,at:Date.now(),dictionary:check.source};publish(room);return json(res,200,{ok:true,source:check.source});
  }).catch(e=>json(res,400,{error:e.message}));
  json(res,404,{error:'Not found'});
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
function serveStatic(req,res,url){let target=path.join(ROOT,decodeURIComponent(url==='/'?'/index.html':url));if(!target.startsWith(ROOT))return json(res,403,{error:'Forbidden'});fs.readFile(target,(err,data)=>{if(err)return json(res,404,{error:'Not found'});res.writeHead(200,{'Content-Type':MIME[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});}
http.createServer((req,res)=>Promise.resolve(route(req,res)).catch(e=>{console.error(e);if(!res.headersSent)json(res,500,{error:'Something went wrong.'});})).listen(PORT,'0.0.0.0',()=>console.log(`Longword is running at http://localhost:${PORT}`));
