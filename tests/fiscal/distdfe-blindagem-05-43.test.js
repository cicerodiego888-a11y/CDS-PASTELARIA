/**
 * Sprint 05.43 — Blindagem do fluxo DistDFe (bug `deps` em persistirDocumentosRetorno).
 *
 * Causa real reproduzida: persistirDocumentosRetorno lia `deps.contextoCentral`
 * sem `deps` no escopo → ReferenceError → catch incrementava ignorados
 * → sincronização seguia como sucesso e podia avançar NSU.
 *
 * Executar: node tests/fiscal/distdfe-blindagem-05-43.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  persistirDocumentosRetorno,
  sincronizarDistribuicaoDFe,
  resolverEmpresaIdPersistenciaDfe
} = require('../../backend/services/fiscal/distribuicaoDFe');

let passou = 0;
let falhou = 0;

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

const CHAVE_A = '35200114200166000187550010000000011123456789';
const CNPJ_TESTE = '11222333000181';

function criarXmlNota(chave) {
  return `<?xml version="1.0"?><nfeProc><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${chave}"><ide><nNF>123</nNF><serie>1</serie></ide><emit><CNPJ>99999999000199</CNPJ><xNome>Emitente Teste</xNome></emit></infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({ cStat = '138', ultNSU = '5', maxNSU = '5', documentos = [] }) {
  const docZips = documentos.map((doc) => {
    const compactado = zlib.gzipSync(Buffer.from(doc.xml, 'utf8')).toString('base64');
    return `<docZip NSU="${doc.nsu}" schema="${doc.schema || 'procNFe_v4.00.xsd'}">${compactado}</docZip>`;
  }).join('');

  return `
<soap:Envelope>
  <soap:Body>
    <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
      <cStat>${cStat}</cStat>
      <xMotivo>Documento localizado</xMotivo>
      <ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU>
      <maxNSU>${String(maxNSU).padStart(15, '0')}</maxNSU>
      <loteDistDFeInt>${docZips}</loteDistDFeInt>
    </retDistDFeInt>
  </soap:Body>
</soap:Envelope>`;
}

function corpoPersistirDocumentosRetorno() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/services/fiscal/distribuicaoDFe.js'),
    'utf8'
  );
  const inicio = src.indexOf('async function persistirDocumentosRetorno');
  const fim = src.indexOf('async function sincronizarDistribuicaoDFe');
  assert.ok(inicio >= 0 && fim > inicio, 'funções DistDFe não localizadas');
  return src.slice(inicio, fim);
}

/**
 * Expressão original (auditoria 05.39): `deps` não era parâmetro.
 * @returns {{ lancou: boolean, nome?: string, mensagem?: string }}
 */
function reproduzirAcessoDepsForaDeEscopo() {
  const persistencia = { _empresaId: 7 };
  try {
    void (deps.contextoCentral?.empresaId ?? persistencia._empresaId ?? null);
    return { lancou: false };
  } catch (err) {
    return { lancou: true, nome: err.name, mensagem: err.message };
  }
}

function criarAuditoriaNoOp() {
  return {
    registrar: async () => {},
    registrarConsulta: async () => {},
    registrarResumoSync: async () => {},
    registrarNsuAvanco: async () => {}
  };
}

function criarNsuServiceMock(controleInicial = {}) {
  const controle = {
    id: 1,
    ultNsu: '000000000000000',
    maxNsu: '000000000000000',
    dataSincronizacao: null,
    updatedAt: null,
    ...controleInicial
  };
  const chamadasAplicar = [];
  return {
    obterOuCriar: async () => controle,
    aplicarRetornoDistDfe: async (params) => {
      chamadasAplicar.push(params);
      const ult = params.ultNsu || '000000000000005';
      const max = params.maxNsu || '000000000000005';
      controle.ultNsu = ult;
      controle.maxNsu = max;
      return {
        controle,
        atualizouNsu: true,
        preservado: false,
        ultNsu: ult,
        maxNsu: max
      };
    },
    chamadasAplicar
  };
}

function contextoCentralTeste(extra = {}) {
  return {
    certificadoPath: path.join(__dirname, 'certificado-inexistente.pfx'),
    certificadoSenha: 'senha-nao-usada-no-mock',
    cnpj: CNPJ_TESTE,
    codigoUf: '23',
    ambiente: 2,
    empresaId: 42,
    ...extra
  };
}

async function enviarDistMock(body) {
  return {
    success: true,
    body,
    telemetryRequestId: null,
    correlationId: 'corr-05-43',
    tempoResolverMs: 1,
    tempoXmlMs: 1,
    tempoTransporteMs: 1,
    tempoTotalMs: 1,
    endpoint: 'https://example.invalid/dfe',
    fallbackUtilizado: false,
    statusCode: 200
  };
}

