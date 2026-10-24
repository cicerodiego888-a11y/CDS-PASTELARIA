/**
 * Testes — Central de Entradas Sprint 4 (NSU, persistência DF-e, XML)
 * Executar: npm run test:central-entradas-sprint4
 */

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-sprint4-');

const assert = require('assert');
const CentralEntradasService = require('../../backend/motores/central-entradas/CentralEntradasService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { garantirEmpresaTeste } = require('./helpers/empresaTesteCentral');

let passou = 0;
let falhou = 0;

const CNPJ_TESTE = '88888888000188';
const CHAVE_SPRINT4 = '23250788888888000188550010000008881000000088';
const AMBIENTE_TESTE = 2;

const service = new CentralEntradasService();
const nsuRepository = new CentralNsuRepository();
const documentosRepository = new CentralDocumentosRepository();
const historicoRepository = new CentralHistoricoRepository();
const persistenciaService = new CentralDfePersistenciaService();
const CTX = { empresaId: null };
isolamento.comprobarSeCarregado();

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((error) => {
      falhou += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${error.message}`);
    });
}

function criarXmlTeste(chave) {
  return `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe${chave}"><ide><nNF>8888</nNF><serie>1</serie><dhEmi>2026-07-05T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${CNPJ_TESTE}</CNPJ><xNome>Fornecedor Sprint 4</xNome></emit><total><ICMSTot><vNF>1500.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
}

async function limparDocumentoTeste() {
  if (!CTX.empresaId) return;
  const existente = await documentosRepository.buscarPorChave(CHAVE_SPRINT4, CTX.empresaId);
  if (!existente) return;

  await historicoRepository._obterSql().run(
    'DELETE FROM central_entradas_historico WHERE documento_id = ?',
    [existente.id]
  );
  await documentosRepository.remover(existente.id);
}

async function limparNsuTeste() {
  const existente = await nsuRepository.buscarPorCnpjAmbiente(CNPJ_TESTE, AMBIENTE_TESTE);
  if (existente) {
    await nsuRepository.remover(existente.id);
  }
}

async function main() {
  console.log('\n=== Testes Central de Entradas — Sprint 4 ===\n');

  await nsuRepository._obterSql().whenReady();
  CTX.empresaId = await garantirEmpresaTeste(documentosRepository._obterSql());

  await test('NSU obterOuCriar não reinicia do zero', async () => {
    await limparNsuTeste();

    const criado = await nsuRepository.obterOuCriar(CNPJ_TESTE, AMBIENTE_TESTE);
    assert.strictEqual(criado.ultNsu, '000000000000000');

    await nsuRepository.atualizarSincronizacao(criado.id, {
      ultNsu: '000000000000123',
      maxNsu: '000000000000456'
    });

    const reaberto = await nsuRepository.obterOuCriar(CNPJ_TESTE, AMBIENTE_TESTE);
    assert.strictEqual(reaberto.ultNsu, '000000000000123');
    assert.strictEqual(reaberto.maxNsu, '000000000000456');
    assert.ok(reaberto.dataSincronizacao);
  });

  await test('persistência DF-e grava documento sem criar compra', async () => {
    await limparDocumentoTeste();

    const xml = criarXmlTeste(CHAVE_SPRINT4);
    const resultado = await persistenciaService.persistirDocumentoDfe({
      xml,
      nsu: '000000000000999',
      origem: 'dfe',
      empresaId: CTX.empresaId
    });

    assert.strictEqual(resultado.novo, true);
    assert.strictEqual(resultado.documento.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.strictEqual(resultado.documento.empresaId, CTX.empresaId);
    assert.strictEqual(resultado.documento.chave, CHAVE_SPRINT4);

    const sql = documentosRepository._obterSql();
    const compra = await sql.get('SELECT id FROM compras WHERE chave_acesso = ?', [CHAVE_SPRINT4]);
    assert.ok(!compra, 'Nenhuma compra deve ser criada pela persistência DF-e');
  });

  await test('persistência DF-e detecta duplicata na Central', async () => {
    const xml = criarXmlTeste(CHAVE_SPRINT4);
    const resultado = await persistenciaService.persistirDocumentoDfe({
      xml,
      origem: 'dfe',
      empresaId: CTX.empresaId
    });

    assert.strictEqual(resultado.duplicado, true);
    assert.strictEqual(resultado.novo, false);

    const sql = documentosRepository._obterSql();
    const ddl = await sql.get(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'central_entradas_documentos'`
    );
    assert.ok(/UNIQUE\s*\(\s*chave\s*,\s*empresa_id\s*\)/i.test(ddl.sql || ''));
    await assert.rejects(
      () => sql.run(
        `INSERT INTO central_entradas_documentos (chave, xml, status, empresa_id)
         VALUES (?, '<nfe/>', ?, ?)`,
        [CHAVE_SPRINT4, DocumentoFiscalStatus.XML_COMPLETO, CTX.empresaId]
      ),
      (err) => /UNIQUE/i.test(String(err && err.message))
    );
  });

  let documentoId;

  await test('obterXmlDocumento retorna XML bruto', async () => {
    const doc = await documentosRepository.buscarPorChave(CHAVE_SPRINT4, CTX.empresaId);
    assert.ok(doc);
    documentoId = doc.id;

    const xmlDoc = await service.obterXmlDocumento(documentoId);
    assert.ok(xmlDoc);
    assert.ok(xmlDoc.xml.includes('infNFe'));
    assert.strictEqual(xmlDoc.chave, CHAVE_SPRINT4);
  });

  await test('dashboard inclui sincronização', async () => {
    const dashboard = await service.obterDashboard();
    assert.ok('sincronizacao' in dashboard);
    assert.ok('ultimaSincronizacao' in dashboard);
    assert.ok(dashboard.indicadores);
    assert.ok(typeof dashboard.indicadores.totalDocumentos === 'number');
    assert.ok(typeof dashboard.indicadores.valorTotalDia === 'number');
  });

  await limparDocumentoTeste();
  await limparNsuTeste();

  console.log(`\nResultado: ${passou} passou, ${falhou} falhou\n`);
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Erro fatal nos testes:', error);
  process.exit(1);
});
