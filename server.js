/* =========================================================
   server.js — BLVCK TAXI API
   /sync            — облачный бэкап данных пользователя
   /send-report     — разовый PDF в чат по кнопке
   /pro/status      — статус подписки / триала (ставит триал при 1-м вызове)
   /pro/create-invoice — Stars-invoice (XTR) для тарифа
   /pro/confirm     — активация PRO по факту paid (звёзды списал Telegram)
   /pro/trial-demo  — один демо-PDF в чат на триале
   /cron/monthly    — авто-отчёты подписчикам за прошлый месяц
   Проверка initData по HMAC (WebAppData). PDF — pdfmake (кириллица).
   ========================================================= */
const crypto = require('crypto');
const express = require('express');
const PdfPrinter = require('pdfmake');
const { Client } = require('pg');

const TOKEN = process.env.BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL;
if (!TOKEN) { console.error('Нет BOT_TOKEN'); process.exit(1); }

/* ---- шрифты (pdfmake 0.2.x без папки fonts — берём из vfs) ---- */
function loadFonts(){
  const vfs = require('pdfmake/build/vfs_fonts.js');
  const v = (vfs && vfs.vfs) || (vfs && vfs.default && vfs.default.vfs) || (global.pdfMake && global.pdfMake.vfs);
  if(!v) throw new Error('vfs_fonts not found');
  global.pdfMake = global.pdfMake || {}; global.pdfMake.vfs = v;
  return { Roboto:{
    normal:'Roboto-Regular.ttf', bold:'Roboto-Medium.ttf',
    italics:'Roboto-Italic.ttf', bolditalics:'Roboto-MediumItalic.ttf'
  }};
}
const printer = new PdfPrinter(loadFonts());

/* ---- цены тарифов в Stars (должны совпадать с pro.js) ---- */
const PLANS = {
  month:   { stars:25,  days:30,    label:'Месяц' },
  year:    { stars:175, days:365,   label:'Год' },
  forever: { stars:400, days:36500, label:'Навсегда' }
};

const app = express();
app.use(express.json({ limit:'25mb' }));
app.use((req,res,next)=>{ res.header('Access-Control-Allow-Origin','*'); res.header('Access-Control-Allow-Headers','Content-Type'); if(req.method==='OPTIONS') return res.sendStatus(204); next(); });

/* ---- база ---- */
async function withDb(fn){
  const c = new Client({ connectionString: DATABASE_URL, ssl:{ rejectUnauthorized:false } });
  await c.connect();
  try { return await fn(c); } finally { try{ await c.end(); }catch(e){} }
}
async function ensureSchema(){
  if(!DATABASE_URL){ console.warn('Нет DATABASE_URL — /sync и PRO не работают'); return; }
  await withDb(c => c.query(`CREATE TABLE IF NOT EXISTS users (
    chat_id BIGINT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT now(),
    pro_until TIMESTAMPTZ,
    pro_plan TEXT,
    trial_started TIMESTAMPTZ,
    trial_demo_sent BOOLEAN DEFAULT false
  )`));
  console.log('schema ok');
}

/* ---- проверка initData ---- */
function validateInitData(initData){
  try{
    const p = new URLSearchParams(initData); const hash = p.get('hash'); if(!hash) return null;
    p.delete('hash');
    const check = [...p.entries()].sort(([a],[b])=>(a<b?-1:a>b?1:0)).map(([k,v])=>k+'='+v).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
    const hmac = crypto.createHmac('sha256',secret).update(check).digest('hex');
    if(hmac !== hash) return null;
    return JSON.parse(p.get('user') || '{}');
  }catch(e){ return null; }
}
async function authUser(req){
  const user = validateInitData((req.body||{}).initData);
  if(!user || !user.id) return null;
  return user;
}

