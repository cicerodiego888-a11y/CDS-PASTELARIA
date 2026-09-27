/**
 * Sincronização de saldo e extrato. Persistência só via MBC-03.
 * Sem escrita no financeiro. Sem tokens na tabela.
 * @module motores/bancario/services/SincronizacaoBancariaService
 */
'use strict';

const {
  ERROS,
  erroMbc,
  STATUS_SINCRONIZACAO,
  STATUS_CONSENTIMENTO,
  STATUS_REGISTRO,
  CODIGO_PROVIDER,
  classificarErroProvider
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet } = require('./dbPromessas');
const ContaBancariaService = require('./ContaBancariaService');
const TransacaoBancariaService = require('./TransacaoBancariaService');
const ConsentimentoOpenFinanceService = require('./ConsentimentoOpenFinanceService');
const { obterRegistryPadrao } = require('../providers/BankProviderRegistry');
const { adaptarPaginaDoProvider } = require('../providers/adaptarTransacaoProvider');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');
const { registrarOperacaoMbc } = require('../contracts/observabilidadeMbc');
const { montarRegistroOperacaoAssistida } = require('../providers/openfinance-real/operacaoAssistida');
const MercadoPagoSincronizacaoService = require('./MercadoPagoSincronizacaoService');
const ItauOperacaoService = require('./ItauOperacaoService');
const {
  resolverSyncLockTtlMs,
  resolverSyncMaxPaginas,
  lockExpirado
} = require('./syncConfig');

const txQueue = new WeakMap();

function agoraIso() {
  return new Date().toISOString();
}

function sanitizarErro(msg) {
  const t = String(msg || 'Erro na sincronização.');
  if (/secret|password|senha|refresh.?token|access.?token|bearer |client_secret|private.?key|certificado|authorization/i.test(t)) {
    return 'Erro técnico na sincronização.';
  }
  return t.slice(0, 400);
}

function depsDe(params) {
  return {
    db: params.db,
    registry: params.registry || obterRegistryPadrao(),
    secretStore: params.secretStore || obterSecretStore({ db: params.db })
  };
}

function mapPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    conta_bancaria_id: row.conta_bancaria_id,
    consentimento_open_finance_id: row.consentimento_open_finance_id,
    provider: row.provider,
    status: row.status,
    cursor_atual: row.cursor_atual,
    saldo_bancario: row.saldo_bancario == null ? null : Number(row.saldo_bancario),
    saldo_data: row.saldo_data,
    ultima_sincronizacao_em: row.ultima_sincronizacao_em,
    ultimo_sucesso_em: row.ultimo_sucesso_em,
    ultimo_erro: row.ultimo_erro,
    lock_iniciado_em: row.lock_iniciado_em || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function runTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

function withTx(db, fn) {
  const prev = txQueue.get(db) || Promise.resolve();
  const next = prev.then(() => runTx(db, fn), () => runTx(db, fn));
  txQueue.set(db, next.catch(() => {}));
  return next;
}

async function atualizarCampos(db, id, campos) {
  const sets = ['updated_at = datetime(\'now\',\'localtime\')'];
  const bind = [];
  Object.keys(campos).forEach((k) => {
    sets.push(k + ' = ?');
    bind.push(campos[k]);
  });
  bind.push(id);
  await dbRun(db, `UPDATE sincronizacao_bancaria SET ${sets.join(', ')} WHERE id = ?`, bind);
}

function paginaDe(bruto, contexto) {
  return adaptarPaginaDoProvider(bruto, contexto);
}

async function obterContaAtiva(params) {
  const conta = await ContaBancariaService.obterNoContexto({
    db: params.db,
    empresaId: params.empresaId,
    id: params.conta_bancaria_id
  });
  if (Number(conta.empresa_id) !== Number(params.empresaId)) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'A sincronização deve pertencer à mesma empresa da conta.', 400);
  }
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }
  return conta;
}

async function obterConfigAtiva(db, empresaId, contaId) {
  const row = await dbGet(
    db,
    `SELECT * FROM config_integracao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ? AND ativo = 1
     ORDER BY id DESC`,
    [empresaId, contaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONFIG_NAO_ENCONTRADA, 'Configuração de integração não encontrada.', 404);
  }
  return row;
}

async function buscarLinha(db, empresaId, contaId, provider) {
  return dbGet(
    db,
    `SELECT * FROM sincronizacao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ? AND provider = ?`,
    [empresaId, contaId, provider]
  );
}

