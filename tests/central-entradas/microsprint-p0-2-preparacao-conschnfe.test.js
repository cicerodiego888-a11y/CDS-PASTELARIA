/**
 * Microsprint P0.2 — Preparação offline de recuperação por chave (consChNFe).
 * Isolado: sem database.js oficial, sem SOAP, sem PFX.
 *
 * node --test tests/central-entradas/microsprint-p0-2-preparacao-conschnfe.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-prep-chave-');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { gerarChaveAcesso } = require('../../backend/services/fiscal/utils');
const { validarChaveNfe } = require('../../backend/motores/central-entradas/utils/validarChaveNfe');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralPreparacaoConsultaChaveService = require(
  '../../backend/motores/central-entradas/services/CentralPreparacaoConsultaChaveService'
);
const { CLASSIFICACOES_PREPARACAO_CHAVE: C } = require(
  '../../backend/motores/central-entradas/config/preparacaoConsultaChaveClassificacoes'
);
const { DocumentoFiscalStatus } = require(
  '../../backend/motores/central-entradas/core/DocumentoFiscalStatus'
);

const CNPJ_MATRIZ = '38204469000115';
const CNPJ_FILIAL2 = '38204469000387';
const CNPJ_FILIAL3 = '38204469000204';
const CNPJ_FORN = '12345678000195';
const EMP_MATRIZ = 11;
const EMP_FILIAL2 = 22;
const EMP_FILIAL3 = 33;

const SERVICO_SRC = fs.readFileSync(
  path.join(__dirname, '../../backend/motores/central-entradas/services/CentralPreparacaoConsultaChaveService.js'),
  'utf8'
);

function chaveValida(patch = {}) {
  return gerarChaveAcesso({
    uf: patch.uf || '35',
    aamm: patch.aamm || '2609',
    cnpj: patch.cnpj || CNPJ_FORN,
    modelo: patch.modelo || '55',
    serie: patch.serie || 1,
    numero: patch.numero || 541588,
    tpEmis: patch.tpEmis || '1',
    cNF: patch.cNF || 12345678
  });
}

function chaveDvInvalido() {
  const ok = chaveValida({ numero: 7 });
  const ultimo = Number(ok[43]);
  return `${ok.slice(0, 43)}${(ultimo + 1) % 10}`;
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

async function criarDbNsu() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 1,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      cooldown_ate DATETIME,
      ultimo_cstat TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  return db;
}

class DocsMem {
  constructor(rows = []) {
    this.rows = rows;
  }

  async buscarPorChave(chave, empresaId) {
    return this.rows.find(
      (r) => r.chave === chave && Number(r.empresaId) === Number(empresaId)
    ) || null;
  }

  async buscarPorChaveExcetoEmpresa(chave, empresaId) {
    return this.rows.find(
      (r) => r.chave === chave && Number(r.empresaId) !== Number(empresaId)
    ) || null;
  }
}

function identidadesPadrao() {
  return {
    [EMP_MATRIZ]: {
      ok: true,
      empresaId: EMP_MATRIZ,
      cnpj: CNPJ_MATRIZ,
      ambiente: 1,
      certificadoConfigurado: true
    },
    [EMP_FILIAL2]: {
      ok: true,
      empresaId: EMP_FILIAL2,
      cnpj: CNPJ_FILIAL2,
      ambiente: 1,
      certificadoConfigurado: true
    },
    [EMP_FILIAL3]: {
      ok: true,
      empresaId: EMP_FILIAL3,
      cnpj: CNPJ_FILIAL3,
      ambiente: 1,
      certificadoConfigurado: true
    }
  };
}

function criarPilha(opcoes = {}) {
  const sefaz = {
    distNSU: 0,
    consChNFe: 0,
    soap: 0,
    pfx: 0,
    m210210: 0,
    estoque: 0,
    nsuWrite: 0
  };
  const mapa = opcoes.identidades || identidadesPadrao();
  const compras = {
    existeCompraComChave: async (chave, empresaId) => {
      const lista = opcoes.compras || [];
      return lista.some((c) => c.chave === chave && Number(c.empresaId) === Number(empresaId));
    },
    gravar: async () => {
      sefaz.estoque += 1;
      throw new Error('crédito de estoque proibido na preparação');
    }
  };
  const nsuRepo = opcoes.nsuRepo;
  if (nsuRepo && typeof nsuRepo.atualizarSincronizacaoSegura === 'function') {
    const orig = nsuRepo.atualizarSincronizacaoSegura.bind(nsuRepo);
    nsuRepo.atualizarSincronizacaoSegura = async (...args) => {
      sefaz.nsuWrite += 1;
      return orig(...args);
    };
  }
  const service = new CentralPreparacaoConsultaChaveService({
    documentosRepository: opcoes.docs || new DocsMem(),
    nsuRepository: nsuRepo || null,
    comprasBridge: compras,
    resolverIdentidadeFiscal: async ({ empresaId, permitirFallbackGlobal }) => {
      assert.equal(permitirFallbackGlobal, false);
      if (opcoes.abrirPfx) sefaz.pfx += 1;
      const id = Number(empresaId);
      if (mapa[id]) return { ...mapa[id] };
      return { ok: false, codigoErro: 'EMPRESA_OBRIGATORIA', mensagem: 'empresa não cadastrada' };
    }
  });
  return { service, sefaz, compras };
}

describe('isolamento', () => {
  it('guardião recusa o banco oficial e DB_DIR não é ProgramData', () => {
    const sqlite3mod = require('sqlite3');
    assert.throws(
      () => new sqlite3mod.Database('C:\\ProgramData\\MercantilFiscal\\dados\\mercadao.db'),
      /recusou abrir o banco oficial/
    );
    assert.ok(process.env.DB_DIR);
    assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(process.env.DB_DIR), false);
    console.log(`BANCO DE TESTE COMPROVADO: ${path.join(process.env.DB_DIR, 'mercadao.db')} (prep não abre database.js)`);
  });

  it('serviço de preparação não importa DistDFe, SOAP nem certificado', () => {
    assert.equal(/require\([^)]*distribuicaoDFe/.test(SERVICO_SRC), false);
    assert.equal(/require\([^)]*certificateService/.test(SERVICO_SRC), false);
    assert.equal(/sincronizarDistribuicaoDFe\s*\(/.test(SERVICO_SRC), false);
    assert.equal(/consultarNotaPorChave\s*\(/.test(SERVICO_SRC), false);
    assert.match(SERVICO_SRC, /naoEnvia:\s*\[[^\]]*210210/);
  });
});

describe('validação de chave', () => {
  it('chave válida e empresa vinculada → ELEGIVEL_PARA_CONSULTA', async () => {
    const chave = chaveValida();
    const { service, sefaz } = criarPilha();
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    assert.equal(r.itens[0].classificacao, C.ELEGIVEL_PARA_CONSULTA);
    assert.equal(r.itens[0].empresaId, EMP_MATRIZ);
    assert.equal(r.itens[0].cnpjEmpresa, CNPJ_MATRIZ);
    assert.equal(r.itens[0].ambiente, 1);
    assert.equal(r.itens[0].executaSefaz, false);
    assert.equal(r.sefazExecutada, false);
    assert.equal(r.consChNFeChamado, false);
    assert.equal(r.distNsuChamado, false);
    assert.equal(sefaz.distNSU + sefaz.consChNFe + sefaz.soap + sefaz.pfx, 0);
  });

  it('chave malformada → CHAVE_INVALIDA', async () => {
    const { service } = criarPilha();
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: ['123'] });
    assert.equal(r.itens[0].classificacao, C.CHAVE_INVALIDA);
    assert.match(r.itens[0].motivo, /44 dígitos/i);
  });

  it('dígito verificador inválido → CHAVE_INVALIDA', async () => {
    const { service } = criarPilha();
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chaveDvInvalido()] });
    assert.equal(r.itens[0].classificacao, C.CHAVE_INVALIDA);
    assert.match(r.itens[0].motivo, /Dígito verificador/i);
    assert.equal(validarChaveNfe(chaveDvInvalido()).valida, true);
  });

  it('empresa ausente bloqueia mesmo com chave válida', async () => {
    const { service } = criarPilha();
    const r = await service.preparar({ chaves: [chaveValida()] });
    assert.equal(r.itens[0].classificacao, C.EMPRESA_OBRIGATORIA);
  });

  it('CNPJ ausente na identidade → CNPJ_NAO_CONFIGURADO', async () => {
    const { service } = criarPilha({
      identidades: {
        [EMP_MATRIZ]: { ok: false, codigoErro: 'CNPJ', empresaId: EMP_MATRIZ }
      }
    });
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chaveValida()] });
    assert.equal(r.itens[0].classificacao, C.CNPJ_NAO_CONFIGURADO);
  });

  it('ambiente ausente → AMBIENTE_NAO_CONFIGURADO', async () => {
    const { service } = criarPilha({
      identidades: {
        [EMP_MATRIZ]: {
          ok: false,
          codigoErro: 'AMBIENTE',
          empresaId: EMP_MATRIZ,
          cnpj: CNPJ_MATRIZ
        }
      }
    });
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chaveValida()] });
    assert.equal(r.itens[0].classificacao, C.AMBIENTE_NAO_CONFIGURADO);
  });

  it('chave incompatível com CNPJ da empresa', async () => {
    const { service } = criarPilha();
    const r = await service.preparar({
      empresaId: EMP_MATRIZ,
      cnpjEmpresaEsperado: CNPJ_FILIAL2,
      chaves: [chaveValida()]
    });
    assert.equal(r.itens[0].classificacao, C.CHAVE_INCOMPATIVEL_COM_EMPRESA);
  });
});

describe('documento local, isolamento e lote', () => {
  it('documento já persistido não é tratado como novo', async () => {
    const chave = chaveValida({ numero: 10 });
    const docs = new DocsMem([{
      id: 99,
      chave,
      empresaId: EMP_MATRIZ,
      status: DocumentoFiscalStatus.XML_COMPLETO,
      origem: 'dfe',
      nsu: '000000000000040'
    }]);
    const { service, sefaz } = criarPilha({ docs });
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    assert.equal(r.itens[0].classificacao, C.DOCUMENTO_JA_EXISTE);
    assert.equal(r.itens[0].situacaoLocal.documentoId, 99);
    assert.equal(sefaz.estoque, 0);
  });

  it('múltiplas chaves com classificações independentes', async () => {
    const ok = chaveValida({ numero: 11 });
    const ja = chaveValida({ numero: 12 });
    const docs = new DocsMem([{
      id: 1,
      chave: ja,
      empresaId: EMP_MATRIZ,
      status: DocumentoFiscalStatus.IMPORTADA
    }]);
    const { service } = criarPilha({ docs });
    const r = await service.preparar({
      empresaId: EMP_MATRIZ,
      chaves: [ok, 'abc', ja, chaveDvInvalido()]
    });
    assert.equal(r.itens.length, 4);
    assert.equal(r.itens[0].classificacao, C.ELEGIVEL_PARA_CONSULTA);
    assert.equal(r.itens[1].classificacao, C.CHAVE_INVALIDA);
    assert.equal(r.itens[2].classificacao, C.DOCUMENTO_JA_EXISTE);
    assert.equal(r.itens[3].classificacao, C.CHAVE_INVALIDA);
    assert.equal(r.resumo.porClassificacao[C.ELEGIVEL_PARA_CONSULTA], 1);
  });

  it('isolamento Matriz / Filial 2 / Filial 3', async () => {
    const chave = chaveValida({ numero: 20 });
    const docs = new DocsMem([{
      id: 2,
      chave,
      empresaId: EMP_FILIAL2,
      status: DocumentoFiscalStatus.XML_COMPLETO
    }]);
    const { service } = criarPilha({ docs });
    const naMatriz = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    const naFilial2 = await service.preparar({ empresaId: EMP_FILIAL2, chaves: [chave] });
    const naFilial3 = await service.preparar({ empresaId: EMP_FILIAL3, chaves: [chave] });
    assert.equal(naMatriz.itens[0].classificacao, C.CHAVE_INCOMPATIVEL_COM_EMPRESA);
    assert.equal(naFilial2.itens[0].classificacao, C.DOCUMENTO_JA_EXISTE);
    assert.equal(naFilial3.itens[0].classificacao, C.CHAVE_INCOMPATIVEL_COM_EMPRESA);
    assert.equal(naMatriz.itens[0].cnpjEmpresa, CNPJ_MATRIZ);
    assert.equal(naFilial3.itens[0].cnpjEmpresa, CNPJ_FILIAL3);
  });

  it('compra local sem documento na Central → PENDENTE_DE_REVISAO sem crédito', async () => {
    const chave = chaveValida({ numero: 21 });
    const { service, sefaz } = criarPilha({
      compras: [{ chave, empresaId: EMP_MATRIZ }]
    });
    const r = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    assert.equal(r.itens[0].classificacao, C.PENDENTE_DE_REVISAO);
    assert.equal(sefaz.estoque, 0);
    assert.equal(r.creditaEstoque, false);
  });

  it('preparação é idempotente', async () => {
    const chave = chaveValida({ numero: 22 });
    const { service } = criarPilha();
    const a = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    const b = await service.preparar({ empresaId: EMP_MATRIZ, chaves: [chave] });
    assert.equal(a.itens[0].classificacao, b.itens[0].classificacao);
    assert.equal(a.resumo.total, b.resumo.total);
  });
});

describe('cursor NSU, cooldown e ausência de efeito fiscal', () => {
  let db;
  let nsuRepo;

  beforeEach(async () => {
    db = await criarDbNsu();
    nsuRepo = new CentralNsuRepository({ db });
    await run(db, `INSERT INTO central_entradas_nsu
      (cnpj, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat)
      VALUES (?, 1, ?, ?, ?, ?), (?, 1, ?, ?, ?, ?), (?, 1, ?, ?, ?, ?)`, [
      CNPJ_MATRIZ, '000000000000127', '000000000000127', '2026-10-18T12:00:00.000Z', '137',
      CNPJ_FILIAL2, '000000000000025', '000000000000025', null, '138',
      CNPJ_FILIAL3, '000000000000017', '000000000000017', '2026-10-18T15:00:00.000Z', '656'
    ]);
  });

  it('não altera ult_nsu, max_nsu nem cooldown_ate de nenhuma empresa', async () => {
    const chaveOk = chaveValida({ numero: 30 });
    const chaveFilial = chaveValida({ numero: 31 });
    const docs = new DocsMem([{
      id: 8,
      chave: chaveFilial,
      empresaId: EMP_FILIAL2,
      status: DocumentoFiscalStatus.XML_COMPLETO
    }]);
    const { service, sefaz } = criarPilha({ docs, nsuRepo });
    const r = await service.preparar({
      empresaId: EMP_MATRIZ,
      chaves: [chaveOk, '00', chaveFilial, chaveDvInvalido()]
    });
    assert.equal(r.nsuAlterado, false);
    assert.equal(r.cooldownAlterado, false);
    assert.equal(sefaz.nsuWrite, 0);
    const matriz = await get(db, 'SELECT * FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_MATRIZ]);
    const f2 = await get(db, 'SELECT * FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL2]);
    const f3 = await get(db, 'SELECT * FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL3]);
    assert.equal(matriz.ult_nsu, '000000000000127');
    assert.equal(matriz.max_nsu, '000000000000127');
    assert.equal(matriz.cooldown_ate, '2026-10-18T12:00:00.000Z');
    assert.equal(f2.ult_nsu, '000000000000025');
    assert.equal(f3.ult_nsu, '000000000000017');
    assert.equal(f3.ultimo_cstat, '656');
    db.close();
  });

  it('falha de uma chave não altera dados fiscais das demais', async () => {
    const { service, sefaz } = criarPilha({ nsuRepo });
    await service.preparar({
      empresaId: EMP_FILIAL3,
      chaves: ['x', chaveValida({ numero: 40 })]
    });
    assert.equal(sefaz.nsuWrite, 0);
    const f3 = await get(db, 'SELECT ult_nsu, cooldown_ate FROM central_entradas_nsu WHERE cnpj=?', [CNPJ_FILIAL3]);
    assert.equal(f3.ult_nsu, '000000000000017');
    assert.equal(f3.cooldown_ate, '2026-10-18T15:00:00.000Z');
    db.close();
  });

  it('não chama SOAP, DistDFe, consChNFe, PFX, 210210 nem estoque', async () => {
    const { service, sefaz } = criarPilha({ nsuRepo });
    const r = await service.preparar({
      empresaId: EMP_MATRIZ,
      chaves: [chaveValida({ numero: 50 })]
    });
    assert.equal(r.certificadoAberto, false);
    assert.equal(r.manifestacao210210, false);
    assert.equal(sefaz.distNSU, 0);
    assert.equal(sefaz.consChNFe, 0);
    assert.equal(sefaz.soap, 0);
    assert.equal(sefaz.pfx, 0);
    assert.equal(sefaz.m210210, 0);
    assert.equal(sefaz.estoque, 0);
    db.close();
  });
});