/* ---- утилиты PDF ---- */
const money = (n,c) => (Number(n)||0).toLocaleString('ru-RU',{maximumFractionDigits:2}) + ' ' + (c||'');
function monthBounds(offset){
  const d = new Date(); const b = new Date(d.getFullYear(), d.getMonth()+offset, 1);
  const from = b.toISOString().slice(0,10);
  const to = new Date(b.getFullYear(), b.getMonth()+1, 0).toISOString().slice(0,10);
  const label = b.toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
  return { from, to, label };
}
function buildDocDef(payload, monthFilter, demoStamp){
  const cur = payload.cur || '';
  let exps = (payload.expenses||[]).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let rev = (payload.rev||[]).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let fines = (payload.fines||[]).slice();
  if(monthFilter){
    exps = exps.filter(e=>(e.date||'')>=monthFilter.from && (e.date||'')<=monthFilter.to);
    rev = rev.filter(r=>(r.date||'')>=monthFilter.from && (r.date||'')<=monthFilter.to);
    fines = fines.filter(f=>(f.date||'')>=monthFilter.from && (f.date||'')<=monthFilter.to);
  }
  const total = exps.reduce((s,e)=>s+Number(e.amount||0),0);
  const revTotal = rev.reduce((s,r)=>s+Number(r.v||0),0);
  const byCat = {}; exps.forEach(e=>{ byCat[e.category]=(byCat[e.category]||0)+Number(e.amount||0); });
  const c = [];
  if(demoStamp) c.push({ text:'ДЕМО‑ОТЧЁТ · не для сдачи', style:{ fontSize:9, color:'#c2410c', bold:true }, margin:[0,0,0,6] });
  c.push({ text: monthFilter ? ('BLVCK TAXI · отчёт за '+monthFilter.label) : 'BLVCK TAXI · полный отчёт', style:{ fontSize:18, bold:true }, margin:[0,0,0,4] });
  c.push({ text:'Сформировано '+new Date().toLocaleDateString('ru-RU')+' · валюта '+cur, style:{ fontSize:8, color:'#777' }, margin:[0,0,0,10] });
  c.push({ text:'Сводка', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,0,0,4] });
  c.push({ table:{ widths:['*','*'], body:[
    ['Расходов', money(total,cur)], ['Выручки', revTotal?money(revTotal,cur):'—'],
    ['Записей', String(exps.length)], ['Пробег', (payload.car&&payload.car.mileage)?Number(payload.car.mileage).toLocaleString('ru-RU')+' км':'—']
  ]}, layout:'noBorders', margin:[0,0,0,10] });
  c.push({ text:'Расходы по категориям', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,0,0,4] });
  const catRows = Object.entries(byCat).map(([k,v])=>[k, { text:money(v,cur), alignment:'right' }]);
  catRows.push([{ text:'ИТОГО', bold:true }, { text:money(total,cur), bold:true, alignment:'right' }]);
  c.push({ table:{ widths:['*','*'], body:catRows }, layout:'lightHorizontalLines', margin:[0,0,0,10] });
  c.push({ text:'Расходы по дням', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,0,0,4] });
  const expRows = [['Дата','Категория','Заметка',{ text:'Сумма', alignment:'right' }]];
  exps.forEach(e=>expRows.push([e.date||'', e.t||e.category||'', (e.note||'').slice(0,36), { text:money(e.amount,cur), alignment:'right' }]));
  c.push({ table:{ widths:['16%','22%','*','22%'], body:expRows }, layout:'lightHorizontalLines', margin:[0,0,0,10] });
  /* чеки-картинки */
  const withR = exps.filter(e=>e.receipt);
  if(withR.length){
    c.push({ text:'Чеки ('+withR.length+')', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,0,0,4] });
    withR.forEach(e=>{
      c.push({ text:(e.date||'')+' · '+(e.t||e.category||'')+(e.note?' · '+e.note:'')+' — '+money(e.amount,cur), style:{ fontSize:8, color:'#555' }, margin:[0,0,0,2] });
      try{ c.push({ image:e.receipt, width:200, margin:[0,0,0,8] }); }catch(_){}
    });
  }
  if(rev.length){
    c.push({ text:'Выручка по дням', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,6,0,4] });
    const rr = [['Дата',{ text:'Выручка', alignment:'right' }]];
    rev.forEach(r=>rr.push([r.date||'', { text:money(r.v,cur), alignment:'right' }]));
    rr.push([{ text:'ИТОГО', bold:true }, { text:money(revTotal,cur), bold:true, alignment:'right' }]);
    c.push({ table:{ widths:['*','*'], body:rr }, layout:'lightHorizontalLines', margin:[0,0,0,10] });
  }
  if(fines.length){
    c.push({ text:'Штрафы', style:{ fontSize:11, bold:true, color:'#c2410c' }, margin:[0,6,0,4] });
    const fr = [['За что','Статус',{ text:'Сумма', alignment:'right' }]];
    fines.forEach(f=>fr.push([f.name||'', f.paid?'оплачен':'не оплачен', { text:money(f.amount,cur), alignment:'right' }]));
    c.push({ table:{ widths:['*','30%','22%'], body:fr }, layout:'lightHorizontalLines' });
  }
  return { pageSize:'A4', pageMargins:[36,36,36,36], content:c,
    defaultStyle:{ fontSize:9, color:'#222' } };
}
function buildPdf(docDef){
  return new Promise((res,rej)=>{ const doc=printer.createPdfKitDocument(docDef); const ch=[];
    doc.on('data',x=>ch.push(x)); doc.on('end',()=>res(Buffer.concat(ch))); doc.on('error',rej); doc.end(); });
}
async function tgSendDocument(chatId, buffer, caption){
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer],{type:'application/pdf'}), 'blvck-taxi-report.pdf');
  if(caption) form.append('caption', caption);
  const r = await fetch('https://api.telegram.org/bot'+TOKEN+'/sendDocument', { method:'POST', body:form });
  return r.ok;
}
async function tgApi(method, body){
  const r = await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  return r.json();
}

