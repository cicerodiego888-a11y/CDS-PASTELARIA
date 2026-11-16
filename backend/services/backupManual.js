const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const sqlite3 = require("sqlite3").verbose();
const {
  exigirCaminhosBackup,
  exigirRestauracaoBanco
} = require("../lib/sqliteOfficialGuard");

function formatarDataArquivo() {
  const agora = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return (
    agora.getFullYear() +
    "-" + pad(agora.getMonth() + 1) +
    "-" + pad(agora.getDate()) +
    "_" + pad(agora.getHours()) +
    "-" + pad(agora.getMinutes()) +
    "-" + pad(agora.getSeconds())
  );
}

function nomeUltimoBackup(dbPath) {
  const base = path.basename(dbPath || "mercadao.db", path.extname(dbPath || ".db")) || "mercadao";
  return `${base}-ultimo.db`;
}

/**
 * Gera cópia SQLite recuperável (arquivo .db independente, sem depender de WAL).
 * Preferência: VACUUM INTO → API backup → cópia após checkpoint.
 */
function criarCopiaRecuperavelSqlite(origem, destino) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destino)) {
      try { fs.unlinkSync(destino); } catch (_) { /* ignore */ }
    }

    const dbOrigem = new sqlite3.Database(origem, sqlite3.OPEN_READWRITE, (openErr) => {
      if (openErr) {
        return reject(openErr);
      }

      const fechar = (cb) => {
        dbOrigem.close((closeErr) => {
          if (closeErr) console.warn("[BACKUP] Falha ao fechar origem:", closeErr.message);
          cb();
        });
      };

      // 1) VACUUM INTO — cópia compacta e pronta para restaurar
      dbOrigem.run("VACUUM INTO ?", [destino], (vacuumErr) => {
        if (!vacuumErr && fs.existsSync(destino) && fs.statSync(destino).size > 0) {
          return fechar(() => resolve({ metodo: "vacuum_into" }));
        }

        // 2) API nativa backup do node-sqlite3
        try {
          if (typeof dbOrigem.backup === "function") {
            const job = dbOrigem.backup(destino);
            job.step(-1, (stepErr) => {
              if (stepErr) {
                return tentarCopiaComCheckpoint(dbOrigem, origem, destino, fechar, resolve, reject, vacuumErr, stepErr);
              }
              job.finish((finishErr) => {
                if (finishErr || !fs.existsSync(destino)) {
                  return tentarCopiaComCheckpoint(dbOrigem, origem, destino, fechar, resolve, reject, vacuumErr, finishErr);
                }
                return fechar(() => resolve({ metodo: "sqlite_backup" }));
              });
            });
            return;
          }
        } catch (backupErr) {
          return tentarCopiaComCheckpoint(dbOrigem, origem, destino, fechar, resolve, reject, vacuumErr, backupErr);
        }

        return tentarCopiaComCheckpoint(dbOrigem, origem, destino, fechar, resolve, reject, vacuumErr, null);
      });
    });
  });
}

function tentarCopiaComCheckpoint(dbOrigem, origem, destino, fechar, resolve, reject, errA, errB) {
  dbOrigem.exec("PRAGMA wal_checkpoint(TRUNCATE);", (chkErr) => {
    fechar(() => {
      try {
        if (fs.existsSync(destino)) {
          try { fs.unlinkSync(destino); } catch (_) { /* ignore */ }
        }
        fs.copyFileSync(origem, destino);
        // Cópia do WAL/SHM só se ainda existirem (após truncate tendem a sumir/zerar)
        for (const sufixo of ["-wal", "-shm"]) {
          const lado = origem + sufixo;
          if (fs.existsSync(lado) && fs.statSync(lado).size > 0) {
            try { fs.copyFileSync(lado, destino + sufixo); } catch (_) { /* ignore */ }
          }
        }
        if (!fs.existsSync(destino) || fs.statSync(destino).size <= 0) {
          throw new Error("Cópia do banco resultou vazia.");
        }
        resolve({
          metodo: "copy_checkpoint",
          avisos: [errA && errA.message, errB && errB.message, chkErr && chkErr.message].filter(Boolean)
        });
      } catch (copyErr) {
        reject(copyErr);
      }
    });
  });
}

