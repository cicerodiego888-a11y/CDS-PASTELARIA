/**
 * Conciliação e plano de recuperação de NF-e ausentes — isolado.
 * Sem SEFAZ, sem certificado de produção, sem banco oficial.
 *
 * node --test tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js
 */
'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-conciliacao-nfe-');
const DB_DIR = isolamento.dbDir;
const fs = require('fs');
const path = require('path');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const zlib = require('zlib');

const {
  conciliarNfeAusentes,
  planejarConsChNFe,
  CLASSES
} = require('../../backend/motores/central-entradas/services/CentralConciliacaoNfeService');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const DocumentoFiscalInboxDTO = require('../../backend/motores/central-entradas/contracts/DocumentoFiscalInboxDTO');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  persistirDocumentosRetorno,
  sincronizarDistribuicaoDFe: sincronizarDistribuicaoDFeRaw
} = require('../../backend/services/fiscal/distribuicaoDFe');
const { anexarAutorizacaoTesteSefaz } = require('../../backend/services/fiscal/autorizacaoTransmissaoSefaz');
function sincronizarDistribuicaoDFe(deps) {
  return sincronizarDistribuicaoDFeRaw(anexarAutorizacaoTesteSefaz(deps));
}
const { listarPendenciasPersistenciaAbertas } = require('../../backend/services/fiscal/pendenciasPersistenciaDfe');
const {
  calcularIntervaloPeriodoPadrao,
  PERIODOS_PADRAO
} = require('../../backend/motores/central-entradas/services/CentralPeriodoPadraoService');
const { CentralEntradasOrchestrator } = require(
  '../../backend/motores/central-entradas/CentralEntradasOrchestrator'
);
const { ORIGENS } = require('../../backend/motores/central-entradas/config/centralEventosTipos');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_OUT = '35261012345678000199550010000000011000000011';
const CHAVE_SET = '35260912345678000199550010000000011000000099';
const CHAVE_B = '35261012345678000199550010000000021000000022';
const CHAVE_C = '35261012345678000199550010000000031000000033';

function xmlNota(chave, dhEmi) {
  const dh = dhEmi ? `<dhEmi>${dhEmi}</dhEmi>` : '';
  return `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${chave}">
    <ide><nNF>1</nNF><serie>1</serie><mod>55</mod>${dh}</ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>FORN</xNome></emit>
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

function montarRetornoDist({ cStat = '138', ultNSU = '5', maxNSU = '5', documentos = [] }) {
  const docZips = documentos.map((doc) => {
    const compactado = zlib.gzipSync(Buffer.from(doc.xml, 'utf8')).toString('base64');
    return `<docZip NSU="${doc.nsu}" schema="procNFe_v4.00.xsd">${compactado}</docZip>`;
  }).join('');
  return `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
    <cStat>${cStat}</cStat><xMotivo>Documento localizado</xMotivo>
    <ultNSU>${String(ultNSU).padStart(15, '0')}</ultNSU>
    <maxNSU>${String(maxNSU).padStart(15, '0')}</maxNSU>
    <loteDistDFeInt>${docZips}</loteDistDFeInt>
  </retDistDFeInt>`;
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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      numero TEXT, serie TEXT, modelo TEXT,
      fornecedor TEXT, cnpj_fornecedor TEXT,
      data_emissao TEXT, data_entrada TEXT, valor_total REAL,
      xml TEXT NOT NULL DEFAULT '<nfe/>',
      nsu TEXT, origem TEXT DEFAULT 'dfe',
      status TEXT, status_detalhe TEXT, tipo_documento TEXT,
      parse_json TEXT, miip_sessao_id TEXT, miip_resumo_json TEXT,
      processado_em TEXT, compra_id INTEGER, usuario_id INTEGER,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER, status_anterior TEXT, status_novo TEXT,
      detalhe TEXT, usuario_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE dfe_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT, empresa_id INTEGER, cnpj TEXT, ambiente INTEGER,
      nsu TEXT, tipo TEXT, schema TEXT, chave TEXT,
      resultado TEXT NOT NULL, motivo TEXT, tempo_ms INTEGER, detalhe_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY, chave_acesso TEXT, empresa_id INTEGER,
      tipo_entrada TEXT, tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL, tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER
    )
  `);
  return db;
}