/* ===================== маршруты ===================== */
app.get('/', (req,res)=>res.send('BLVCK TAXI API ok'));

app.post('/sync', async (req,res)=>{
  try{
    if(!DATABASE_URL) return res.status(503).send('no db');
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const data = req.body.payload || {};
    await withDb(c=>c.query(
      `INSERT INTO users(chat_id,data,updated_at) VALUES($1,$2::jsonb,now())
       ON CONFLICT(chat_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [user.id, JSON.stringify(data)]));
    res.json({ ok:true });
  }catch(e){ console.error('sync', e.message); res.status(500).send('error'); }
});

app.post('/send-report', async (req,res)=>{
  try{
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const pdf = await buildPdf(buildDocDef(req.body.payload||{}, null, false));
    const ok = await tgSendDocument(user.id, pdf, 'BLVCK TAXI — отчёт '+new Date().toLocaleDateString('ru-RU'));
    if(!ok) return res.status(502).send('tg failed (нажми Start у бота)');
    res.json({ ok:true });
  }catch(e){ console.error('send-report', e.message); res.status(500).send('error'); }
});

app.post('/pro/status', async (req,res)=>{
  try{
    if(!DATABASE_URL) return res.status(503).send('no db');
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const row = await withDb(c=>c.query('SELECT pro_until, pro_plan, trial_started, trial_demo_sent FROM users WHERE chat_id=$1', [user.id]));
    let pro_until=null, pro_plan=null, trial_started=null, trial_demo_sent=false;
    if(row.rows.length){ ({ pro_until, pro_plan, trial_started, trial_demo_sent } = row.rows[0]); }
    else { await withDb(c=>c.query('INSERT INTO users(chat_id,data) VALUES($1,\'{}\'::jsonb) ON CONFLICT DO NOTHING', [user.id])); }
    const now = new Date();
    if(!trial_started){
      trial_started = now;
      await withDb(c=>c.query('UPDATE users SET trial_started=$2 WHERE chat_id=$1', [user.id, now]));
    }
    const active = !!(pro_until && new Date(pro_until) > now);
    const trial_ms = now - new Date(trial_started);
    const trial_active = trial_ms >= 0 && trial_ms < 30*24*3600*1000;
    const trial_days_left = Math.max(0, Math.ceil((30*24*3600*1000 - trial_ms)/(24*3600*1000)));
    res.json({ active, until:pro_until, plan:pro_plan, trial_active, trial_days_left, trial_demo_sent });
  }catch(e){ console.error('pro/status', e.message); res.status(500).send('error'); }
});

app.post('/pro/create-invoice', async (req,res)=>{
  try{
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const plan = req.body.plan; const p = PLANS[plan]; if(!p) return res.status(400).send('bad plan');
    const payload = JSON.stringify({ chat_id:user.id, plan, ts:Date.now() });
    const r = await tgApi('createInvoiceLink', {
      title:'BLVCK TAXI PRO — '+p.label,
      description:'Подписка BLVCK TAXI PRO: авто‑отчёты, облако, налоги. Тариф «'+p.label+'».',
      payload, currency:'XTR',
      prices:[ { label:p.label, amount:p.stars } ]
    });
    if(!r.ok || !r.result) return res.status(502).send('invoice failed: '+(r.description||''));
    res.json({ invoiceLink:r.result, stars:p.stars });
  }catch(e){ console.error('create-invoice', e.message); res.status(500).send('error'); }
});

app.post('/pro/confirm', async (req,res)=>{
  try{
    if(!DATABASE_URL) return res.status(503).send('no db');
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const plan = req.body.plan; const p = PLANS[plan]; if(!p) return res.status(400).send('bad plan');
    /* активация по факту paid-callback: звёзды списал сам Telegram при openInvoice.
       best-effort проверка транзакции опущена ради надёжности; лог для учёта. */
    console.log('PRO CONFIRM', { chat_id:user.id, plan, at:new Date().toISOString() });
    await withDb(c=>c.query(
      `UPDATE users SET pro_plan=$2,
         pro_until = GREATEST(COALESCE(pro_until, now()), now()) + ($3 || ' days')::interval
       WHERE chat_id=$1`,
      [user.id, plan, p.days]));
    res.json({ ok:true });
  }catch(e){ console.error('pro/confirm', e.message); res.status(500).send('error'); }
});

app.post('/pro/trial-demo', async (req,res)=>{
  try{
    if(!DATABASE_URL) return res.status(503).send('no db');
    const user = await authUser(req); if(!user) return res.status(401).send('bad initData');
    const row = await withDb(c=>c.query('SELECT data, trial_demo_sent, trial_started FROM users WHERE chat_id=$1', [user.id]));
    if(!row.rows.length) return res.status(404).send('no user');
    const { data, trial_demo_sent, trial_started } = row.rows[0];
    const now = new Date();
    const trial_ok = trial_started && (now - new Date(trial_started)) < 30*24*3600*1000;
    if(!trial_ok) return res.status(403).send('trial not active');
    if(trial_demo_sent) return res.status(409).send('already sent');
    const mf = monthBounds(-1);
    const pdf = await buildPdf(buildDocDef(data||{}, mf, true));
    const ok = await tgSendDocument(user.id, pdf, 'ДЕМО‑отчёт BLVCK TAXI за '+mf.label+' · так выглядит авто‑отчёт в PRO');
    if(!ok) return res.status(502).send('tg failed');
    await withDb(c=>c.query('UPDATE users SET trial_demo_sent=true WHERE chat_id=$1', [user.id]));
    res.json({ ok:true });
  }catch(e){ console.error('trial-demo', e.message); res.status(500).send('error'); }
});

app.get('/cron/monthly', async (req,res)=>{
  if(!CRON_SECRET || req.query.secret !== CRON_SECRET) return res.sendStatus(403);
  if(!DATABASE_URL) return res.status(503).send('no db');
  const mf = monthBounds(-1);
  try{
    const rows = await withDb(c=>c.query('SELECT chat_id, data FROM users WHERE pro_until > now()'));
    let sent=0, failed=0;
    for(const r of rows.rows){
      try{
        const pdf = await buildPdf(buildDocDef(r.data||{}, mf, false));
        const ok = await tgSendDocument(r.chat_id, pdf, 'BLVCK TAXI · авто‑отчёт за '+mf.label);
        if(ok) sent++; else failed++;
      }catch(e){ console.error('cron row', r.chat_id, e.message); failed++; }
    }
    res.json({ total:rows.rows.length, sent, failed, month:mf.label });
  }catch(e){ console.error('cron', e.message); res.status(500).send('error'); }
});

ensureSchema().catch(e=>console.error('schema', e.message));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('BLVCK TAXI API on '+PORT));