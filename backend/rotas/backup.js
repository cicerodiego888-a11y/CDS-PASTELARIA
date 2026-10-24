const express = require("express");
const path = require("path");
const db = require("../database");
const {
  fazerBackupManual,
  listarHistoricoBackups,
  aplicarRetencaoBackups
} = require("../services/backupManual");
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

router.post("/manual", (req, res) => {
  try {
    rejeitarCaminhoClienteBanco(req.body || {});
  } catch (error) {
    return responderBloqueio(res, error);
  }

  let dbPath;
  try {
    // Origem controlada pelo servidor (conexão já aberta), nunca hardcode legado nem body.
    dbPath = resolverCaminhoBancoOperacional({
      dbPathPreferido: db.dbPath || process.env.DB_PATH
    });
  } catch (error) {
    return responderBloqueio(res, error);
  }

  db.get(
    "SELECT valor FROM configuracoes WHERE chave = 'backup_path'",
    [],
    (err, row) => {
      if (err || !row || !row.valor) {
        return res.status(400).json({
          sucesso: false,
          mensagem: "Configure a pasta de backup primeiro."
        });
      }

      try {
        exigirCaminhosBackup({ origem: dbPath, destino: path.join(row.valor, "probe.db") });
        const resultado = fazerBackupManual(dbPath, row.valor);

        res.json({
          sucesso: true,
          backup: resultado
        });
        aplicarRetencaoBackups(row.valor || undefined, 30, dbPath);
      } catch (error) {
        return responderBloqueio(res, error);
      }
    }
  );
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

  // Pasta vem só da config interna ou query "pasta" já persistida pelo operador —
  // não aceita caminho de banco. Query pasta é diretório de backups, não o .db.
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
