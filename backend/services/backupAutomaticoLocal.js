/**
 * Backup local automático:
 * - todos os dias às 23:59 (America/Fortaleza)
 * - na primeira entrada do sistema no dia (se ainda não houver backup)
 */
'use strict';

const cron = require('node-cron');
const {
  fazerBackupManual,
  resolverPastaBackupOperacional,
  existeBackupDoDia,
  dataLocalBrasil,
  aplicarRetencaoBackups
} = require('./backupManual');
const {
  resolverCaminhoBancoOperacional
} = require('../lib/sqliteOfficialGuard');

let tarefaDiaria = null;
let iniciado = false;
let emExecucao = false;

function obterDb() {
  return require('../database');
}

function resolverDbPath() {
  const db = obterDb();
  return resolverCaminhoBancoOperacional({
    dbPathPreferido: (db && db.dbPath) || process.env.DB_PATH || null
  });
}

/**
 * @param {{ forcar?: boolean, motivo?: string }} [opcoes]
 */
async function executarBackupDiarioLocal(opcoes = {}) {
  if (emExecucao) {
    return { sucesso: false, ignorado: true, motivo: 'em_execucao' };
  }
  emExecucao = true;
  try {
    const db = obterDb();
    const dbPath = resolverDbPath();
    const { pasta, origem } = await resolverPastaBackupOperacional(db, dbPath);
    const hoje = dataLocalBrasil();

    if (!opcoes.forcar && existeBackupDoDia(pasta, hoje)) {
      return {
        sucesso: true,
        ignorado: true,
        motivo: 'ja_existe_hoje',
        data: hoje,
        pasta,
        origem_pasta: origem
      };
    }

    const resultado = await fazerBackupManual(dbPath, pasta);
    aplicarRetencaoBackups(pasta, 30, dbPath);
    console.log(
      `[BACKUP] Automático (${opcoes.motivo || 'manual'}) concluído:`,
      resultado.arquivo
    );
    return {
      sucesso: true,
      ignorado: false,
      data: hoje,
      pasta,
      origem_pasta: origem,
      backup: resultado,
      motivo: opcoes.motivo || 'executado'
    };
  } catch (err) {
    console.error('[BACKUP] Falha no backup automático local:', err.message || err);
    return {
      sucesso: false,
      ignorado: false,
      erro: err.message || String(err),
      codigo: err.code || null
    };
  } finally {
    emExecucao = false;
  }
}

function agendarBackupDiario2359() {
  if (tarefaDiaria) {
    try { tarefaDiaria.stop(); } catch (_) { /* ignore */ }
    tarefaDiaria = null;
  }
  // 23:59 horário de Fortaleza / Brasil
  tarefaDiaria = cron.schedule(
    '59 23 * * *',
    () => {
      void executarBackupDiarioLocal({ motivo: 'agenda_2359' });
    },
    { timezone: 'America/Fortaleza' }
  );
  console.log('[BACKUP] Agendado backup local diário às 23:59 (America/Fortaleza).');
}

/**
 * Inicia agenda 23:59 e tenta backup do dia na primeira subida do sistema.
 */
function iniciarBackupAutomaticoLocal() {
  if (iniciado) return { ok: true, ja_iniciado: true };
  iniciado = true;
  try {
    agendarBackupDiario2359();
  } catch (err) {
    console.error('[BACKUP] Não foi possível agendar 23:59:', err.message || err);
  }
  // Primeira entrada do sistema no dia: se ainda não houver backup, gera agora.
  setTimeout(() => {
    void executarBackupDiarioLocal({ motivo: 'primeira_entrada_sistema' });
  }, 5000);
  return { ok: true, ja_iniciado: false };
}

module.exports = {
  iniciarBackupAutomaticoLocal,
  executarBackupDiarioLocal,
  agendarBackupDiario2359
};