/**
 * Cópia recuperável do banco para pasta de backup.
 * - arquivo datado backup_pdv_YYYY-MM-DD_HH-mm-ss.db (pronto para restaurar)
 * - espelho mercadao-ultimo.db (recuperação rápida)
 * - .gz opcional (secundário)
 * Barreira de caminhos roda antes de qualquer I/O sensível.
 * @returns {Promise<object>}
 */
function fazerBackupManual(dbPath, pastaDestino = null) {
  if (!dbPath) {
    throw new Error("Banco de dados não informado.");
  }

  const pastaBackup = pastaDestino || path.join(path.dirname(dbPath), "backups");
  const nomeBackup = `backup_pdv_${formatarDataArquivo()}.db`;
  const caminhoBackupPrevisto = path.join(pastaBackup, nomeBackup);
  const caminhoUltimoPrevisto = path.join(pastaBackup, nomeUltimoBackup(dbPath));

  // Barreira ANTES de existsSync/copy (evita tocar o oficial em teste).
  exigirCaminhosBackup({
    origem: dbPath,
    destino: caminhoBackupPrevisto
  });
  exigirCaminhosBackup({
    origem: dbPath,
    destino: caminhoUltimoPrevisto
  });

  if (!fs.existsSync(dbPath)) {
    throw new Error("Banco de dados não encontrado: " + path.basename(dbPath));
  }

  if (!fs.existsSync(pastaBackup)) {
    fs.mkdirSync(pastaBackup, { recursive: true });
  }

  const caminhoBackup = caminhoBackupPrevisto;
  const caminhoUltimo = caminhoUltimoPrevisto;

  return criarCopiaRecuperavelSqlite(dbPath, caminhoBackup)
    .then((meta) => {
      // Espelho fixo para recuperação rápida (substitui o anterior)
      try {
        if (fs.existsSync(caminhoUltimo)) fs.unlinkSync(caminhoUltimo);
        fs.copyFileSync(caminhoBackup, caminhoUltimo);
      } catch (espelhoErr) {
        console.warn("[BACKUP] Não foi possível atualizar cópia -ultimo.db:", espelhoErr.message);
      }

      const caminhoBackupCompactado = `${caminhoBackup}.gz`;
      try {
        const conteudo = fs.readFileSync(caminhoBackup);
        fs.writeFileSync(caminhoBackupCompactado, zlib.gzipSync(conteudo));
      } catch (err) {
        console.error("Erro ao compactar backup:", err);
      }

      return {
        sucesso: true,
        arquivo: nomeBackup,
        caminho: caminhoBackup,
        ultimo: caminhoUltimo,
        arquivo_ultimo: path.basename(caminhoUltimo),
        compacto: caminhoBackupCompactado,
        recuperavel: true,
        metodo: meta && meta.metodo ? meta.metodo : "desconhecido",
        tamanho_bytes: fs.statSync(caminhoBackup).size
      };
    });
}

