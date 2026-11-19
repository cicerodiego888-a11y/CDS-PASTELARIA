'use strict';
/**
 * FK-01 — Diagnóstico somente leitura.
 * Backup online SQLite → %TEMP%\cds-cozinha-fk-diagnostico
 * Auditoria PRAGMA foreign_key_check SOMENTE na cópia.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const ORIGEM = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'MercantilFiscal',
  'dados',
  'mercadao.db'
);
const OUT_DIR = path.join(os.tmpdir(), 'cds-cozinha-fk-diagnostico');
const COPIA = path.join(OUT_DIR, 'mercadao-copia-diagnostico.db');
const REPORT_JSON = path.join(__dirname, 'DIAGNOSTICO-FK-01-DADOS.json');

const HISTORICOS = [
  {
    label: 'backup_2026-11-15',
    path: path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'MercantilFiscal',
      'dados',
      'backups',
      'backup_pdv_2026-11-15_11-35-47.db'
    )
  },
  {
    label: 'backup_2026-11-16',
    path: path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'MercantilFiscal',
      'dados',
      'backups',
      'backup_pdv_2026-11-16_07-31-15.db'
    )
  }
];

function openRo(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => resolve());
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

/**
 * Cópia consistente via API Backup do SQLite (node-sqlite3).
 * Origem em OPEN_READONLY; destino criado pelo backup.
 */
function backupSqlite(origem, destino) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destino)) {
      try { fs.unlinkSync(destino); } catch (_e) { /* ignore */ }
    }
    const src = new sqlite3.Database(origem, sqlite3.OPEN_READONLY, (errOpen) => {
      if (errOpen) return reject(errOpen);

      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        src.close(() => {
          if (err) reject(err);
          else resolve();
        });
      };

      let backup;
      try {
        backup = src.backup(destino);
      } catch (e) {
        return done(e);
      }

      // Completa o backup em um único step(-1).
      backup.step(-1, (errStep) => {
        if (errStep) {
          try { backup.finish(() => done(errStep)); } catch (_e) { done(errStep); }
          return;
        }
        backup.finish((errFin) => done(errFin || null));
      });
    });
  });
}

async function auditarCopia(dbPath, label) {
  const db = await openRo(dbPath);
  try {
    const meta = await get(db, `
      SELECT valor FROM cozinha_schema_meta WHERE chave = 'schema_version'
    `).catch(() => null);

    const tabelasCozinha = await all(db, `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'cozinha_%'
      ORDER BY name
    `);

    const fkCheck = await all(db, `PRAGMA foreign_key_check`);

    const porTabela = {};
    for (const row of fkCheck) {
      const t = row.table;
      if (!porTabela[t]) porTabela[t] = { total: 0, porPai: {}, amostras: [] };
      porTabela[t].total += 1;
      const pai = row.parent || '(desconhecido)';
      porTabela[t].porPai[pai] = (porTabela[t].porPai[pai] || 0) + 1;
      if (porTabela[t].amostras.length < 5) {
        porTabela[t].amostras.push({
          table: row.table,
          rowid: row.rowid,
          parent: row.parent,
          fkid: row.fkid
        });
      }
    }

    const relacoes = {};
    for (const tabela of Object.keys(porTabela)) {
      const safe = String(tabela).replace(/'/g, "''");
      const fks2 = await all(db, `PRAGMA foreign_key_list('${safe}')`);
      relacoes[tabela] = (fks2 || []).map((fk) => ({
        id: fk.id,
        seq: fk.seq,
        table: fk.table,
        from: fk.from,
        to: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete
      }));
    }

    const amostrasEnriquecidas = {};
    for (const tabela of Object.keys(porTabela)) {
      amostrasEnriquecidas[tabela] = [];
      for (const am of porTabela[tabela].amostras) {
        let registro = null;
        try {
          registro = await get(
            db,
            `SELECT * FROM "${String(tabela).replace(/"/g, '""')}" WHERE rowid = ?`,
            [am.rowid]
          );
        } catch (e) {
          registro = { erro_leitura: String(e.message || e) };
        }
        amostrasEnriquecidas[tabela].push({ ...am, registro });
      }
    }

    const contagens = {};
    for (const t of tabelasCozinha) {
      const nome = t.name;
      try {
        const c = await get(db, `SELECT COUNT(*) AS n FROM "${nome.replace(/"/g, '""')}"`);
        contagens[nome] = Number(c && c.n) || 0;
      } catch (_e) {
        contagens[nome] = null;
      }
    }

    let violCozinha = 0;
    let violOutras = 0;
    for (const [t, info] of Object.entries(porTabela)) {
      if (String(t).startsWith('cozinha_')) violCozinha += info.total;
      else violOutras += info.total;
    }

    const top = Object.entries(porTabela)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([t, info]) => ({ tabela: t, total: info.total, porPai: info.porPai }));

    return {
      label,
      dbPath,
      schema_version: meta ? meta.valor : null,
      tabelas_cozinha: tabelasCozinha.map((t) => t.name),
      contagens_cozinha: contagens,
      total_violacoes: fkCheck.length,
      violacoes_cozinha: violCozinha,
      violacoes_outras: violOutras,
      por_tabela: porTabela,
      top_tabelas: top,
      relacoes_fk: relacoes,
      amostras_enriquecidas: amostrasEnriquecidas
    };
  } finally {
    await closeDb(db);
  }
}

