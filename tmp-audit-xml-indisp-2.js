'use strict';

const sqlite3 = require('sqlite3');
const path = require('path');

const dbPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'MercantilFiscal', 'dados', 'mercadao.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

function all(sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
}

function maskChave(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length < 12) return d || null;
  return `${d.slice(0, 6)}…${d.slice(-8)}`;
}

function maskCnpj(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 14) return d || null;
  return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
}

function sanitizeDetalhe(raw) {
  if (raw == null) return null;
  let d = raw;
  try {
    d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return String(raw).slice(0, 400);
  }
  if (!d || typeof d !== 'object') return d;
  const o = { ...d };
  delete o.certificadoSenha;
  delete o.body;
  delete o.xml;
  delete o.docZip;
  if (o.certificadoPath) o.certificadoArquivo = String(o.certificadoPath).replace(/^.*[\\/]/, '');
  delete o.certificadoPath;
  if (o.chave) o.chave = maskChave(o.chave);
  if (o.cnpj) o.cnpj = maskCnpj(o.cnpj);
  if (o.cnpjMascarado) o.cnpj = o.cnpjMascarado;
  return o;
}

(async () => {
  const colsEv = await all('PRAGMA table_info(central_entradas_eventos)');
  console.log('COLS EVENTOS', colsEv.map((c) => c.name).join(', '));
  const colsH = await all('PRAGMA table_info(central_entradas_historico)');
  console.log('COLS HIST', colsH.map((c) => c.name).join(', '));

  const alvo = await all(
    `SELECT id, empresa_id, numero, status, tipo_documento, nsu, length(xml) xml_len, chave, valor_total, data_emissao, created_at, updated_at, status_detalhe
     FROM central_entradas_documentos
     WHERE id IN (18, 12, 41, 106, 33) OR (empresa_id=3 AND numero='541588')`
  );
  console.log('=== DOCS ===');
  console.log(JSON.stringify(alvo.map((d) => ({ ...d, chave: maskChave(d.chave) })), null, 2));

  for (const id of [18, 12, 41, 106]) {
    const ev = await all(`SELECT * FROM central_entradas_eventos WHERE documento_id = ? ORDER BY id`, [id]);
    console.log(`\n=== EVENTOS ${id} n=${ev.length} ===`);
    console.log(JSON.stringify(ev.map((e) => {
      const row = { ...e };
      if (row.detalhe_json) row.detalhe_json = sanitizeDetalhe(row.detalhe_json);
      if (row.payload) row.payload = sanitizeDetalhe(row.payload);
      if (row.dados) row.dados = sanitizeDetalhe(row.dados);
      return row;
    }), null, 2).slice(0, 8000));
  }

  const tipos = await all(
    `SELECT d.empresa_id, e.tipo, e.resultado, COUNT(*) n
     FROM central_entradas_eventos e
     JOIN central_entradas_documentos d ON d.id = e.documento_id
     WHERE d.empresa_id IN (2,3) AND e.created_at >= '2026-09-17'
     GROUP BY d.empresa_id, e.tipo, e.resultado
     ORDER BY d.empresa_id, n DESC`
  );
  console.log('\n=== EVENTOS 17/09 F2/F3 ===');
  console.log(JSON.stringify(tipos, null, 2));

  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
