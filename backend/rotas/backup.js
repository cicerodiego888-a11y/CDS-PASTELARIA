const express = require("express");
const path = require("path");
const db = require("../database");
const {
  fazerBackupManual,
  listarHistoricoBackups,
  aplicarRetencaoBackups,
  resolverPastaBackupOperacional,
  existeBackupDoDia,
  dataLocalBrasil
} = require("../services/backupManual");
const {
  executarBackupDiarioLocal,
  iniciarBackupAutomaticoLocal
} = require("../services/backupAutomaticoLocal");
const {
  isElectronRuntime,
  selecionarPastaBackup
} = require("../services/electronDialogoService");
const {
  rejeitarCaminhoClienteBanco,
  resolverCaminhoBancoOperacional,
  exigirCaminhosBackup,
  CODIGO_BLOQUEIO
} = require("../lib/sqliteOfficialGuard");

const router = express.Router();

try {
  iniciarBackupAutomaticoLocal();
} catch (err) {
  console.error("[BACKUP] Falha ao iniciar automático na rota:", err.message || err);
}

function responderBloqueio(res, error) {
  const status = error.statusCode || (error.code === CODIGO_BLOQUEIO ? 403 : 500);
  return res.status(status).json({
    sucesso: false,
    codigo: error.code || CODIGO_BLOQUEIO,
    mensagem: error.message || "Operação de backup bloqueada."
  });
}

router.post("/selecionar-pasta", (req, res) => {
  if (!isElectronRuntime()) {
    return res.status(501).json({
      sucesso: false,
      erro: "NOT_ELECTRON",
      mensagem: "Seletor de pasta disponível apenas no aplicativo desktop."
    });
  }

  try {
    const resultado = selecionarPastaBackup();

    if (resultado.cancelado) {
      return res.json({ sucesso: false, cancelado: true });
    }

    if (!resultado.sucesso) {
      return res.status(500).json({
        sucesso: false,
        mensagem: "Não foi possível abrir o seletor de pasta."
      });
    }

    res.json({ sucesso: true, caminho: resultado.caminho });
  } catch (error) {
    console.error("[BACKUP] Erro ao selecionar pasta:", error);
    res.status(500).json({
      sucesso: false,
      mensagem: error.message || "Erro ao selecionar pasta."
    });
  }
});

router.post("/manual", async (req, res) => {
  try {
    rejeitarCaminhoClienteBanco(req.body || {});
  } catch (error) {
    return responderBloqueio(res, error);
  }

  let dbPath;
  try {
    dbPath = resolverCaminhoBancoOperacional({
      dbPathPreferido: db.dbPath || process.env.DB_PATH
    });
  } catch (error) {
    return responderBloqueio(res, error);
  }

  try {
    const { pasta, origem } = await resolverPastaBackupOperacional(db, dbPath);
    exigirCaminhosBackup({ origem: dbPath, destino: path.join(pasta, "probe.db") });
    const resultado = await fazerBackupManual(dbPath, pasta);
    aplicarRetencaoBackups(pasta, 30, dbPath);
    return res.json({
      sucesso: true,
      backup: resultado,
      pasta,
      origem_pasta: origem,
      mensagem: "Cópia recuperável do banco gerada com sucesso."
    });
  } catch (error) {
    console.error("[BACKUP] Erro no backup manual:", error);
    return responderBloqueio(res, error);
  }
});

/** Garante backup do dia (primeira entrada / chamada explícita). */
router.post("/garantir-diario", async (req, res) => {
  try {
    rejeitarCaminhoClienteBanco(req.body || {});
  } catch (error) {
    return responderBloqueio(res, error);
  }

  const forcar = req.body && (req.body.forcar === true || req.body.forcar === 1);
  const out = await executarBackupDiarioLocal({
    forcar: !!forcar,
    motivo: forcar ? "garantir_diario_forcado" : "garantir_diario_entrada"
  });

  if (!out.sucesso && !out.ignorado) {
    return res.status(500).json({
      sucesso: false,
      mensagem: out.erro || "Falha ao garantir backup diário.",
      codigo: out.codigo || null
    });
  }

  return res.json({
    sucesso: true,
    ...out
  });
});

router.get("/status-diario", async (req, res) => {
  try {
    const dbPath = resolverCaminhoBancoOperacional({
      dbPathPreferido: db.dbPath || process.env.DB_PATH
    });
    const { pasta, origem } = await resolverPastaBackupOperacional(db, dbPath);
    const hoje = dataLocalBrasil();
    return res.json({
      sucesso: true,
      data: hoje,
      pasta,
      origem_pasta: origem,
      existe_backup_hoje: existeBackupDoDia(pasta, hoje),
      horario_automatico: "23:59"
    });
  } catch (error) {
    return responderBloqueio(res, error);
  }
});

router.get('/history', (req, res) => {
  try {
    rejeitarCaminhoClienteBanco(req.query || {});
  } catch (error) {
    return responderBloqueio(res, error);
  }

  let dbPath;
  try {
    dbPath = resolverCaminhoBancoOperacional({
      dbPathPreferido: db.dbPath || process.env.DB_PATH
    });
  } catch (error) {
    return responderBloqueio(res, error);
  }

  const pastaBackup = req.query.pasta || null;
  try {
    if (pastaBackup) {
      exigirCaminhosBackup({ destino: path.join(String(pastaBackup), "probe.db") });
    }
    const historico = listarHistoricoBackups(
      pastaBackup,
      Number(req.query.limite) || 50,
      dbPath
    );
    res.json({ sucesso: true, historico });
  } catch (err) {
    console.error('Erro ao listar histórico de backups:', err);
    return responderBloqueio(res, err);
  }
});

module.exports = router;