function auditoriaNoop() {
  return {
    registrar: async () => {},
    registrarConsulta: async () => {},
    registrarResumoSync: async () => {},
    registrarNsuAvanco: async () => {}
  };
}

describe('Classe A — persistido oculto por filtro', () => {
  it('setembro permanece no repositório e some no mês vigente', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_SET, '2026-09-15T08:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe',
      nsu: '3'
    });
    const repo = new CentralDocumentosRepository({ db });
    const intervalo = calcularIntervaloPeriodoPadrao(PERIODOS_PADRAO.MES_VIGENTE, new Date(2026, 9, 17));
    const todos = await repo.listar({ empresaId: EMP_A });
    const doMes = await repo.listar({
      empresaId: EMP_A,
      dataEmissaoInicio: intervalo.dataEmissaoInicio,
      dataEmissaoFim: intervalo.dataEmissaoFim
    });
    const resultado = conciliarNfeAusentes({
      documentos: todos,
      filtroUi: {
        empresaId: EMP_A,
        dataEmissaoInicio: intervalo.dataEmissaoInicio,
        dataEmissaoFim: intervalo.dataEmissaoFim
      }
    });
    assert.equal(todos.length, 1);
    assert.equal(doMes.length, 0);
    assert.equal(resultado.resumo.classeA, 1);
    assert.equal(resultado.porClasse.A[0].causaComprovada, 'oculto_por_filtro:periodo');
    assert.equal(resultado.porClasse.A[0].plano.executaSefaz, false);
    db.close();
  });
});

describe('Data fiscal vs estimada', () => {
  it('dhEmi comprovada não é marcada como estimada', () => {
    const dto = DocumentoFiscalInboxDTO.create({
      chave: CHAVE_OUT,
      dataEmissao: '2026-10-10',
      dataEmissaoOrigem: 'xml'
    }).toJSON();
    assert.equal(dto.dataEmissaoEstimada, false);
    const meta = CentralDfePersistenciaService.completarDataEmissaoFromChave({
      chave: CHAVE_OUT,
      dataEmissao: '2026-10-10'
    });
    assert.equal(meta.dataEmissaoOrigem, 'xml');
    assert.equal(meta.dataEmissao, '2026-10-10');
  });

  it('sem dhEmi a data AAMM fica identificada como estimada', () => {
    const meta = CentralDfePersistenciaService.completarDataEmissaoFromChave({
      chave: CHAVE_OUT,
      dataEmissao: ''
    });
    assert.equal(meta.dataEmissao, '2026-10-01');
    assert.equal(meta.dataEmissaoOrigem, 'chave_aamm');
    const dto = DocumentoFiscalInboxDTO.create({
      chave: CHAVE_OUT,
      dataEmissao: meta.dataEmissao,
      dataEmissaoOrigem: meta.dataEmissaoOrigem
    }).toJSON();
    assert.equal(dto.dataEmissaoEstimada, true);
  });
});