async function main() {
  console.log('\n=== Sprint 05.43 — Blindagem DistDFe ===\n');
  console.log('Causa real: ReferenceError em `deps` dentro de persistirDocumentosRetorno,');
  console.log('engolido pelo catch (ignorados++) e tratado como lote processado.\n');

  await test('TEST 1 — reprodução do bug original (deps fora de escopo = ReferenceError)', async () => {
    const reproduzido = reproduzirAcessoDepsForaDeEscopo();
    assert.strictEqual(reproduzido.lancou, true, 'a expressão antiga deve lançar');
    assert.strictEqual(reproduzido.nome, 'ReferenceError');
    assert.ok(
      /deps is not defined/i.test(reproduzido.mensagem || ''),
      `mensagem inesperada: ${reproduzido.mensagem}`
    );

    const corpo = corpoPersistirDocumentosRetorno();
    assert.ok(
      !/\bdeps\.contextoCentral/.test(corpo),
      'persistirDocumentosRetorno não deve mais ler deps fora de escopo'
    );

    const chamadas = [];
    const persistencia = {
      _empresaId: 7,
      persistirDocumentoDfe: async (dados) => {
        chamadas.push(dados);
        return { novo: true, duplicado: false, documento: { id: 1 } };
      }
    };
    const xml = montarRetornoDist({
      documentos: [{ nsu: '1', xml: criarXmlNota(CHAVE_A) }]
    });
    const resultado = await persistirDocumentosRetorno(xml, persistencia, 'dfe');

    assert.strictEqual(chamadas.length, 1, 'antes o persistirDocumentoDfe nem era chamado');
    assert.strictEqual(chamadas[0].empresaId, 7);
    assert.strictEqual(resultado.notasNovas, 1);
    assert.strictEqual(resultado.ignorados, 0);
  });

  await test('TEST 2 — processamento com dependências válidas', async () => {
    const chamadas = [];
    const persistencia = {
      persistirDocumentoDfe: async (dados) => {
        chamadas.push(dados);
        return { novo: true, duplicado: false, documento: { id: 99, chave: CHAVE_A } };
      }
    };
    const xml = montarRetornoDist({
      documentos: [{ nsu: '000000000000003', xml: criarXmlNota(CHAVE_A) }]
    });
    const resultado = await persistirDocumentosRetorno(xml, persistencia, 'dfe', {
      empresaId: 42
    });

    assert.strictEqual(resultado.notasNovas, 1);
    assert.strictEqual(resultado.notasDuplicadas, 0);
    assert.strictEqual(resultado.ignorados, 0);
    assert.strictEqual(chamadas.length, 1);
    assert.strictEqual(chamadas[0].empresaId, 42);
    assert.strictEqual(chamadas[0].nsu, '000000000000003');
    assert.ok(chamadas[0].xml && chamadas[0].xml.includes(CHAVE_A));
    assert.strictEqual(resolverEmpresaIdPersistenciaDfe({ empresaId: 42 }, { _empresaId: 7 }), 42);
    assert.strictEqual(resolverEmpresaIdPersistenciaDfe(null, { _empresaId: 7 }), 7);
  });

  await test('TEST 3 — persistência ausente/inválida: erro explícito, sem sucesso falso', async () => {
    const xml = montarRetornoDist({
      documentos: [{ nsu: '2', xml: criarXmlNota(CHAVE_A) }]
    });

    let erro = null;
    try {
      await persistirDocumentosRetorno(xml, {}, 'dfe', { empresaId: 42 });
    } catch (err) {
      erro = err;
    }

    assert.ok(erro, 'deve lançar');
    assert.strictEqual(erro.code, 'DISTDFE_PERSISTENCIA_AUSENTE');
    assert.ok(!('sucesso' in (erro || {}) && erro.sucesso === true));

    let erroNulo = null;
    try {
      await persistirDocumentosRetorno(xml, null, 'dfe');
    } catch (err) {
      erroNulo = err;
    }
    assert.ok(erroNulo);
    assert.strictEqual(erroNulo.code, 'DISTDFE_PERSISTENCIA_AUSENTE');
  });

  await test('TEST 4 — falha durante persistência: não conta como concluído nem sucesso falso', async () => {
    const persistencia = {
      persistirDocumentoDfe: async () => {
        const err = new Error('falha simulada no banco');
        err.code = 'SQLITE_ERROR';
        throw err;
      }
    };
    const xml = montarRetornoDist({
      documentos: [{ nsu: '8', xml: criarXmlNota(CHAVE_A) }]
    });
    const resultado = await persistirDocumentosRetorno(xml, persistencia, 'dfe', {
      empresaId: 42
    });

    assert.strictEqual(resultado.notasNovas, 0);
    assert.strictEqual(resultado.notasDuplicadas, 0);
    assert.strictEqual(resultado.ignorados, 1);
    assert.ok(resultado.sucesso !== true);
  });

  await test('TEST 5a — NSU: persistência concluída ainda aplica retorno DistDFe', async () => {
    const xml = montarRetornoDist({
      ultNSU: '5',
      maxNSU: '5',
      documentos: [{ nsu: '5', xml: criarXmlNota(CHAVE_A) }]
    });
    const nsuService = criarNsuServiceMock();
    const persistencia = {
      _empresaId: 42,
      persistirDocumentoDfe: async () => ({
        novo: true,
        duplicado: false,
        documento: { id: 1 }
      })
    };

    const resultado = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contextoCentralTeste(),
      persistenciaService: persistencia,
      nsuService,
      auditoriaService: criarAuditoriaNoOp(),
      enviarDistribuicaoDfe: async () => enviarDistMock(xml)
    });

    assert.strictEqual(resultado.sucesso, true);
    assert.strictEqual(resultado.notasNovas, 1);
    assert.strictEqual(nsuService.chamadasAplicar.length, 1);
  });

  await test('TEST 5b — NSU: falha estrutural NÃO aplica retorno DistDFe', async () => {
    const xml = montarRetornoDist({
      ultNSU: '9',
      maxNSU: '9',
      documentos: [{ nsu: '9', xml: criarXmlNota(CHAVE_A) }]
    });
    const nsuService = criarNsuServiceMock();

    let erro = null;
    try {
      await sincronizarDistribuicaoDFe({
        maxIteracoes: 1,
        contextoCentral: contextoCentralTeste(),
        persistenciaService: {},
        nsuService,
        auditoriaService: criarAuditoriaNoOp(),
        enviarDistribuicaoDfe: async () => enviarDistMock(xml)
      });
    } catch (err) {
      erro = err;
    }

    assert.ok(erro, 'falha estrutural deve propagar');
    assert.strictEqual(erro.code, 'DISTDFE_PERSISTENCIA_AUSENTE');
    assert.strictEqual(nsuService.chamadasAplicar.length, 0, 'NSU não pode avançar após falha estrutural');
  });

  await test('TEST 6 — idempotência: segundo processamento não duplica efeito', async () => {
    const chaves = new Set();
    const inserts = [];
    const persistencia = {
      persistirDocumentoDfe: async (dados) => {
        const chave = (String(dados.xml).match(/Id="NFe(\d{44})"/) || [])[1];
        if (chaves.has(chave)) {
          return { novo: false, duplicado: true, ignorado: false, documento: { id: 1, chave } };
        }
        chaves.add(chave);
        inserts.push(chave);
        return { novo: true, duplicado: false, documento: { id: 1, chave } };
      }
    };
    const xml = montarRetornoDist({
      documentos: [{ nsu: '1', xml: criarXmlNota(CHAVE_A) }]
    });

    const primeiro = await persistirDocumentosRetorno(xml, persistencia, 'dfe', { empresaId: 42 });
    const segundo = await persistirDocumentosRetorno(xml, persistencia, 'dfe', { empresaId: 42 });

    assert.strictEqual(primeiro.notasNovas, 1);
    assert.strictEqual(primeiro.notasDuplicadas, 0);
    assert.strictEqual(segundo.notasNovas, 0);
    assert.strictEqual(segundo.notasDuplicadas, 1);
    assert.strictEqual(inserts.length, 1);
  });

  await test('TEST 7 — sem novos documentos: não lança e não gera erro falso', async () => {
    const xml = montarRetornoDist({
      cStat: '137',
      ultNSU: '0',
      maxNSU: '0',
      documentos: []
    });
    const resultado = await persistirDocumentosRetorno(xml, null, 'dfe');

    assert.strictEqual(resultado.notasNovas, 0);
    assert.strictEqual(resultado.notasDuplicadas, 0);
    assert.strictEqual(resultado.ignorados, 0);
    assert.strictEqual(resultado.recebidosZip, 0);

    const nsuService = criarNsuServiceMock();
    const sync = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: contextoCentralTeste(),
      persistenciaService: { persistirDocumentoDfe: async () => {
        throw new Error('não deveria persistir lote vazio');
      } },
      nsuService,
      auditoriaService: criarAuditoriaNoOp(),
      enviarDistribuicaoDfe: async () => enviarDistMock(xml)
    });

    assert.strictEqual(sync.sucesso, true);
    assert.strictEqual(sync.notasNovas, 0);
    assert.ok(nsuService.chamadasAplicar.length >= 1, 'lote vazio com cStat de sucesso ainda consome NSU (política existente)');
  });

  console.log(`\nResultado: ${passou} ok, ${falhou} falhou\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