(async () => {
  if (!fs.existsSync(ORIGEM)) {
    throw new Error(`Banco de origem não encontrado: ${ORIGEM}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const stOrigem = fs.statSync(ORIGEM);
  process.stderr.write(`[FK-01] origem=${ORIGEM} size=${stOrigem.size}\n`);
  process.stderr.write(`[FK-01] backup → ${COPIA}\n`);
  await backupSqlite(ORIGEM, COPIA);
  const stCopia = fs.statSync(COPIA);
  process.stderr.write(`[FK-01] copia size=${stCopia.size}\n`);
  if (stCopia.size < 1000) {
    throw new Error(`Cópia inválida (size=${stCopia.size}). Backup falhou.`);
  }

  const atual = await auditarCopia(COPIA, 'copia_oficial_atual');
  process.stderr.write(`[FK-01] total violacoes copia=${atual.total_violacoes}\n`);

  const historicos = [];
  for (const h of HISTORICOS) {
    if (!fs.existsSync(h.path)) {
      historicos.push({ label: h.label, path: h.path, existe: false });
      continue;
    }
    const destH = path.join(OUT_DIR, `${h.label}.db`);
    process.stderr.write(`[FK-01] backup historico ${h.label}\n`);
    await backupSqlite(h.path, destH);
    const audit = await auditarCopia(destH, h.label);
    historicos.push({
      label: h.label,
      origem: h.path,
      copia: destH,
      existe: true,
      total_violacoes: audit.total_violacoes,
      violacoes_cozinha: audit.violacoes_cozinha,
      violacoes_outras: audit.violacoes_outras,
      schema_version: audit.schema_version,
      top_tabelas: audit.top_tabelas.slice(0, 15)
    });
    process.stderr.write(`[FK-01] ${h.label} violacoes=${audit.total_violacoes}\n`);
  }

  const out = {
    gerado_em: new Date().toISOString(),
    origem: {
      path: ORIGEM,
      size: stOrigem.size,
      mtime: stOrigem.mtime.toISOString(),
      classificacao: 'BANCO_OFICIAL_PROGRAMDATA',
      selecao:
        'electron.js define DB_DIR=ProgramData/MercantilFiscal/dados; '
        + 'database.js usa exigirAberturaDatabaseModule(); npm start = electron .'
    },
    copia: {
      dir: OUT_DIR,
      path: COPIA,
      size: stCopia.size
    },
    auditoria_atual: atual,
    historicos
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(out, null, 2), 'utf8');
  process.stdout.write(JSON.stringify({
    origem: out.origem.path,
    copia: out.copia.path,
    total: atual.total_violacoes,
    cozinha: atual.violacoes_cozinha,
    outras: atual.violacoes_outras,
    schema_version: atual.schema_version,
    top5: atual.top_tabelas.slice(0, 5),
    json: REPORT_JSON
  }, null, 2) + '\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