describe('Classe B — ERRO_BANCO', () => {
  it('pendência com chave e empresa permanece aberta após reinício simulado', async () => {
    const db = await criarDb();
    await run(db, `
      INSERT INTO dfe_auditoria (empresa_id, chave, nsu, tipo, resultado, motivo)
      VALUES (?, ?, '9', 'PERSISTENCIA', 'ERRO_BANCO', 'SQLITE_BUSY')
    `, [EMP_A, CHAVE_OUT]);
    const abertas1 = await listarPendenciasPersistenciaAbertas(db, { empresaId: EMP_A });
    assert.equal(abertas1.length, 1);
    db.close();

    const db2 = await criarDb();
    await run(db2, `
      INSERT INTO dfe_auditoria (empresa_id, chave, nsu, tipo, resultado, motivo)
      VALUES (?, ?, '9', 'PERSISTENCIA', 'ERRO_BANCO', 'SQLITE_BUSY')
    `, [EMP_A, CHAVE_OUT]);
    const abertas2 = await listarPendenciasPersistenciaAbertas(db2, { empresaId: EMP_A });
    assert.equal(abertas2.length, 1);
    const resultado = conciliarNfeAusentes({
      documentos: [],
      pendenciasAuditoria: [{
        resultado: 'ERRO_BANCO',
        tipo: 'PERSISTENCIA',
        chave: CHAVE_OUT,
        empresaId: EMP_A,
        nsu: '9'
      }],
      nsuAtual: { ultNsu: '000000000000000' }
    });
    assert.equal(resultado.resumo.classeB, 1);
    assert.equal(resultado.porClasse.B[0].chave, CHAVE_OUT);
    db2.close();
  });

  it('pendência fecha quando o documento correspondente está persistido', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_OUT, '2026-10-10T10:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    await run(db, `
      INSERT INTO dfe_auditoria (empresa_id, chave, nsu, tipo, resultado)
      VALUES (?, ?, '4', 'PERSISTENCIA', 'ERRO_BANCO')
    `, [EMP_A, CHAVE_OUT]);
    const abertas = await listarPendenciasPersistenciaAbertas(db, { empresaId: EMP_A });
    const docs = await new CentralDocumentosRepository({ db }).listar({ empresaId: EMP_A });
    const resultado = conciliarNfeAusentes({
      documentos: docs,
      pendenciasAuditoria: [{
        resultado: 'ERRO_BANCO',
        tipo: 'PERSISTENCIA',
        chave: CHAVE_OUT,
        empresaId: EMP_A
      }]
    });
    assert.equal(abertas.length, 0);
    assert.equal(resultado.resumo.pendenciasReconciliadas, 1);
    assert.equal(resultado.resumo.classeB, 0);
    db.close();
  });
});

describe('NSU, lote parcial e idempotência', () => {
  it('falha de persistência não avança NSU', async () => {
    const aplicar = [];
    const resultado = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: {
        certificadoPath: 'x.pfx',
        certificadoSenha: 'x',
        cnpj: '11111111000191',
        codigoUf: '23',
        ambiente: 2,
        empresaId: EMP_A
      },
      nsuService: {
        obterOuCriar: async () => ({ id: 1, ultNsu: '000000000000000', maxNsu: '000000000000000' }),
        aplicarRetornoDistDfe: async (p) => {
          aplicar.push(p);
          return { controle: p, atualizouNsu: true, ultNsu: p.ultNsu, maxNsu: p.maxNsu };
        }
      },
      persistenciaService: {
        persistirDocumentoDfe: async () => {
          const err = new Error('SQLITE_BUSY');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
      },
      auditoriaService: auditoriaNoop(),
      enviarDistribuicaoDfe: async () => ({
        success: true,
        body: montarRetornoDist({
          ultNSU: '9',
          maxNSU: '9',
          documentos: [{ nsu: '9', xml: xmlNota(CHAVE_OUT, '2026-10-10T10:00:00-03:00') }]
        }),
        endpoint: 'https://example.invalid/dfe',
        statusCode: 200
      })
    });
    assert.equal(resultado.consultaExecutada, true);
    assert.equal(resultado.sucesso, false);
    assert.equal(aplicar.length, 0);
    assert.equal(resultado.ultNsu, '000000000000000');
  });

  it('lote com dois documentos: falha no segundo não perde o primeiro em silêncio', async () => {
    let n = 0;
    const lote = await persistirDocumentosRetorno(
      montarRetornoDist({
        documentos: [
          { nsu: '1', xml: xmlNota(CHAVE_OUT, '2026-10-10T10:00:00-03:00') },
          { nsu: '2', xml: xmlNota(CHAVE_B, '2026-10-11T10:00:00-03:00') }
        ]
      }),
      {
        persistirDocumentoDfe: async (doc) => {
          n += 1;
          const xml = String(doc.xml || '');
          if (xml.includes(CHAVE_B)) {
            const err = new Error('falha no segundo');
            err.code = 'SQLITE_BUSY';
            throw err;
          }
          return { novo: true, documento: { chave: CHAVE_OUT } };
        }
      },
      'dfe',
      { empresaId: EMP_A }
    );
    assert.equal(lote.notasNovas, 1);
    assert.equal(lote.errosPersistencia.length, 1);
    assert.equal(lote.errosPersistencia[0].chave, CHAVE_B);
  });

  it('resposta repetida não duplica documento da mesma empresa', async () => {
    const db = await criarDb();
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: new CentralDocumentosRepository({ db }),
      historicoRepository: new CentralHistoricoRepository({ db }),
      empresaId: EMP_A
    });
    const xml = xmlNota(CHAVE_OUT, '2026-10-10T10:00:00-03:00');
    const a = await persist.persistirDocumentoDfe({ xml, nsu: '1', origem: 'dfe', empresaId: EMP_A });
    const b = await persist.persistirDocumentoDfe({ xml, nsu: '1', origem: 'dfe', empresaId: EMP_A });
    assert.equal(b.duplicado, true);
    assert.equal(a.documento.id, b.documento.id);
    const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [
      CHAVE_OUT, EMP_A
    ]);
    assert.equal(n.n, 1);
    db.close();
  });

  it('empresa B não vê documento da empresa A', async () => {
    const db = await criarDb();
    const repo = new CentralDocumentosRepository({ db });
    const persist = new CentralDfePersistenciaService({
      db,
      documentosRepository: repo,
      historicoRepository: new CentralHistoricoRepository({ db })
    });
    await persist.persistirDocumentoDfe({
      xml: xmlNota(CHAVE_OUT, '2026-10-10T10:00:00-03:00'),
      empresaId: EMP_A,
      origem: 'dfe'
    });
    assert.equal((await repo.listar({ empresaId: EMP_B })).length, 0);
    assert.equal((await repo.listar({ empresaId: EMP_A })).length, 1);
    db.close();
  });
});

describe('Classe C — chave conhecida sem persistência', () => {
  it('plano consChNFe existe e não executa SEFAZ', () => {
    const resultado = conciliarNfeAusentes({
      documentos: [],
      chavesConhecidas: [{ chave: CHAVE_C, empresaId: EMP_A }],
      gateBloqueado: false,
      cooldownAtivo: false
    });
    assert.equal(resultado.resumo.classeC, 1);
    assert.equal(resultado.porClasse.C[0].chave, CHAVE_C);
    assert.equal(resultado.porClasse.C[0].plano.mecanismo, 'consChNFe');
    assert.equal(resultado.sefazExecutada, false);
    const plano = planejarConsChNFe({ chave: CHAVE_C, empresaId: EMP_A });
    assert.equal(plano.viavel, true);
    assert.equal(plano.executaSefaz, false);
    assert.equal(plano.alteraNsu, false);
    assert.equal(plano.envia210210, false);
  });

  it('empresa_id ausente ou divergente não planeja consulta', () => {
    const semEmpresa = planejarConsChNFe({ chave: CHAVE_C });
    assert.equal(semEmpresa.viavel, false);
    assert.equal(semEmpresa.motivo, 'EMPRESA_CENTRAL_AUSENTE');
    const divergente = planejarConsChNFe({
      chave: CHAVE_C,
      empresaId: EMP_B,
      empresaIdEsperada: EMP_A
    });
    assert.equal(divergente.viavel, false);
    assert.equal(divergente.motivo, 'EMPRESA_DIVERGENTE');
    const e = conciliarNfeAusentes({
      chavesConhecidas: [{ chave: CHAVE_C }]
    });
    assert.equal(e.resumo.classeE, 1);
    assert.equal(e.porClasse.E[0].hipotese, 'empresa_id_ausente');
  });
});

describe('Classe D e E', () => {
  it('NSU avançado sem chave não inventa recuperação DistDFe', () => {
    const resultado = conciliarNfeAusentes({
      avancosNsuSemChave: [{ empresaId: EMP_A, nsu: '000000000000050' }]
    });
    assert.equal(resultado.resumo.classeD, 1);
    assert.equal(resultado.porClasse.D[0].chave, null);
    assert.equal(resultado.porClasse.D[0].plano.mecanismo, 'nenhum_no_produto');
    assert.match(resultado.porClasse.D[0].plano.limitacao, /consNSU/);
  });

  it('sem fontes locais permanece inconclusivo — produção não foi lida', () => {
    const resultado = conciliarNfeAusentes({});
    assert.equal(resultado.resumo.classeE, 1);
    assert.ok(resultado.porClasse.E[0].plano.dadosFaltantes.includes('lista_chaves_esperadas'));
  });
});

describe('Gate, cooldown e 210210', () => {
  it('Gate/cooldown bloqueiam o plano e não equivalem a consulta executada', async () => {
    const planoGate = planejarConsChNFe({
      chave: CHAVE_C,
      empresaId: EMP_A,
      gateBloqueado: true
    });
    const planoCd = planejarConsChNFe({
      chave: CHAVE_C,
      empresaId: EMP_A,
      cooldownAtivo: true
    });
    assert.equal(planoGate.motivo, 'GATE_BLOQUEADO');
    assert.equal(planoCd.motivo, 'COOLDOWN');

    const r = await sincronizarDistribuicaoDFe({
      maxIteracoes: 1,
      contextoCentral: {
        certificadoPath: 'x.pfx',
        certificadoSenha: 'x',
        cnpj: '11111111000191',
        codigoUf: '23',
        ambiente: 2,
        empresaId: EMP_A
      },
      gateSefaz: {
        autorizarConsultaDistDfe: async () => ({
          permitido: false,
          codigo: 'BLOQUEADO_CONSUMO_INDEVIDO_656',
          mensagem: 'bloqueado'
        })
      },
      enviarDistribuicaoDfe: async () => {
        throw new Error('SOAP não deveria ocorrer');
      }
    });
    assert.equal(r.consultaExecutada, false);
    assert.equal(r.bloqueadoGate, true);
  });

  it('sincronização ignorada não dispara 210210', async () => {
    let ciencia = 0;
    const mini = Object.create(CentralEntradasOrchestrator.prototype);
    mini._syncExecucao = {
      executar: async () => ({
        sucesso: false,
        ignorado: true,
        consultaExecutada: false,
        codigo: 'AGUARDAR_JANELA_DFE'
      })
    };
    mini._manifestacaoDfeService = {
      processarCandidatos: async () => {
        ciencia += 1;
        return {};
      }
    };
    mini.processarDocumentosPendentes = async () => [];
    await mini.executarSincronizacao({ origem: ORIGENS.ABRIR_CENTRAL });
    assert.equal(ciencia, 0);
  });
});

describe('Regressão abertura e fontes oficiais', () => {
  it('abertura ainda distingue consulta executada e tem um único POST ao abrir', () => {
    const front = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/central-entradas.js'), 'utf8');
    const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/central-entradas.js'), 'utf8');
    assert.equal(front.split('/sincronizar-ao-abrir').length - 1, 1);
    assert.match(front, /syncAoAbrirEmVoo/);
    assert.match(rota, /consultaExecutada: false/);
    assert.match(rota, /SYNC_AO_ABRIR_DESABILITADO/);
  });

  it('CNPJ oficial permanece empresas.cnpj e consNSU não existe no DistDFe', () => {
    const ctx = fs.readFileSync(
      path.join(__dirname, '../../backend/motores/central-entradas/services/CentralConfiguracaoService.js'),
      'utf8'
    );
    const dist = fs.readFileSync(
      path.join(__dirname, '../../backend/services/fiscal/distribuicaoDFe.js'),
      'utf8'
    );
    assert.match(ctx, /empresas\.cnpj/);
    assert.equal(/function montarXmlConsNsu/.test(dist), false);
    assert.match(dist, /consChNFe/);
    assert.match(dist, /function montarXmlDistNsu/);
  });
});