async function adquirirExecucao(db, dados) {
  const ttlMs = resolverSyncLockTtlMs(dados.env, dados.lockTtlMs);
  return withTx(db, async () => {
    const atual = await buscarLinha(db, dados.empresa_id, dados.conta_bancaria_id, dados.provider);
    let reclaimed = false;
    if (atual && atual.status === STATUS_SINCRONIZACAO.SINCRONIZANDO) {
      if (lockExpirado(atual, ttlMs, dados.agoraMs)) {
        reclaimed = true;
      } else {
        throw erroMbc(ERROS.SINCRONIZACAO_EM_ANDAMENTO, 'Já existe sincronização em andamento para esta conta.', 409);
      }
    }
    const lockIso = agoraIso();
    if (!atual) {
      const r = await dbRun(
        db,
        `INSERT INTO sincronizacao_bancaria (
          empresa_id, conta_bancaria_id, consentimento_open_finance_id, provider, status,
          cursor_atual, lock_iniciado_em, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
        [
          dados.empresa_id,
          dados.conta_bancaria_id,
          dados.consentimento_id,
          dados.provider,
          STATUS_SINCRONIZACAO.SINCRONIZANDO,
          dados.cursor_inicial != null ? dados.cursor_inicial : null,
          lockIso
        ]
      );
      const row = await dbGet(db, `SELECT * FROM sincronizacao_bancaria WHERE id = ?`, [r.lastID]);
      registrarOperacaoMbc({
        operacao: 'SYNC_LOCK_ACQUIRED',
        empresa_id: dados.empresa_id,
        conta_bancaria_id: dados.conta_bancaria_id,
        provider: dados.provider,
        status: STATUS_SINCRONIZACAO.SINCRONIZANDO,
        resultado: 'SYNC_LOCK_ACQUIRED'
      });
      row._lock_reclaimed = false;
      return row;
    }
    await atualizarCampos(db, atual.id, {
      status: STATUS_SINCRONIZACAO.SINCRONIZANDO,
      consentimento_open_finance_id: dados.consentimento_id,
      ultimo_erro: null,
      lock_iniciado_em: lockIso
    });
    const row = await dbGet(db, `SELECT * FROM sincronizacao_bancaria WHERE id = ?`, [atual.id]);
    registrarOperacaoMbc({
      operacao: reclaimed ? 'SYNC_LOCK_RECLAIMED' : 'SYNC_LOCK_ACQUIRED',
      empresa_id: dados.empresa_id,
      conta_bancaria_id: dados.conta_bancaria_id,
      provider: dados.provider,
      status: STATUS_SINCRONIZACAO.SINCRONIZANDO,
      resultado: reclaimed ? 'SYNC_LOCK_RECLAIMED' : 'SYNC_LOCK_ACQUIRED'
    });
    row._lock_reclaimed = reclaimed;
    return row;
  });
}

async function liberarLock(db, linhaId, camposFinais = {}) {
  await atualizarCampos(db, linhaId, Object.assign({}, camposFinais, {
    lock_iniciado_em: null
  }));
  registrarOperacaoMbc({
    operacao: 'SYNC_LOCK_RELEASED',
    status: camposFinais.status || null,
    resultado: 'SYNC_LOCK_RELEASED',
    empresa_id: camposFinais.empresa_id || null,
    conta_bancaria_id: camposFinais.conta_bancaria_id || null,
    provider: camposFinais.provider || null
  });
}

async function registrarFalhaPrevia(db, dados) {
  const atual = await buscarLinha(db, dados.empresa_id, dados.conta_bancaria_id, dados.provider);
  if (!atual) {
    await dbRun(
      db,
      `INSERT INTO sincronizacao_bancaria (
        empresa_id, conta_bancaria_id, consentimento_open_finance_id, provider, status,
        ultimo_erro, ultima_sincronizacao_em, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
      [
        dados.empresa_id,
        dados.conta_bancaria_id,
        dados.consentimento_id || null,
        dados.provider,
        dados.status,
        sanitizarErro(dados.erro),
        agoraIso()
      ]
    );
    return;
  }
  await atualizarCampos(db, atual.id, {
    status: dados.status,
    ultimo_erro: sanitizarErro(dados.erro),
    ultima_sincronizacao_em: agoraIso()
  });
}

async function exigirConsentimentoDaConta(params, conta, provider) {
  const { db } = depsDe(params);
  try {
    const consent = await ConsentimentoOpenFinanceService.exigirConsentimentoAutorizado({
      db,
      empresaId: params.empresaId,
      conta_bancaria_id: conta.id,
      provider
    });
    if (Number(consent.conta_bancaria_id) !== Number(conta.id)
      || Number(consent.empresa_id) !== Number(conta.empresa_id)) {
      throw erroMbc(ERROS.CONSENTIMENTO_INVALIDO, 'Consentimento não pertence à conta da empresa.', 409);
    }
    return consent;
  } catch (err) {
    let status = STATUS_SINCRONIZACAO.ERRO;
    if (err.code === ERROS.CONSENTIMENTO_NAO_ENCONTRADO) {
      throw err;
    }
    try {
      const lista = await ConsentimentoOpenFinanceService.listar({
        db,
        empresaId: params.empresaId,
        conta_bancaria_id: conta.id,
        provider
      });
      const ult = lista[0];
      if (ult && ult.status === STATUS_CONSENTIMENTO.EXPIRADO) {
        status = STATUS_SINCRONIZACAO.CONSENTIMENTO_EXPIRADO;
      } else if (ult && ult.status === STATUS_CONSENTIMENTO.REVOGADO) {
        status = STATUS_SINCRONIZACAO.CONSENTIMENTO_REVOGADO;
      }
    } catch (_) { /* ignore */ }
    await registrarFalhaPrevia(db, {
      empresa_id: params.empresaId,
      conta_bancaria_id: conta.id,
      provider,
      status,
      erro: err.message
    });
    throw err;
  }
}

async function buscarSaldo(provider, params = {}) {
  const bruto = await provider.consultarSaldo(params);
  const valor = Number(bruto && (bruto.valor != null ? bruto.valor : bruto.saldo));
  return {
    valor: Number.isFinite(valor) ? Math.round(valor * 100) / 100 : null,
    data: bruto && (bruto.data || bruto.as_of)
      ? String(bruto.data || bruto.as_of).slice(0, 10)
      : agoraIso().slice(0, 10),
    bruto
  };
}

async function buscarExtrato(provider, params, cursor) {
  const bruto = await provider.listarTransacoes({
    empresaId: params.empresaId,
    empresa_id: params.empresaId,
    contaBancariaId: params.conta_bancaria_id,
    conta_bancaria_id: params.conta_bancaria_id,
    cursor,
    client_id: params.client_id,
    client_secret: params.client_secret,
    certificate: params.certificate,
    private_key: params.private_key,
    ca: params.ca,
    ambiente: params.ambiente,
    account_id: params.account_id,
    agencia: params.agencia,
    conta: params.conta,
    numero: params.numero,
    data_inicio: params.data_inicio || params.begin_date,
    data_fim: params.data_fim || params.end_date,
    saldo_url: params.saldo_url,
    extrato_url: params.extrato_url,
    saldo_path: params.saldo_path,
    extrato_path: params.extrato_path,
    fetchImpl: params.fetchImpl
  });
  // Itaú já devolve página normalizada; demais providers usam adaptarPaginaDoProvider
  if (bruto && Array.isArray(bruto.transacoes) && bruto.transacoes[0]
    && bruto.transacoes[0].empresa_id != null && bruto.transacoes[0].external_source) {
    return {
      transacoes: bruto.transacoes,
      has_more: !!bruto.has_more,
      next_cursor: bruto.next_cursor || null
    };
  }
  return paginaDe(bruto, {
    empresaId: params.empresaId,
    contaBancariaId: params.conta_bancaria_id
  });
}

async function persistirTransacao(params, dto, contaId) {
  return TransacaoBancariaService.registrar({
    db: params.db,
    empresaId: params.empresaId,
    ...dto,
    conta_bancaria_id: contaId,
    accountId: contaId
  });
}

async function processarPagina(params, pagina, contaId) {
  let novas = 0;
  let duplicadas = 0;
  for (const dto of pagina.transacoes) {
    const out = await persistirTransacao(params, dto, contaId);
    if (out.status === STATUS_REGISTRO.CRIADA) novas += 1;
    else duplicadas += 1;
  }
  return { recebidas: pagina.transacoes.length, novas, duplicadas };
}

async function sincronizarConta(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db, registry, secretStore } = depsDe(params);
  const conta = await obterContaAtiva({ db, empresaId, conta_bancaria_id: params.conta_bancaria_id || params.id });
  const cfg = await obterConfigAtiva(db, empresaId, conta.id);
  if (!registry.existe(cfg.provider)) {
    throw erroMbc(ERROS.PROVIDER_DESCONHECIDO, 'Provider bancário desconhecido.', 400);
  }
  const provider = registry.obter(cfg.provider);
  if (!provider.suportaSincronizacao) {
    throw erroMbc(ERROS.PROVIDER_SEM_SINCRONIZACAO, 'Provider não suporta sincronização.', 400);
  }
  const usarMp = await MercadoPagoSincronizacaoService.deveUsarSincronizacaoMercadoPago(
    { ...params, db, secretStore, empresaId },
    cfg
  );
  const usarItau = String(cfg.provider || '').toUpperCase() === CODIGO_PROVIDER.ITAU;

  let consent = null;
  let authItau = null;
  if (usarMp) {
    await MercadoPagoSincronizacaoService.exigirOauthAutorizado(
      { ...params, db, secretStore, empresaId },
      cfg
    );
    try {
      consent = await exigirConsentimentoDaConta({ db, empresaId }, conta, cfg.provider);
    } catch (err) {
      if (err.code !== ERROS.CONSENTIMENTO_NAO_ENCONTRADO) throw err;
      consent = { id: null };
    }
  } else if (usarItau) {
    // Itaú: Client Credentials (+ mTLS). Sem consentimento Open Finance.
    authItau = await ItauOperacaoService.montarAuthParaSync(
      { ...params, db, secretStore, empresaId, fetchImpl: params.fetchImpl },
      cfg,
      conta
    );
    consent = { id: null };
  } else {
    consent = await exigirConsentimentoDaConta({ db, empresaId }, conta, cfg.provider);
  }

  const linhaLock = await adquirirExecucao(db, {
    empresa_id: empresaId,
    conta_bancaria_id: conta.id,
    provider: cfg.provider,
    consentimento_id: consent && consent.id != null ? consent.id : null,
    cursor_inicial: null,
    env: params.env || process.env,
    lockTtlMs: params.lockTtlMs,
    agoraMs: params.agoraMs
  });
  const lockReclaimed = linhaLock._lock_reclaimed === true;

  let recebidas = 0;
  let novas = 0;
  let duplicadas = 0;
  let cursorTrabalho = params.reprocessarCatalogo === true ? null : (linhaLock.cursor_atual || null);
  let saldoLido = null;
  const inicioMs = Date.now();
  const maxPaginas = resolverSyncMaxPaginas(params.env || process.env, params.maxPaginas);
  // Sem retry: falha não reprocessa a página automaticamente (cursor só avança após persistir).

  try {
    if (usarMp) {
      const mpOut = await MercadoPagoSincronizacaoService.executarAposLock({
        db,
        empresaId,
        conta,
        cfg,
        linhaLock,
        params: { ...params, secretStore },
        atualizarCampos
      });
      recebidas = mpOut.transacoes_recebidas;
      novas = mpOut.novas_transacoes;
      duplicadas = mpOut.duplicadas;

      const conceitualMp = await TransacaoBancariaService.calcularSaldoConceitual({
        db,
        empresaId,
        conta_bancaria_id: conta.id
      });
      const agoraMp = agoraIso();
      await liberarLock(db, linhaLock.id, {
        status: STATUS_SINCRONIZACAO.SUCESSO,
        consentimento_open_finance_id: consent && consent.id != null ? consent.id : null,
        saldo_bancario: null,
        saldo_data: null,
        cursor_atual: mpOut.cursor,
        ultima_sincronizacao_em: agoraMp,
        ultimo_sucesso_em: agoraMp,
        ultimo_erro: null,
        empresa_id: empresaId,
        conta_bancaria_id: conta.id,
        provider: cfg.provider
      });
      const finalMp = await dbGet(db, `SELECT * FROM sincronizacao_bancaria WHERE id = ?`, [linhaLock.id]);
      registrarOperacaoMbc({
        operacao: 'SYNC_COMPLETED',
        empresa_id: empresaId,
        conta_bancaria_id: conta.id,
        provider: cfg.provider,
        status: STATUS_SINCRONIZACAO.SUCESSO,
        duracao_ms: Date.now() - inicioMs,
        transacoes: recebidas,
        resultado: 'SYNC_COMPLETED'
      });
      return {
        status: STATUS_SINCRONIZACAO.SUCESSO,
        truncated: false,
        lock_reclaimed: lockReclaimed,
        conta_bancaria_id: conta.id,
        empresa_id: empresaId,
        origem: 'MERCADO_PAGO',
        contrato: 'settlement_report',
        periodo: mpOut.periodo,
        arquivos_processados: mpOut.arquivos_processados,
        saldo_bancario: null,
        saldo_conceitual: conceitualMp.saldo_conceitual,
        diferenca: null,
        transacoes_recebidas: recebidas,
        novas_transacoes: novas,
        duplicadas,
        rejeitadas: mpOut.rejeitadas,
        cursor: finalMp.cursor_atual,
        checkpoint_interno: mpOut.checkpoint_interno,
        ultima_sincronizacao_em: finalMp.ultima_sincronizacao_em,
        saldo: mpOut.saldo
      };
    }

    saldoLido = await buscarSaldo(provider, usarItau ? authItau : {});
    let paginas = 0;
    let temMais = true;
    while (temMais && paginas < maxPaginas) {
      paginas += 1;
      const extratoParams = usarItau
        ? {
          empresaId,
          conta_bancaria_id: conta.id,
          begin_date: params.begin_date,
          end_date: params.end_date,
          data_inicio: params.data_inicio || params.begin_date,
          data_fim: params.data_fim || params.end_date,
          ...authItau
        }
        : { empresaId, conta_bancaria_id: conta.id };
      const pagina = await buscarExtrato(provider, extratoParams, cursorTrabalho);
      const proc = await processarPagina({ db, empresaId }, pagina, conta.id);
      recebidas += proc.recebidas;
      novas += proc.novas;
      duplicadas += proc.duplicadas;
      if (pagina.next_cursor) {
        await atualizarCampos(db, linhaLock.id, { cursor_atual: pagina.next_cursor });
        cursorTrabalho = pagina.next_cursor;
      }
      temMais = pagina.has_more === true;
    }

    const truncated = temMais === true;
    const statusFinal = truncated ? STATUS_SINCRONIZACAO.PARCIAL : STATUS_SINCRONIZACAO.SUCESSO;

    const conceitual = await TransacaoBancariaService.calcularSaldoConceitual({
      db,
      empresaId,
      conta_bancaria_id: conta.id
    });
    const agora = agoraIso();
    await liberarLock(db, linhaLock.id, {
      status: statusFinal,
      consentimento_open_finance_id: consent && consent.id != null ? consent.id : null,
      saldo_bancario: saldoLido.valor,
      saldo_data: saldoLido.data,
      ultima_sincronizacao_em: agora,
      ultimo_sucesso_em: agora,
      ultimo_erro: truncated
        ? 'Sincronização parcial: limite de páginas atingido com mais dados pendentes.'
        : null,
      empresa_id: empresaId,
      conta_bancaria_id: conta.id,
      provider: cfg.provider
    });
    const final = await dbGet(db, `SELECT * FROM sincronizacao_bancaria WHERE id = ?`, [linhaLock.id]);
    const bancario = final.saldo_bancario == null ? null : Number(final.saldo_bancario);
    registrarOperacaoMbc({
      operacao: truncated ? 'SYNC_PARTIAL' : 'SYNC_COMPLETED',
      empresa_id: empresaId,
      conta_bancaria_id: conta.id,
      provider: cfg.provider,
      status: statusFinal,
      duracao_ms: Date.now() - inicioMs,
      transacoes: recebidas,
      resultado: truncated ? 'SYNC_PARTIAL' : 'SYNC_COMPLETED'
    });
    const out = {
      status: statusFinal,
      truncated,
      lock_reclaimed: lockReclaimed,
      paginas_processadas: paginas,
      max_paginas: maxPaginas,
      has_more: truncated,
      conta_bancaria_id: conta.id,
      empresa_id: empresaId,
      origem: usarItau ? 'ITAU' : null,
      saldo_bancario: bancario,
      saldo_conceitual: conceitual.saldo_conceitual,
      rotulo_saldo_bancario: 'Saldo real do banco',
      rotulo_saldo_conceitual: 'Saldo conceitual MBC',
      diferenca: bancario == null
        ? null
        : Math.round((bancario - conceitual.saldo_conceitual) * 100) / 100,
      transacoes_recebidas: recebidas,
      novas_transacoes: novas,
      duplicadas,
      cursor: final.cursor_atual,
      ultima_sincronizacao_em: final.ultima_sincronizacao_em,
      message: truncated
        ? 'Sincronização parcial. Checkpoint preservado; execute novamente para continuar.'
        : null
    };
    if (String(cfg.provider || '').toUpperCase() === 'OPEN_FINANCE_REAL') {
      out.operacao_assistida = montarRegistroOperacaoAssistida({
        empresa_id: empresaId,
        conta_bancaria_id: conta.id,
        provider: cfg.provider,
        ambiente: cfg.ambiente,
        inicio: new Date(inicioMs).toISOString(),
        fim: agora,
        quantidade_recebida: recebidas,
        quantidade_criada: novas,
        quantidade_ja_existente: duplicadas,
        erros: 0,
        duracao_ms: Date.now() - inicioMs,
        cursor_final: final.cursor_atual,
        status: truncated ? 'PARCIAL' : 'SINCRONIZADO'
      });
    }
    return out;
  } catch (err) {
    await liberarLock(db, linhaLock.id, {
      status: STATUS_SINCRONIZACAO.ERRO,
      ultimo_erro: sanitizarErro(err.message),
      ultima_sincronizacao_em: agoraIso(),
      empresa_id: empresaId,
      conta_bancaria_id: conta.id,
      provider: cfg.provider
    });
    err.statusCode = err.statusCode || 502;
    err.categoria = classificarErroProvider(err);
    registrarOperacaoMbc({
      operacao: 'SYNC_FAILED',
      empresa_id: empresaId,
      conta_bancaria_id: conta.id,
      provider: cfg.provider,
      status: STATUS_SINCRONIZACAO.ERRO,
      categoria: err.categoria,
      duracao_ms: Date.now() - inicioMs,
      resultado: 'SYNC_FAILED'
    });
    throw err;
  }
}

async function obterSincronizacao(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db } = depsDe(params);
  const conta = await ContaBancariaService.obterNoContexto({
    db,
    empresaId,
    id: params.conta_bancaria_id || params.id
  });
  const cfg = await dbGet(
    db,
    `SELECT provider FROM config_integracao_bancaria
     WHERE empresa_id = ? AND conta_bancaria_id = ? AND ativo = 1
     ORDER BY id DESC`,
    [empresaId, conta.id]
  );
  const provider = cfg ? cfg.provider : null;
  const row = provider
    ? await buscarLinha(db, empresaId, conta.id, provider)
    : await dbGet(
      db,
      `SELECT * FROM sincronizacao_bancaria WHERE empresa_id = ? AND conta_bancaria_id = ? ORDER BY id DESC`,
      [empresaId, conta.id]
    );
  if (!row) {
    return {
      status: STATUS_SINCRONIZACAO.PENDENTE,
      empresa_id: empresaId,
      conta_bancaria_id: conta.id,
      provider,
      cursor_atual: null,
      saldo_bancario: null,
      saldo_data: null,
      ultima_sincronizacao_em: null,
      ultimo_sucesso_em: null,
      ultimo_erro: null
    };
  }
  return mapPublico(row);
}

async function obterSaldoBancario(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { db } = depsDe(params);
  const sync = await obterSincronizacao(params);
  const conceitual = await TransacaoBancariaService.calcularSaldoConceitual({
    db,
    empresaId,
    conta_bancaria_id: sync.conta_bancaria_id
  });
  const bancario = sync.saldo_bancario == null ? null : Number(sync.saldo_bancario);
  return {
    empresa_id: empresaId,
    conta_bancaria_id: sync.conta_bancaria_id,
    provider: sync.provider || null,
    saldo_bancario: bancario,
    saldo_data: sync.saldo_data,
    natureza_bancario: 'informado_banco',
    rotulo_saldo_bancario: 'Saldo real do banco',
    saldo_conceitual: conceitual.saldo_conceitual,
    natureza_conceitual: 'conceitual',
    rotulo_saldo_conceitual: 'Saldo conceitual MBC',
    diferenca: bancario == null ? null : Math.round((bancario - conceitual.saldo_conceitual) * 100) / 100,
    disponivel: bancario != null
  };
}

async function listarExtrato(params = {}) {
  return TransacaoBancariaService.listar({
    db: params.db,
    empresaId: params.empresaId,
    conta_bancaria_id: params.conta_bancaria_id || params.id,
    data_inicio: params.data_inicio,
    data_fim: params.data_fim,
    direcao: params.direcao,
    tipo: params.tipo,
    limite: params.limite,
    offset: params.offset
  });
}

module.exports = {
  sincronizarConta,
  obterSincronizacao,
  obterSaldoBancario,
  listarExtrato,
  buscarSaldo,
  buscarExtrato,
  processarPagina,
  adquirirExecucao,
  liberarLock,
  STATUS_SINCRONIZACAO
};
