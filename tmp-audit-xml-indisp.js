'use strict';

const sqlite3 = require('sqlite3');
const path = require('path');

const dbPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'MercantilFiscal', 'dados', 'mercadao.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

function all(sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
}

function maskCnpj(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 14) return d || null;
  return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
}

function maskChave(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length < 12) return d || null;
  return `${d.slice(0, 6)}…${d.slice(-8)}`;
}

(async () => {
  const empresas = await all('SELECT id, cnpj, nome_fantasia FROM empresas ORDER BY id');
  console.log('=== EMPRESAS ===');
  console.log(JSON.stringify(empresas.map((e) => ({ ...e, cnpj: maskCnpj(e.cnpj) })), null, 2));

  const docs = await all(
    `SELECT id, empresa_id, chave, numero, serie, status, status_detalhe, tipo_documento, nsu, origem,
            length(xml) xml_len, fornecedor, valor_total, created_at, updated_at
     FROM central_entradas_documentos
     WHERE numero IN ('541588','183346','4430') OR (empresa_id IN (2,3) AND status = 'XML_INDISPONIVEL')
     ORDER BY empresa_id, id`
  );
  console.log('=== DOCS ALVO + XML_INDISPONIVEL F2/F3 ===');
  console.log(JSON.stringify(docs.map((d) => ({ ...d, chave: maskChave(d.chave) })), null, 2));

  const byStatus = await all(
    `SELECT empresa_id, status, tipo_documento, COUNT(*) n
     FROM central_entradas_documentos
     GROUP BY empresa_id, status, tipo_documento
     ORDER BY empresa_id, n DESC`
  );
  console.log('=== STATUS POR EMPRESA ===');
  console.log(JSON.stringify(byStatus, null, 2));

  const ids = [...new Set(docs.map((d) => d.id))];
  for (const id of ids.slice(0, 8)) {
    const ev = await all(
      `SELECT id, tipo, resultado, sucesso, substr(descricao,1,220) descricao, created_at, detalhe
       FROM central_entradas_eventos WHERE documento_id = ? ORDER BY id`,
      [id]
    );
    console.log(`=== EVENTOS DOC ${id} (${ev.length}) ===`);
    const safe = ev.map((e) => {
      let detalhe = e.detalhe;
      try {
        detalhe = typeof e.detalhe === 'string' ? JSON.parse(e.detalhe) : e.detalhe;
      } catch { /* keep */ }
      if (detalhe && typeof detalhe === 'object') {
        const d = { ...detalhe };
        delete d.certificadoSenha;
        delete d.certificadoPath;
        delete d.body;
        delete d.xml;
        delete d.docZip;
        if (d.chave) d.chave = maskChave(d.chave);
        if (d.cnpj) d.cnpj = maskCnpj(String(d.cnpj).replace(/\D/g, '').length === 14 ? d.cnpj : d.cnpj);
        detalhe = d;
      }
      return { ...e, detalhe };
    });
    console.log(JSON.stringify(safe, null, 2));
  }

  const hist = await all(
    `SELECT documento_id, status_anterior, status_novo, substr(detalhe,1,240) detalhe, created_at
     FROM central_entradas_historico
     WHERE documento_id IN (${ids.slice(0, 8).map(() => '?').join(',') || '0'})
     ORDER BY documento_id, id`,
    ids.slice(0, 8)
  );
  console.log('=== HISTORICO ===');
  console.log(JSON.stringify(hist, null, 2));

  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