function obterPastaBackup(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

function dataLocalBrasil(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(agora);
  const mapa = {};
  partes.forEach((p) => {
    if (p.type !== 'literal') mapa[p.type] = p.value;
  });
  return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function prefixoBackupDoDia(dataIso = dataLocalBrasil()) {
  return `backup_pdv_${dataIso}_`;
}

function existeBackupDoDia(pastaBackup, dataIso = dataLocalBrasil()) {
  if (!pastaBackup || !fs.existsSync(pastaBackup)) return false;
  const prefixo = prefixoBackupDoDia(dataIso);
  return fs.readdirSync(pastaBackup).some(
    (nome) => nome.startsWith(prefixo) && (nome.endsWith('.db') || nome.endsWith('.db.gz'))
  );
}

function dbGetAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRunAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/**
 * Pasta operacional de backup:
 * 1) configuracoes.backup_path (se existir)
 * 2) <dir-do-banco>/backups (padrão seguro)
 * Cria a pasta e grava o padrão em configuracoes quando estiver ausente.
 */
async function resolverPastaBackupOperacional(db, dbPath) {
  if (!dbPath) throw new Error('Banco de dados não informado.');
  const padrao = obterPastaBackup(dbPath);
  let pasta = padrao;
  let origem = 'padrao_banco';

  if (db && typeof db.get === 'function') {
    try {
      const row = await dbGetAsync(
        db,
        "SELECT valor FROM configuracoes WHERE chave = 'backup_path' LIMIT 1"
      );
      const configurada = row && row.valor ? String(row.valor).trim() : '';
      if (configurada) {
        pasta = configurada;
        origem = 'configuracao';
      } else {
        await dbRunAsync(
          db,
          `INSERT INTO configuracoes (chave, valor, tipo, descricao)
           VALUES ('backup_path', ?, 'text', 'Caminho da pasta de backup manual')
           ON CONFLICT(chave) DO UPDATE SET
             valor = excluded.valor,
             updated_at = datetime('now', 'localtime')`,
          [padrao]
        );
        pasta = padrao;
        origem = 'padrao_persistido';
      }
    } catch (err) {
      console.warn('[BACKUP] Falha ao ler/gravar backup_path; usando pasta padrão.', err.message);
      pasta = padrao;
      origem = 'padrao_banco';
    }
  }

  exigirCaminhosBackup({ destino: path.join(pasta, 'probe.db') });
  if (!fs.existsSync(pasta)) {
    fs.mkdirSync(pasta, { recursive: true });
  }
  return { pasta, origem, padrao };
}

function listarHistoricoBackups(pastaBackup = null, limite = 20, dbPathRef = null) {
  let folder = pastaBackup;
  if (!folder) {
    let ref = dbPathRef;
    if (!ref) {
      // Compat: dashboard e callers legados. database.js já passou pela barreira P0.5.
      const db = require('../database');
      ref = db.dbPath;
    }
    folder = obterPastaBackup(ref);
  }
  // Em teste, pasta sob produção sensível é recusada antes de readdir.
  exigirCaminhosBackup({ destino: path.join(folder, 'probe.db') });
  if (!fs.existsSync(folder)) {
    return [];
  }
  const arquivos = fs.readdirSync(folder)
    .filter((file) => file.endsWith('.db') || file.endsWith('.db.gz'))
    .map((file) => {
      const stats = fs.statSync(path.join(folder, file));
      return {
        arquivo: file,
        caminho: path.join(folder, file),
        tamanho: stats.size,
        modificado_em: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.modificado_em) - new Date(a.modificado_em));

  return arquivos.slice(0, limite);
}

function aplicarRetencaoBackups(pastaBackup = null, limite = 30, dbPathRef = null) {
  const arquivos = listarHistoricoBackups(pastaBackup, 1000, dbPathRef)
    // Nunca apaga o espelho de recuperação rápida (*-ultimo.db)
    .filter((arquivo) => !/-ultimo\.db(\.gz)?$/i.test(String(arquivo.arquivo || "")));
  if (arquivos.length <= limite) return;
  const paraExcluir = arquivos.slice(limite);
  paraExcluir.forEach((arquivo) => {
    try {
      fs.unlinkSync(arquivo.caminho);
    } catch (err) {
      console.error('Erro ao excluir backup antigo:', arquivo.caminho, err);
    }
  });
}

/**
 * Validação de restauração de arquivo de banco (sem executar restauração).
 * Em teste, destino de produção sensível é bloqueado.
 */
function validarRestauracaoBancoArquivo(origem, destino) {
  return exigirRestauracaoBanco({ origem, destino });
}

module.exports = {
  fazerBackupManual,
  listarHistoricoBackups,
  aplicarRetencaoBackups,
  validarRestauracaoBancoArquivo,
  obterPastaBackup,
  dataLocalBrasil,
  prefixoBackupDoDia,
  existeBackupDoDia,
  resolverPastaBackupOperacional
};
