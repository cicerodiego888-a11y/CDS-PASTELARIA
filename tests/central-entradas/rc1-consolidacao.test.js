/**
 * Testes RC1 — Consolidação arquitetural da Central de Entradas
 * Executar: npm run test:central-entradas-rc1
 */

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('ce-rc1-');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CentralEntradasOrchestrator } = require('../../backend/motores/central-entradas/CentralEntradasOrchestrator');
const DocumentoTransitionService = require('../../backend/motores/central-entradas/services/DocumentoTransitionService');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const CentralComprasBridgeService = require('../../backend/motores/central-entradas/services/CentralComprasBridgeService');
const CentralNotificacoesService = require('../../backend/motores/central-entradas/services/CentralNotificacoesService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { validarTransicao } = require('../../backend/motores/central-entradas/core/MaquinaEstadosDocumento');
const { garantirEmpresaTeste, CNPJ_EMPRESA_B } = require('./helpers/empresaTesteCentral');

const CHAVE_RC1 = '35260112345678000199550010000000021000000002';
const FIXTURE_XML = path.join(__dirname, '../shared/nfe/fixtures/nfe-proc-sample.xml');
const CTX = { empresaId: null };

let passou = 0;
let falhou = 0;

const documentosRepository = new CentralDocumentosRepository();
const historicoRepository = new CentralHistoricoRepository();
const transitionService = new DocumentoTransitionService({ documentosRepository, historicoRepository });
const processamentoService = new CentralProcessamentoService({
  documentosRepository,
  historicoRepository,
  transitionService
});
const bridgeService = new CentralComprasBridgeService({
  documentosRepository,
  historicoRepository,
  transitionService
});

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

async function limparDocumentoTeste(empresaId = CTX.empresaId) {
  if (!empresaId) return;
  const existente = await documentosRepository.buscarPorChave(CHAVE_RC1, empresaId);
  if (!existente) return;

  await historicoRepository._obterSql().run(
    'DELETE FROM central_entradas_historico WHERE documento_id = ?',
    [existente.id]
  );
  await documentosRepository.remover(existente.id);
}

async function criarDocumentoSincronizado(patch = {}) {
  const empresaId = patch.empresaId != null ? patch.empresaId : CTX.empresaId;
  await limparDocumentoTeste(empresaId);
  const xml = fs.readFileSync(FIXTURE_XML, 'utf8');

  return documentosRepository.inserir({
    chave: patch.chave || CHAVE_RC1,
    numero: '8888',
    serie: '1',
    fornecedor: patch.fornecedor || 'Fornecedor RC1',
    cnpjFornecedor: '88888888000188',
    dataEmissao: '2026-07-09',
    valorTotal: 150,
    xml,
    origem: 'dfe',
    status: DocumentoFiscalStatus.XML_COMPLETO,
    empresaId
  });
}

async function main() {
  console.log('\n=== Testes RC1 — Consolidação Central de Entradas ===\n');
  isolamento.comprobarSeCarregado();

  await documentosRepository._obterSql().whenReady();
  CTX.empresaId = await garantirEmpresaTeste(documentosRepository._obterSql());

  await test('DocumentoTransitionService valida transição inválida', async () => {
    assert.strictEqual(
      validarTransicao(DocumentoFiscalStatus.XML_COMPLETO, DocumentoFiscalStatus.NOVA).valido,
      false
    );
    await assert.rejects(
      () => transitionService.transicionar(
        1,
        DocumentoFiscalStatus.XML_COMPLETO,
        DocumentoFiscalStatus.NOVA
      ),
      (err) => err.statusCode === 400
    );
  });

  await test('DocumentoTransitionService aplica transição válida', async () => {
    const doc = await criarDocumentoSincronizado();
    await transitionService.transicionar(
      doc.id,
      DocumentoFiscalStatus.XML_COMPLETO,
      DocumentoFiscalStatus.EM_REVISAO,
      { detalhe: 'Teste RC1' }
    );
    const atualizado = await documentosRepository.buscarPorId(doc.id);
    assert.strictEqual(atualizado.status, DocumentoFiscalStatus.EM_REVISAO);
    await documentosRepository.atualizar(doc.id, { status: DocumentoFiscalStatus.XML_COMPLETO });
  });

  await test('CentralProcessamentoService reutiliza parse existente (sem duplicar MIIP)', async () => {
    const doc = await criarDocumentoSincronizado();
    const primeiro = await processamentoService.processar(doc.id, { empresaId: CTX.empresaId });
    assert.strictEqual(primeiro.sucesso, true);

    const segundo = await processamentoService.processar(doc.id, { empresaId: CTX.empresaId });
    assert.strictEqual(segundo.sucesso, true);
    assert.strictEqual(segundo.reutilizado, true);
    assert.ok(segundo.mensagem.includes('reutilizado'));
  });

  await test('CentralComprasBridgeService não reexecuta Parser/MIIP', async () => {
    const doc = await criarDocumentoSincronizado();
    await processamentoService.processar(doc.id, { empresaId: CTX.empresaId });

    const payload = await bridgeService.montarPayloadAbrirCompra(doc.id, {
      empresaIdContexto: CTX.empresaId
    });
    assert.ok(payload.dadosCompra);
    assert.strictEqual(payload.empresaId, CTX.empresaId);

    const docSemProcessar = await criarDocumentoSincronizado();
    await assert.rejects(
      () => bridgeService.montarPayloadAbrirCompra(docSemProcessar.id, {
        empresaIdContexto: CTX.empresaId
      }),
      (err) => err.statusCode === 400 && err.message.includes('não processado')
    );
  });

  await test('alterarStatusManual bloqueia não-admin', async () => {
    const orchestrator = new CentralEntradasOrchestrator({
      documentosRepository,
      historicoRepository,
      transitionService,
      processamentoService,
      comprasBridgeService: bridgeService
    });

    const doc = await criarDocumentoSincronizado();

    await assert.rejects(
      () => orchestrator.alterarStatusManual(doc.id, DocumentoFiscalStatus.DESCARTADA, {
        perfilUsuario: 'USUARIO',
        roleUsuario: 'operador'
      }),
      (err) => err.statusCode === 403
    );
  });

  await test('alterarStatusManual permite admin e usa transição', async () => {
    const orchestrator = new CentralEntradasOrchestrator({
      documentosRepository,
      historicoRepository,
      transitionService,
      processamentoService,
      comprasBridgeService: bridgeService
    });

    const doc = await criarDocumentoSincronizado();

    const atualizado = await orchestrator.alterarStatusManual(
      doc.id,
      DocumentoFiscalStatus.FINALIZADA,
      {
        perfilUsuario: 'ADMIN',
        usuarioId: 1,
        usuarioNome: 'admin-teste',
        empresaIdContexto: CTX.empresaId
      }
    );

    assert.strictEqual(atualizado.status, DocumentoFiscalStatus.FINALIZADA);
  });

  await test('notificação de sync consolidada — uma por sincronização', async () => {
    const notifService = new CentralNotificacoesService();
    const naoLidasAntes = await notifService.contarNaoLidas();
    const antes = await notifService.listar({ limite: 100 });
    assert.ok(
      antes.length < 100,
      `listar() tem teto 100; banco isolado deve começar abaixo do teto (antes=${antes.length})`
    );

    const criada = await notifService.notificarSyncConcluida({
      notasNovas: 4,
      sucesso: true,
      origem: 'teste-rc1'
    });

    assert.ok(criada && criada.id, 'notificarSyncConcluida deve persistir uma linha');
    assert.strictEqual(criada.tipo, 'NOVAS_NOTAS');
    assert.ok(criada.mensagem.includes('4 novas notas fiscais'));

    const depois = await notifService.listar({ limite: 100 });
    assert.strictEqual(depois.length, antes.length + 1);
    assert.strictEqual(depois[0].id, criada.id);
    assert.strictEqual(depois[0].tipo, 'NOVAS_NOTAS');

    const naoLidasDepois = await notifService.contarNaoLidas();
    assert.strictEqual(naoLidasDepois, naoLidasAntes + 1);
  });

  await test('listarPendentesProcessamento exige empresa e isola A/B', async () => {
    const doc = await criarDocumentoSincronizado();
    await assert.rejects(
      () => documentosRepository.listarPendentesProcessamento(10),
      (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
    );
    const pendentes = await documentosRepository.listarPendentesProcessamento(10, CTX.empresaId);
    assert.ok(pendentes.some((p) => p.id === doc.id));
    assert.ok(pendentes.every((p) => p.empresaId === CTX.empresaId));

    const sql = documentosRepository._obterSql();
    const empresaB = await garantirEmpresaTeste(sql, {
      cnpj: CNPJ_EMPRESA_B,
      razao: 'Empresa Teste Central B'
    });
    const docB = await documentosRepository.inserir({
      chave: CHAVE_RC1,
      numero: '8889',
      serie: '1',
      fornecedor: 'Fornecedor B',
      xml: fs.readFileSync(FIXTURE_XML, 'utf8'),
      origem: 'dfe',
      status: DocumentoFiscalStatus.XML_COMPLETO,
      empresaId: empresaB
    });
    const listaB = await documentosRepository.listarPendentesProcessamento(10, empresaB);
    assert.deepStrictEqual(listaB.map((d) => d.id), [docB.id]);

    await processamentoService.processar(doc.id, { empresaId: CTX.empresaId });
    const apos = await documentosRepository.listarPendentesProcessamento(10, CTX.empresaId);
    assert.ok(!apos.some((p) => p.id === doc.id));
    const bDepois = await documentosRepository.buscarPorId(docB.id);
    assert.strictEqual(bDepois.status, DocumentoFiscalStatus.XML_COMPLETO);
    assert.strictEqual(bDepois.empresaId, empresaB);
  });

  await test('health RC1 expõe versão consolidada', async () => {
    const orchestrator = new CentralEntradasOrchestrator();
    const health = await orchestrator.obterHealth();
    assert.ok(/^RC[2-9]$/.test(health.sprint), `health.sprint: ${health.sprint}`);
    assert.ok(/rc[2-9]/.test(health.versao), `versao inesperada: ${health.versao}`);
  });

  await limparDocumentoTeste();

  console.log(`\nResultado: ${passou} passou, ${falhou} falhou\n`);
  process.exit(falhou > 0 ? 1 : 0);
}

main();
