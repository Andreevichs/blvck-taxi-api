const crypto = require('crypto');
const express = require('express');
const PdfPrinter = require('pdfmake');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('Нет BOT_TOKEN в переменных окружения'); process.exit(1); }

// Roboto покрывает кириллицу; bolditalics ведём на Medium, чтобы не упасть
const fonts = {
  Roboto: {
    normal:      require.resolve('pdfmake/fonts/Roboto-Regular.ttf'),
    bold:        require.resolve('pdfmake/fonts/Roboto-Medium.ttf'),
    italics:     require.resolve('pdfmake/fonts/Roboto-Regular.ttf'),
    bolditalics: require.resolve('pdfmake/fonts/Roboto-Medium.ttf'),
  }
};
const printer = new PdfPrinter(fonts);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// проверка подписи initData по документации Telegram
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash'); if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (hmac !== hash) return null;
    return JSON.parse(params.get('user') || '{}');
  } catch (e) { return null; }
}

const money = (n, c) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + (c || '');

function buildDocDef(p) {
  const cur = p.cur || '';
  const c = [];
  c.push({ text: 'BLVCK TAXI — отчёт', style: 'h1' });
  c.push({ text: 'Сформировано ' + new Date().toLocaleDateString('ru-RU') + ' · валюта ' + cur, style: 'sub' });

  const total = (p.expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
  const revTotal = (p.rev || []).reduce((s, r) => s + Number(r.v || 0), 0);

  c.push({ text: 'Сводка', style: 'h2' });
  c.push({ table: { widths: ['*', '*'], body: [
    ['Расходов всего', money(total, cur)],
    ['Выручки внесено', revTotal ? money(revTotal, cur) : '—'],
    ['Записей', String((p.expenses || []).length)],
    ['Пробег авто', (p.car && p.car.mileage) ? Number(p.car.mileage).toLocaleString('ru-RU') + ' км' : '—'],
  ]}, layout: 'noBorders' });
  if (p.car && (p.car.model || p.car.plate)) c.push({ text: (p.car.model || '') + (p.car.plate ? ' · ' + p.car.plate : ''), style: 'sub' });

  c.push({ text: 'Расходы', style: 'h2' });
  if ((p.expenses || []).length) {
    const rows = [[{ text: 'Дата', bold: true }, { text: 'Категория', bold: true }, { text: 'Заметка', bold: true }, { text: 'Сумма', bold: true, alignment: 'right' }]];
    p.expenses.forEach(e => rows.push([e.date || '', e.t || '', (e.note || '').slice(0, 40), { text: money(e.amount, cur), alignment: 'right' }]));
    rows.push([{ text: 'ИТОГО', bold: true, colSpan: 3 }, '', '', { text: money(total, cur), bold: true, alignment: 'right' }]);
    c.push({ table: { widths: ['18%', '24%', '*', '24%'], body: rows }, layout: 'light' });
    const withR = p.expenses.filter(e => e.receipt);
    if (withR.length) {
      c.push({ text: 'Чеки (' + withR.length + ')', style: 'h2' });
      withR.forEach(e => {
        c.push({ text: (e.date || '') + ' · ' + (e.t || '') + (e.note ? ' · ' + e.note : '') + ' — ' + money(e.amount, cur), style: 'sub' });
        try { c.push({ image: e.receipt, width: 180, margin: [0, 2, 0, 8] }); } catch (_) {}
      });
    }
  } else c.push({ text: 'нет расходов', style: 'sub' });

  if ((p.rev || []).length) {
    c.push({ text: 'Выручка по дням', style: 'h2' });
    const rows = [[{ text: 'Дата', bold: true }, { text: 'Выручка', bold: true, alignment: 'right' }]];
    p.rev.forEach(r => rows.push([r.date || '', { text: money(r.v, cur), alignment: 'right' }]));
    rows.push([{ text: 'ИТОГО', bold: true }, { text: money(revTotal, cur), bold: true, alignment: 'right' }]);
    c.push({ table: { widths: ['*', '*'], body: rows }, layout: 'light' });
  }

  if ((p.fines || []).length) {
    c.push({ text: 'Штрафы', style: 'h2' });
    const rows = [[{ text: 'За что', bold: true }, { text: 'Статус', bold: true }, { text: 'Сумма', bold: true, alignment: 'right' }]];
    p.fines.forEach(f => rows.push([f.name || '', f.paid ? 'оплачен' : 'не оплачен', { text: money(f.amount, cur), alignment: 'right' }]));
    c.push({ table: { widths: ['*', '30%', '24%'], body: rows }, layout: 'light' });
  }

  if ((p.wear || []).length) {
    c.push({ text: 'Детали и износ', style: 'h2' });
    const rows = [[{ text: 'Деталь', bold: true }, { text: 'Устан., км', bold: true, alignment: 'right' }, { text: 'Прошла', bold: true, alignment: 'right' }, { text: 'Статус', bold: true }]];
    p.wear.forEach(w => rows.push([w.t || '', w.ins ? Number(w.ins).toLocaleString('ru-RU') : '—', w.sp != null ? Number(w.sp).toLocaleString('ru-RU') + ' км' : '—', w.act ? 'действует' : 'заменена']));
    c.push({ table: { widths: ['*', '22%', '22%', '22%'], body: rows }, layout: 'light' });
  }

  if (p.ip && p.fszn) {
    c.push({ text: 'ФСЗН', style: 'h2' });
    c.push({ table: { widths: ['*', '*'], body: [
      ['Уплачено', money(p.fszn.paid, cur)], ['Цель за год', money(p.fszn.goal, cur)],
      ['Ставка', (p.fszn.rate || '') + '%'], ['МЗП', money(p.fszn.mzp, cur)],
    ]}, layout: 'noBorders' });
  }

  return {
    pageSize: 'A4', pageMargins: [36, 36, 36, 36],
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#222' },
    styles: {
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 4] },
      h2: { fontSize: 11, bold: true, margin: [0, 10, 0, 4], color: '#c2410c' },
      sub: { fontSize: 8, color: '#777', margin: [0, 0, 0, 6] },
    },
    content: c,
  };
}

function buildPdf(docDef) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', ch => chunks.push(ch));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function tgSendDocument(chatId, buffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), 'blvck-taxi-report.pdf');
  if (caption) form.append('caption', caption);
  const res = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendDocument', { method: 'POST', body: form });
  return res.ok;
}

app.get('/', (req, res) => res.send('BLVCK TAXI API работает. Мини-приложение общается через POST /send-report.'));

app.post('/send-report', async (req, res) => {
  try {
    const { initData, payload } = req.body || {};
    if (!initData || !payload) return res.status(400).send('no data');
    const user = validateInitData(initData);
    if (!user || !user.id) return res.status(401).send('bad initData');
    const pdf = await buildPdf(buildDocDef(payload));
    const ok = await tgSendDocument(user.id, pdf, 'BLVCK TAXI — отчёт ' + new Date().toLocaleDateString('ru-RU'));
    if (!ok) return res.status(502).send('telegram send failed (нажми Start у бота)');
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).send('error'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('BLVCK TAXI API on ' + PORT));
