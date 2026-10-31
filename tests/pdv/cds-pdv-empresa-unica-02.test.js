/**
 * CDS-PDV-EMPRESA-UNICA-02 — modelo exclusivo do PDV (MULTIPLAS | UNICA).
 * Executar: node --test tests/pdv/cds-pdv-empresa-unica-02.test.js
 * Isolamento: DB_DIR temporário. Sem banco oficial / SEFAZ / vendas reais.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-empresa-unica-02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const configService = require('../../backend/services/configuracaoService');
const {
  PDV_MODELO_MULTIPLAS,
  PDV_MODELO_UNICA,
  aplicarModeloEmpresaPdvNaRequisicao,
  lerConfigPdvModelo,
  obterPdvModeloEmpresaPublico
} = require('../../backend/services/pdv/PdvModeloEmpresaService');
const VendaApplicationService = require('../../backend/services/vendas/VendaApplicationService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const { getFiscalConfig } = require('../../backend/services/fiscal/configService');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';

function writeIsolatedConfig(partial) {
  const dir = path.join(dbDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    tipoImplantacao: 'ERP_SEM_FISCAL',
    modoOperacao: 'LOCAL',
    porta: 3001,
    modo_operacional_global: 'MULTIEMPRESA',
    empresa_operacional_id: null,
    modo_operacao_venda: 'MULTIEMPRESA',
    pdv_modelo_empresa: 'MULTIPLAS',
    pdv_empresa_id: null,
    ...partial
  };
  fs.writeFileSync(path.join(dir, 'configuracoes.json'), JSON.stringify(full, null, 2), 'utf8');
  configService.reloadGlobalConfig();
  return full;
}

describe('CDS-PDV-EMPRESA-UNICA-02', () => {
  before(() => {
    writeIsolatedConfig({});
  });

  after(() => {
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch (_e) { /* ignore */ }
  });

  it('1) default MULTIPLAS preserva legado e não altera chaves globais', () => {
    const before = writeIsolatedConfig({
      modo_operacional_global: 'MULTIEMPRESA',
      empresa_operacional_id: null
    });
    const pub = obterPdvModeloEmpresaPublico();
    assert.equal(pub.pdv_modelo_empresa, PDV_MODELO_MULTIPLAS);
    assert.equal(pub.pdv_empresa_id, null);

    const saved = configService.saveConfig({
      ...before,
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null,
      confirmacao_modo_operacional: false
    });
    assert.equal(saved.modo_operacional_global, 'MULTIEMPRESA');
    assert.equal(saved.empresa_operacional_id, null);
    assert.equal(saved.pdv_modelo_empresa, 'MULTIPLAS');
  });

  it('2) UNICA exige pdv_empresa_id na validação', () => {
    const v = configService.validateConfig({
      tipoImplantacao: 'ERP_SEM_FISCAL',
      modoOperacao: 'LOCAL',
      porta: 3001,
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: null
    });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /pdv_empresa_id/.test(e)));
  });

  it('3) UNICA força empresa da Matriz mesmo com X-Empresa-Id de filial', async () => {
    writeIsolatedConfig({
      modo_operacional_global: 'MULTIEMPRESA',
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: 10
    });

    const req = {
      body: { origem: 'PDV', total: 10, itens: [] },
      headers: { 'x-empresa-id': '99' },
      empresaId: 99
    };

    const out = await aplicarModeloEmpresaPdvNaRequisicao(req, {
      cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 10 },
      validarEmpresaPdv: async (id) => ({ empresa_id: id })
    });

    assert.equal(out.aplicada, true);
    assert.equal(out.empresa_id, 10);
    assert.equal(req.empresaId, 10);
    assert.equal(String(req.headers['x-empresa-id']), '10');
    assert.equal(req.__financeiroEmpresaOk, true);
  });

  it('4) configuração ausente/inválida rejeita sem concluir venda', async () => {
    const req = {
      body: { origem: 'PDV', total: 5 },
      headers: {},
      empresaId: null
    };
    await assert.rejects(
      () => aplicarModeloEmpresaPdvNaRequisicao(req, {
        cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: null },
        validarEmpresaPdv: async () => {
          throw Object.assign(new Error('não deveria'), { code: 'X' });
        }
      }),
      (err) => err.code === 'PDV_EMPRESA_ID_AUSENTE'
    );

    await assert.rejects(
      () => aplicarModeloEmpresaPdvNaRequisicao(req, {
        cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 777 },
        validarEmpresaPdv: async () => {
          const e = new Error('Empresa inativa');
          e.code = 'EMPRESA_INATIVA';
          e.statusCode = 409;
          throw e;
        }
      }),
      (err) => err.code === 'EMPRESA_INATIVA' || err.code === 'PDV_EMPRESA_INVALIDA'
    );
  });

  it('5) MULTIPLAS não aplica força e deixa PDV-SEL seguir', async () => {
    const req = { body: { origem: 'PDV' }, headers: { 'x-empresa-id': '5' }, empresaId: 5 };
    const out = await aplicarModeloEmpresaPdvNaRequisicao(req, {
      cfg: { pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: 10 }
    });
    assert.equal(out.aplicada, false);
    assert.equal(out.motivo, 'PDV_MULTIPLAS');
    assert.equal(req.empresaId, 5);
  });

  it('6) origem não-PDV ignora a configuração do PDV', async () => {
    const req = { body: { origem: 'FATURAMENTO' }, empresaId: 3 };
    const out = await aplicarModeloEmpresaPdvNaRequisicao(req, {
      cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 10 },
      validarEmpresaPdv: async (id) => ({ empresa_id: id })
    });
    assert.equal(out.aplicada, false);
    assert.equal(out.motivo, 'ORIGEM_NAO_PDV');
    assert.equal(req.empresaId, 3);
  });

  it('7) VendaApplicationService em UNICA não chama PDV-SEL e usa empresa configurada', async () => {
    let selChamada = false;
    let empresaNoNucleo = null;

    const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
    const originalPag = require.cache[pagamentoPath];
    require.cache[pagamentoPath] = {
      id: pagamentoPath,
      filename: pagamentoPath,
      loaded: true,
      exports: {
        criarVenda(req) {
          empresaNoNucleo = req.empresaId;
          return { ok: true, empresa_id: req.empresaId };
        }
      }
    };

    const appPath = require.resolve('../../backend/services/vendas/VendaApplicationService');
    delete require.cache[appPath];
    const App = require('../../backend/services/vendas/VendaApplicationService');

    try {
      const req = {
        body: { origem: 'PDV', total: 20, itens: [{ produto_id: 1, quantidade: 1, preco: 20 }] },
        headers: { 'x-empresa-id': '99' },
        empresaId: 99,
        user: { id: 1 }
      };
      const res = {
        status() { return this; },
        json(payload) { this.payload = payload; return this; }
      };

      await App.criarVenda(req, res, {
        obterModoOperacaoVenda: () => 'MULTIEMPRESA',
        PdvModeloEmpresaService: {
          aplicarModeloEmpresaPdvNaRequisicao: async (r) => {
            r.empresaId = 10;
            r.headers = r.headers || {};
            r.headers['x-empresa-id'] = '10';
            r.__financeiroEmpresaOk = true;
            const out = {
              aplicada: true,
              motivo: 'PDV_EMPRESA_UNICA',
              empresa_id: 10,
              pdv_modelo_empresa: 'UNICA'
            };
            r.pdvModeloEmpresa = out;
            return out;
          }
        },
        SelecaoEmpresaVendaPdvService: {
          aplicarSelecaoEmpresaNaVendaPdv: async () => {
            selChamada = true;
            return { aplicada: true };
          },
          responderBloqueioSelecao: (res2, err) => res2.status(409).json(err)
        }
      });

      assert.equal(selChamada, false);
      assert.equal(empresaNoNucleo, 10);
      assert.equal(req.empresaId, 10);
    } finally {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      delete require.cache[appPath];
    }
  });

  it('8) estoque MANUAL/AUTOMATICO permanece por empresa (Matriz)', async () => {
    const sqlite3 = require('sqlite3').verbose();
    const db = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(d)));
    });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID });
      });
    });

    await run(`CREATE TABLE empresas (
      id INTEGER PRIMARY KEY, cnpj TEXT, razao_social TEXT, nome_fantasia TEXT, ativo INTEGER DEFAULT 1
    )`);
    await run(
      `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES (1, ?, 'Matriz', 1)`,
      [CNPJ_MATRIZ]
    );
    await run(
      `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES (2, ?, 'Filial', 1)`,
      [CNPJ_FILIAL]
    );

    const { garantirSchemaEmpresasConfiguracaoEstoqueAsync } = require(
      '../../backend/services/empresas/empresasConfiguracaoEstoqueSchema'
    );
    await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);

    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, 1, 'MANUAL');
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, 2, 'AUTOMATICO');

    const modoMatriz = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(db, 1);
    const modoFilial = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(db, 2);
    assert.equal(modoMatriz.modo, 'MANUAL');
    assert.equal(modoMatriz.permite_baixa_automatica, false);
    assert.equal(modoFilial.modo, 'AUTOMATICO');
    assert.equal(modoFilial.permite_baixa_automatica, true);

    await new Promise((resolve) => db.close(() => resolve()));
  });

  it('9) emitente fiscal permanece amarrado a empresaId da venda (contrato, sem emissão)', () => {
    const fsSync = require('fs');
    const pagamento = fsSync.readFileSync(
      path.join(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.match(pagamento, /empresaIdVenda/);
    assert.match(pagamento, /INSERT INTO vendas/);
    // Núcleo grava vendas.empresa_id = empresaIdVenda; fiscal lê essa empresa.
    assert.ok(typeof getFiscalConfig === 'function');
  });

  it('10) pedidos / venda-por-valor não leem PdvModeloEmpresaService', () => {
    const fsSync = require('fs');
    const pedidos = fsSync.readFileSync(
      path.join(__dirname, '../../backend/rotas/pedidos.js'),
      'utf8'
    );
    const valor = fsSync.readFileSync(
      path.join(__dirname, '../../backend/services/vendas/VendaPorValorPasteisService.js'),
      'utf8'
    );
    assert.doesNotMatch(pedidos, /PdvModeloEmpresaService|pdv_modelo_empresa/);
    assert.doesNotMatch(valor, /PdvModeloEmpresaService|pdv_modelo_empresa/);
  });

  it('11) lerConfigPdvModelo reflete persistência UNICA', () => {
    writeIsolatedConfig({
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: 42,
      modo_operacional_global: 'MULTIEMPRESA'
    });
    const cfg = lerConfigPdvModelo();
    assert.equal(cfg.pdv_modelo_empresa, PDV_MODELO_UNICA);
    assert.equal(cfg.pdv_empresa_id, 42);
    assert.equal(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
  });
});
