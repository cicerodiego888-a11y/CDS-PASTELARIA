/**
 * CE-PASTELARIA-03 — Investigação NF-e 4456 (sem SEFAZ, sem banco oficial).
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
 *   tests/central-entradas/ce-pastelaria-03-investigacao-nfe-4456.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-ce-p03-');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CentralNsuService = require('../../backend/motores/central-entradas/services/CentralNsuService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralConsultaDistDfeDecisaoService = require(
  '../../backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService'
);
const { CentralSefazOperationalGate } = require(
  '../../backend/motores/central-entradas/services/CentralSefazOperationalGate'
);
const { obterMutexTransmissaoSefaz } = require('../../backend/services/fiscal/SefazTransmissaoMutex');
const CentralDfePersistenciaService = require(
  '../../backend/motores/central-entradas/services/CentralDfePersistenciaService'
);

const ROOT = path.join(__dirname, '../..');
const REF_CDS = path.join(ROOT, '..', 'CDS_SISTEMAS_CORRECAO_FISCAL_NAO-F');
const EMP = 3;
const CNPJ = '38204469000204';
const CHAVE_4456 = '23261031255007000188550010000044561664976903';
const FIXO = new Date('2026-10-19T12:00:00.000Z');

function src(rel, base = ROOT) {
  return fs.readFileSync(path.join(base, rel), 'utf8');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function padNsu(n) {
  return String(n).padStart(15, '0');
}

function parseChaveNfe(chave) {
  const c = String(chave || '').replace(/\D/g, '');
  if (c.length !== 44) return null;
  return {
    cUF: c.slice(0, 2),
    aamm: c.slice(2, 6),
    cnpjEmit: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: c.slice(22, 25),
    numero: String(Number(c.slice(25, 34))),
    tpEmis: c.slice(34, 35),
    cNF: c.slice(35, 43),
    cDV: c.slice(43, 44)
  };
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 2,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      cooldown_ate DATETIME,
      ultimo_cstat TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT,
      numero TEXT,
      serie TEXT,
      modelo TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      valor_total REAL,
      xml TEXT,
      nsu TEXT,
      origem TEXT,
      status TEXT,
      tipo_documento TEXT,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  return db;
}

describe('CE-PASTELARIA-03 — investigação NF-e 4456', () => {
  let db;
  let nsuService;
  let decisao;
  let gate;
  let agoraMs;

  beforeEach(async () => {
    db = await criarDb();
    agoraMs = FIXO.getTime();
    const agora = () => new Date(agoraMs);
    nsuService = new CentralNsuService({
      nsuRepository: new CentralNsuRepository({ db }),
      agora
    });
    gate = new CentralSefazOperationalGate({
      agora,
      autoPersist: false,
      configRepository: {
        buscarPorChave: async () => null,
        parseValor: () => ({}),
        salvar: async () => {}
      }
    });
    gate.hidratar({});
    decisao = new CentralConsultaDistDfeDecisaoService({
      nsuService,
      gate,
      agora,
      rateLimitMs: 0,
      mutexTransmissaoSefaz: obterMutexTransmissaoSefaz()
    });
    decisao.resetRateLimitParaTeste();
    obterMutexTransmissaoSefaz().resetParaTeste();
  });

  afterEach(async () => {
    obterMutexTransmissaoSefaz().resetParaTeste();
    if (db) await new Promise((r) => db.close(() => r()));
  });

  it('0) isolamento ativo', () => {
    assert.ok(isolamento.dbDir);
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.throws(
      () => new sqlite3.Database(path.join('C:\\ProgramData\\MercantilFiscal\\dados', 'mercadao.db')),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
        || /banco oficial bloqueado/i.test(String(err.message))
    );
  });

  it('1) chave 4456 — estrutura coerente com DANFE informado', () => {
    const p = parseChaveNfe(CHAVE_4456);
    assert.ok(p);
    assert.equal(p.cUF, '23');
    assert.equal(p.aamm, '2610');
    assert.equal(p.cnpjEmit, '31255007000188');
    assert.equal(p.modelo, '55');
    assert.equal(p.serie, '001');
    assert.equal(p.numero, '4456');
  });

  it('2) cooldown explícito 656 bloqueia decisão (BACKGROUND e REAL)', async () => {
    const ate = new Date(agoraMs + 30 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);

    const rBg = await decisao.avaliar({
      empresaId: EMP,
      cnpj: CNPJ,
      ambiente: 1,
      origem: 'background',
      verificarAutorizacao: false,
      permitirSemAutorizacao: true,
      verificarMutex: false
    });
    assert.equal(rBg.permitido, false);
    assert.equal(rBg.codigo, 'COOLDOWN_ATIVO');

    const rReal = await decisao.avaliar({
      empresaId: EMP,
      cnpj: CNPJ,
      ambiente: 1,
      origem: 'CONSULTA_DFE_REAL',
      verificarAutorizacao: true,
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP },
      verificarMutex: false
    });
    assert.equal(rReal.permitido, false);
    assert.equal(rReal.codigo, 'COOLDOWN_ATIVO');
  });

  it('3) FILA pós-656: janela 1h bloqueia; após 1h libera DistNSU (sem sticky)', async () => {
    const ate = new Date(agoraMs - 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);

    const cd = nsuService.avaliarCooldown(
      await nsuService.buscarPorCnpjAmbiente(CNPJ, 1)
    );
    assert.equal(cd.motivo, 'FILA_ESGOTADA');
    assert.equal(cd.detalhe?.sticky, false);

    const r = await decisao.avaliar({
      empresaId: EMP,
      cnpj: CNPJ,
      ambiente: 1,
      origem: 'background',
      verificarAutorizacao: false,
      permitirSemAutorizacao: true,
      verificarMutex: false
    });
    assert.equal(r.permitido, false);
    assert.equal(r.codigo, 'FILA_ESGOTADA');

    // Após 1 h da data_sincronizacao, DistNSU volta a ser permitida (NT 2014.002).
    agoraMs = FIXO.getTime() + (60 * 60 * 1000) + 1000;
    const cdPos = nsuService.avaliarCooldown(
      await nsuService.buscarPorCnpjAmbiente(CNPJ, 1)
    );
    assert.equal(cdPos.ativo, false);
    decisao.resetRateLimitParaTeste();
    const rPos = await decisao.avaliar({
      empresaId: EMP,
      cnpj: CNPJ,
      ambiente: 1,
      origem: 'background',
      autorizacaoTransmissaoSefaz: { modo: 'OPERACAO_REAL', empresaId: EMP },
      verificarMutex: false
    });
    assert.equal(rPos.permitido, true);
    assert.equal(rPos.codigo, 'PRONTO_PARA_CONSULTA');
  });

  it('4) UI Pastelaria: sync cabeçalho → consultar-dfe; liberar FILA não chama sync', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /return consultarDfeRealCentral\(\)/);
    assert.match(ui, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(ui, /operacao-fiscal-real\/liberar-fila-esgotada/);
    assert.match(ui, /Não envia consulta à SEFAZ/);
    // liberarFilaEsgotadaCentral não deve POST /sincronizar
    const m = ui.match(/async function liberarFilaEsgotadaCentral\(\) \{[\s\S]*?\n\}/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /\/sincronizar['"`]/);
    assert.doesNotMatch(m[0], /consultar-dfe/);
  });

  it('5) CDS Sistemas (referência): sync ainda POST /sincronizar', () => {
    const refUi = path.join(REF_CDS, 'frontend/erp/js/central-entradas.js');
    assert.ok(fs.existsSync(refUi), 'referência CDS Sistemas ausente no disco');
    const ui = fs.readFileSync(refUi, 'utf8');
    assert.match(ui, /centralEntradasFetch\('\/sincronizar'/);
    assert.doesNotMatch(ui, /return consultarDfeRealCentral\(\)/);
  });

  it('6) rota Pastelaria: /sincronizar não é o caminho OPERACAO_REAL', () => {
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /operacao-fiscal-real\/consultar-dfe/);
    assert.match(rotas, /\/sincronizar nunca aceita autorização OPERACAO_REAL/);
    assert.match(rotas, /liberar-fila-esgotada/);
    assert.match(rotas, /consultaExecutada:\s*false/);
  });

  it('7) runtime DistDFe exige autorização (barreira)', () => {
    const runtime = src('backend/services/fiscal/distribuicaoDfeRuntime.js');
    assert.match(runtime, /avaliarAutorizacaoTransmissao/);
    const dist = src('backend/services/fiscal/distribuicaoDFe.js');
    assert.match(dist, /avaliarAutorizacaoTransmissao/);
  });

  it('8) empresaId obrigatório na persistência / duplicidade por empresa', async () => {
    const docs = [];
    const svc = new CentralDfePersistenciaService({
      empresaId: EMP,
      documentosRepository: {
        async buscarPorChave(chave, empresaId) {
          return docs.find((d) => d.chave === chave && d.empresa_id === empresaId) || null;
        },
        async criar(dados) {
          const row = {
            id: docs.length + 1,
            chave: dados.chave,
            empresa_id: dados.empresaId != null ? dados.empresaId : dados.empresa_id,
            numero: dados.numero,
            status: dados.status || 'NOVO'
          };
          docs.push(row);
          return row;
        },
        async atualizar() { return null; }
      },
      db: {
        get: (sql, params, cb) => cb(null, null)
      }
    });

    assert.equal(await svc.existeCompraComChave(CHAVE_4456, EMP), false);

    // Duplicidade de documento: segunda inserção mesma chave+empresa
    docs.push({
      id: 1,
      chave: CHAVE_4456,
      empresa_id: EMP,
      numero: '4456',
      status: 'XML_COMPLETO'
    });
    const existente = await svc._documentosRepository.buscarPorChave(CHAVE_4456, EMP);
    assert.ok(existente);
    assert.equal(existente.empresa_id, EMP);

    const outra = await svc._documentosRepository.buscarPorChave(CHAVE_4456, 1);
    assert.equal(outra, null);
  });

  it('9) lote vazio / sem XML: decisão e NSU não inventam documento', async () => {
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, data_sincronizacao)
      VALUES (?, 1, ?, ?, '137', ?)`,
    [CNPJ, padNsu(35), padNsu(35), FIXO.toISOString()]);

    const controle = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    const pos = await nsuService.aplicarRetornoDistDfe({
      controle,
      cStat: '137',
      ultNsu: padNsu(35),
      maxNsu: padNsu(35),
      ultNsuRaw: padNsu(35),
      maxNsuRaw: padNsu(35),
      xmlRetorno: '<retDistDFeInt><cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>'
        + `<ultNSU>${padNsu(35)}</ultNSU><maxNSU>${padNsu(35)}</maxNSU></retDistDFeInt>`
    });
    // 137 no topo pode marcar atualizouNsu=true (cStat/data), mas o cursor não avança
    // e nenhum documento é inventado — lote vazio.
    assert.equal(pos.ultNsu || pos.controle?.ultNsu, padNsu(35));
    const lido = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    assert.equal(lido.ultNsu, padNsu(35));
    assert.equal(lido.maxNsu, padNsu(35));
    assert.equal(String(lido.ultimoCstat), '137');
    const count = await get(db, 'SELECT COUNT(*) AS c FROM central_entradas_documentos');
    assert.equal(count.c, 0);
  });

  it('10) liberação FILA não altera NSU e não contorna cooldown ativo', async () => {
    const ate = new Date(agoraMs + 20 * 60 * 1000).toISOString();
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, ultimo_cstat, cooldown_ate, data_sincronizacao)
      VALUES (?, 1, ?, ?, '656', ?, ?)`,
    [CNPJ, padNsu(35), padNsu(35), ate, FIXO.toISOString()]);
    const c = await nsuService.buscarPorCnpjAmbiente(CNPJ, 1);
    await assert.rejects(
      () => nsuService.liberarFilaEsgotadaAutorizada({
        controle: c,
        confirmacaoLiberacaoFila: true,
        autorizacao: { modo: 'OPERACAO_REAL', empresaId: EMP },
        empresaId: EMP
      }),
      (e) => e.code === 'COOLDOWN_EXPLICITO_ATIVO'
    );
    assert.equal((await nsuService.buscarPorCnpjAmbiente(CNPJ, 1)).ultNsu, padNsu(35));
  });

  it('11) evidência estática: chave 4456 ausente no workspace Pastelaria', () => {
    // Busca textual no repo — não abre ProgramData.
    const hits = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (/node_modules|\.git|dados[\\/]|ProgramData/i.test(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (/\.(js|md|json|xml)$/i.test(ent.name)) {
          try {
            const t = fs.readFileSync(full, 'utf8');
            if (t.includes(CHAVE_4456)) hits.push(full);
          } catch { /* ignore */ }
        }
      }
    };
    walk(path.join(ROOT, 'docs', 'central-entradas'));
    walk(path.join(ROOT, 'tests', 'central-entradas'));
    // Suíte/relatórios de investigação citam a chave de propósito — excluir.
    // Código de produção (fora docs/tests de investigação) não deve embuti-la.
    const externos = hits.filter((h) => !/(ce-pastelaria-0[34]|acao-prioritaria-nfe-4456|preparacaoRecuperacaoNfe4456)/i.test(h));
    assert.equal(externos.length, 0, `chave encontrada em: ${externos.join(', ')}`);
  });
});
