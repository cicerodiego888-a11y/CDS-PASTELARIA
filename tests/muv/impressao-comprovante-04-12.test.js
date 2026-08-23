/**
 * Sprint 04.12 — adaptadores de impressão do comprovante unificado.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { TIPO_COMPROVANTE } = require('../../backend/motores/muv/ComprovanteUnificadoAtendimentoService');
const { imprimirComprovante, resolverPrintAdapter } = require('../../backend/motores/muv/impressao/ComprovantePrintService');
const { DESTINOS_IMPRESSAO } = require('../../backend/motores/muv/impressao/printContracts');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

function dtoOficial(extra = {}) {
  return {
    tipo: TIPO_COMPROVANTE,
    atendimento: {
      id: 1548,
      codigo: 'ATD-00001548',
      status: extra.status || 'CONCLUIDO',
      created_at: '2026-08-22 19:30'
    },
    estabelecimento: { nome: 'PASTELARIA XYZ' },
    cabecalho: { codigo: 'ATD-00001548', dataHora: '2026-08-22 19:30' },
    itens: extra.itens || [
      { itemId: 1, produtoId: 10, descricao: 'Suco de Laranja', quantidade: 2, valorTotal: 12 },
      { itemId: 2, produtoId: 11, descricao: 'Coca-Cola 200ml', quantidade: 6, valorTotal: 18 },
      { itemId: 3, produtoId: 12, descricao: 'Pastel de Carne', quantidade: 3, valorTotal: 21 }
    ],
    totais: { atendimento: 51, itens: 51, pagamentos: 51 },
    pagamento: { unificado: true, total: 51, formas: [{ formaPagamento: 'pix', valor: 51 }] },
    pagamentos: [{ formaPagamento: 'pix', valor: 51 }],
    documentos_fiscais: extra.documentos_fiscais || [],
    fiscal: extra.fiscal || { status: 'PENDENTE' }
  };
}

function depsDto(dto, extras = {}) {
  let obterChamadas = 0;
  return {
    obterChamadas: () => obterChamadas,
    deps: {
      obterComprovanteUnificado() {
        obterChamadas += 1;
        return dto;
      },
      ...extras
    }
  };
}

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
  }
}

async function test01PreviewText() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  assert.strictEqual(r.destino, 'PREVIEW');
  assert.strictEqual(r.preview, true);
  assert.ok(r.conteudo.includes('COMPROVANTE DE ATENDIMENTO'));
}

async function test02PreviewHtml() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'HTML' }, deps);
  assert.ok(r.conteudo.includes('<!DOCTYPE html>'));
}

async function test03BrowserHtml() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'BROWSER' }, deps);
  assert.strictEqual(r.destino, 'BROWSER');
  assert.strictEqual(r.formato, 'HTML');
  assert.strictEqual(r.pronto_para_impressao, true);
}

async function test04ThermalText() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'THERMAL', formato: 'TEXT' }, deps);
  assert.strictEqual(r.preparado, true);
  assert.strictEqual(r.impressao_fisica, false);
}

async function test05ThermalHtml() {
  const { deps } = depsDto(dtoOficial());
  await assertRejects(
    imprimirComprovante({ atendimentoId: 1548, destino: 'THERMAL', formato: 'HTML' }, deps),
    'FORMATO_NAO_SUPORTADO_PARA_DESTINO'
  );
}

async function test06DestinoInvalido() {
  const { deps } = depsDto(dtoOficial());
  await assertRejects(
    imprimirComprovante({ atendimentoId: 1548, destino: 'USB' }, deps),
    'DESTINO_IMPRESSAO_INVALIDO'
  );
}

async function test07FormatoInvalido() {
  const { deps } = depsDto(dtoOficial());
  await assertRejects(
    imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'PDF' }, deps),
    'COMPROVANTE_FORMATO_INVALIDO'
  );
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setupMini() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT,
      saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1, estoque_atual REAL DEFAULT 0, updated_at DATETIME
    )
  `);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('X', 99, 99, 198)`);
  const emp = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: emp.id, saldo_fiscal: 10, saldo_nao_fiscal: 5, estoque_atual: 15
  }, { db });
  return { db, produtoId: p.lastID, empresaId: emp.id };
}

async function test08Inexistente() {
  const ctx = await setupMini();
  await atendimentoService.criarAtendimento({
    itens: [{ produtoId: ctx.produtoId, empresaId: ctx.empresaId, quantidade: 1, valorUnitario: 10, tipoFiscal: 'FISCAL' }]
  }, { db: ctx.db });
  await assertRejects(
    imprimirComprovante({ atendimentoId: 9999, destino: 'PREVIEW', formato: 'TEXT' }, { db: ctx.db }),
    'ATENDIMENTO_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test09Cancelado() {
  const { deps } = depsDto(dtoOficial({ status: 'CANCELADO' }));
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  assert.ok(r.conteudo.includes('*** ATENDIMENTO CANCELADO ***'));
}

async function test10TresEmpresasContinuo() {
  const { deps } = depsDto(dtoOficial({
    documentos_fiscais: [
      { empresa_id: 1, empresa_nome: 'Empresa A', status: 'AUTORIZADA', documento: { numero: 123, chave: 'KA' } },
      { empresa_id: 2, empresa_nome: 'Empresa B', status: 'AUTORIZADA', documento: { numero: 456, chave: 'KB' } },
      { empresa_id: 3, empresa_nome: 'Empresa C', status: 'ERRO', documento: { numero: null } }
    ],
    fiscal: { status: 'FISCAL_PARCIAL' }
  }));
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  const itens = r.conteudo.slice(r.conteudo.indexOf('ITENS'), r.conteudo.indexOf('DOCUMENTOS FISCAIS'));
  assert.ok(!itens.includes('Empresa A'));
  assert.ok(itens.includes('2x Suco'));
  assert.ok(r.conteudo.includes('Empresa A'));
}

async function test11DocsDoDto() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  assert.ok(r.conteudo.includes('Nenhum documento fiscal disponível.'));
  assert.ok(!r.conteudo.includes('CHAVE-INVENTADA'));
}

async function test12NaoAlteraAtendimento() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/impressao/ComprovantePrintService.js'),
    'utf8'
  );
  assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/.test(src));
}

async function test13NaoAlteraEstoque() {
  const dir = path.join(__dirname, '../../backend/motores/muv/impressao');
  for (const nome of fs.readdirSync(dir)) {
    if (!nome.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, nome), 'utf8');
    assert.ok(!/debitarSaldo|estoque_empresa/.test(src), nome);
  }
}

async function test14NaoAlteraReservas() {
  const dir = path.join(__dirname, '../../backend/motores/muv/impressao');
  for (const nome of fs.readdirSync(dir)) {
    if (!nome.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, nome), 'utf8');
    assert.ok(!/reservarQuantidade|liberarQuantidade/.test(src), nome);
  }
}

async function test15NaoCriaVenda() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/impressao/ComprovantePrintService.js'),
    'utf8'
  );
  assert.ok(!src.includes('INSERT INTO vendas'));
}

async function test16NaoCriaDocFiscal() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/impressao/ComprovantePrintService.js'),
    'utf8'
  );
  assert.ok(!src.includes('nfce_notas'));
}

async function test17Repeticao() {
  const { deps } = depsDto(dtoOficial());
  const a = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  const b = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  assert.strictEqual(a.conteudo, b.conteudo);
}

async function test18PreviewPuro() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/impressao/PreviewPrintAdapter.js'),
    'utf8'
  );
  assert.ok(!src.includes('database'));
  assert.ok(!src.includes('usb'));
}

async function test19MetadataSemSegredo() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  const json = JSON.stringify(r.metadata);
  assert.ok(!/csc|senha|certificado|rateio/i.test(json));
  assert.strictEqual(r.metadata.tipo, TIPO_COMPROVANTE);
}

async function test20Largura32() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT', largura: 32 }, deps);
  assert.strictEqual(r.conteudo.split('\n')[0].length, 32);
}

async function test21Largura40() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT', largura: 40 }, deps);
  assert.strictEqual(r.conteudo.split('\n')[0].length, 40);
}

async function test22Largura48() {
  const { deps } = depsDto(dtoOficial());
  const r = await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT', largura: 48 }, deps);
  assert.strictEqual(r.conteudo.split('\n')[0].length, 48);
}

async function test23LarguraInvalida() {
  const { deps } = depsDto(dtoOficial());
  await assertRejects(
    imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT', largura: 41 }, deps),
    'LARGURA_IMPRESSAO_INVALIDA'
  );
}

async function test24ErroAdapter() {
  const { deps } = depsDto(dtoOficial(), {
    adapters: {
      PREVIEW: {
        async imprimir() {
          const err = new Error('falha adapter');
          err.code = 'DESTINO_IMPRESSAO_INVALIDO';
          throw err;
        }
      }
    }
  });
  await assertRejects(
    imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps),
    'DESTINO_IMPRESSAO_INVALIDO'
  );
}

async function test25ConteudoRenderizado() {
  let recebido = null;
  const { deps } = depsDto(dtoOficial(), {
    adapters: {
      PREVIEW: {
        async imprimir(payload) {
          recebido = payload;
          return { sucesso: true, destino: 'PREVIEW', preview: true, conteudo: payload.conteudo };
        }
      }
    }
  });
  await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, deps);
  assert.ok(recebido.conteudo.includes('TOTAL DO ATENDIMENTO'));
  assert.strictEqual(recebido.formato, 'TEXT');
}

async function test26UmaConsultaOficial() {
  const ctx = depsDto(dtoOficial());
  await imprimirComprovante({ atendimentoId: 1548, destino: 'PREVIEW', formato: 'TEXT' }, ctx.deps);
  assert.strictEqual(ctx.obterChamadas(), 1);
}

async function test27Resolver() {
  assert.strictEqual(resolverPrintAdapter('PREVIEW').constructor.name, 'PreviewPrintAdapter');
  assert.strictEqual(resolverPrintAdapter(DESTINOS_IMPRESSAO.THERMAL).constructor.name, 'ThermalPrintAdapter');
}

async function test28RotaHttp() {
  const src = fs.readFileSync(path.join(__dirname, '../../backend/rotas/atendimentos.js'), 'utf8');
  assert.ok(src.includes('/:id/imprimir'));
  assert.ok(src.includes('imprimirComprovante'));
}

async function main() {
  const testes = [
    ['01 PREVIEW TEXT', test01PreviewText],
    ['02 PREVIEW HTML', test02PreviewHtml],
    ['03 BROWSER HTML', test03BrowserHtml],
    ['04 THERMAL TEXT preparado', test04ThermalText],
    ['05 THERMAL HTML rejeitado', test05ThermalHtml],
    ['06 destino inválido', test06DestinoInvalido],
    ['07 formato inválido', test07FormatoInvalido],
    ['08 atendimento inexistente', test08Inexistente],
    ['09 CANCELADO imprime', test09Cancelado],
    ['10 A/B/C itens contínuos', test10TresEmpresasContinuo],
    ['11 docs só do DTO', test11DocsDoDto],
    ['12 não altera atendimento', test12NaoAlteraAtendimento],
    ['13 não altera estoque', test13NaoAlteraEstoque],
    ['14 não altera reservas', test14NaoAlteraReservas],
    ['15 não cria venda', test15NaoCriaVenda],
    ['16 não cria documento fiscal', test16NaoCriaDocFiscal],
    ['17 repetição', test17Repeticao],
    ['18 PREVIEW sem infra física', test18PreviewPuro],
    ['19 metadata sem segredos', test19MetadataSemSegredo],
    ['20 largura 32', test20Largura32],
    ['21 largura 40', test21Largura40],
    ['22 largura 48', test22Largura48],
    ['23 largura inválida', test23LarguraInvalida],
    ['24 erro do adapter', test24ErroAdapter],
    ['25 adapter recebe TEXT renderizado', test25ConteudoRenderizado],
    ['26 uma consulta oficial', test26UmaConsultaOficial],
    ['27 resolver adapters', test27Resolver],
    ['28 rota POST imprimir', test28RotaHttp]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nimpressao-comprovante-04-12: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
