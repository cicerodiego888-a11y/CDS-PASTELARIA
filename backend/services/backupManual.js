const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
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

/**
 * Copia o banco para pasta de backup.
 * Em contexto de teste, origem e destino não podem ser produção sensível.
 * Não abre conexão SQLite — apenas filesystem após a barreira.
 */
function fazerBackupManual(dbPath, pastaDestino = null) {
  if (!dbPath) {
    throw new Error("Banco de dados não informado.");
  }

  const pastaBackup = pastaDestino || path.join(path.dirname(dbPath), "backups");
  const caminhoBackupPrevisto = path.join(
    pastaBackup,
    `backup_pdv_${formatarDataArquivo()}.db`
  );

  // Barreira ANTES de existsSync/copy (evita tocar o oficial em teste).
  exigirCaminhosBackup({
    origem: dbPath,
    destino: caminhoBackupPrevisto
  });

  if (!fs.existsSync(dbPath)) {
    throw new Error("Banco de dados não encontrado: " + path.basename(dbPath));
  }

  if (!fs.existsSync(pastaBackup)) {
    fs.mkdirSync(pastaBackup, { recursive: true });
  }

  const nomeBackup = path.basename(caminhoBackupPrevisto);
  const caminhoBackup = path.join(pastaBackup, nomeBackup);

  fs.copyFileSync(dbPath, caminhoBackup);

  const caminhoBackupCompactado = `${caminhoBackup}.gz`;
  try {
    const conteudo = fs.readFileSync(caminhoBackup);
    const gzipConteudo = zlib.gzipSync(conteudo);
    fs.writeFileSync(caminhoBackupCompactado, gzipConteudo);
  } catch (err) {
    console.error('Erro ao compactar backup:', err);
  }

  return {
    sucesso: true,
    arquivo: nomeBackup,
    caminho: caminhoBackup,
    compacto: caminhoBackupCompactado
  };
}

function obterPastaBackup(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
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
  const arquivos = listarHistoricoBackups(pastaBackup, 1000, dbPathRef);
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
  obterPastaBackup
};
