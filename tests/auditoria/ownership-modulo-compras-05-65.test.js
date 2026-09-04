/**
 * Sprint 05.65 — Auditoria final de ownership do módulo compras (05.56–05.64).
 * Comprova o estado ATUAL. Não altera produção.
 * Executar: node tests/auditoria/ownership-modulo-compras-05-65.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function rotas() {
  return src('backend/rotas/compras.js');
}

function coletarInsertsCompras() {
  const hits = [];
  function walk(dir) {
    for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
      if (nome.name === 'node_modules' || nome.name === '.git') continue;
      const full = path.join(dir, nome.name);
      if (nome.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|sql)$/i.test(nome.name)) continue;
      const texto = fs.readFileSync(full, 'utf8');
      const re = /INSERT\s+INTO\s+compras\s*\(/gi;
      let m;
      while ((m = re.exec(texto))) {
        const trecho = texto.slice(m.index, m.index + 40).replace(/\s+/g, ' ');
        if (/INSERT\s+INTO\s+compras_itens/i.test(trecho)) continue;
        if (/INSERT\s+INTO\s+compras_devolucoes/i.test(trecho)) continue;
        hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(path.join(ROOT, 'backend'));
  return hits;
}

function t01writersCompras() {
  const hits = coletarInsertsCompras();
  const unico = [...new Set(hits)];
  assert.deepStrictEqual(unico, ['backend/rotas/compras.js']);
  assert.ok(rotas().includes("router.post('/',"));
  assert.ok(rotas().includes('resolverEmpresaDaCompra'));
  console.log('  T01 1 INSERT produção em compras: POST / via resolverEmpresaDaCompra');
}

function t02writersSatelites() {
  const t = rotas();
  assert.ok(/INSERT\s+INTO\s+compras_itens/i.test(t));
  assert.ok(/INSERT\s+INTO\s+compras_devolucoes/i.test(t));
  assert.ok(/INSERT\s+INTO\s+financeiro/i.test(t));
  assert.ok(t.includes('UPDATE financeiro'));
  assert.ok(src('backend/services/compras/ComprasEmpresaContextoService.js').includes(
    'UPDATE compras SET chave_acesso = ? WHERE id = ? AND empresa_id = ?'
  ));
  console.log('  T02 writers satélites: itens, devoluções, financeiro, chave NF-e');
}

function t03listaDetalheFinanceiro() {
  const t = rotas();
  const lista = t.slice(t.indexOf("router.get('/',"), t.indexOf("router.get('/:id'"));
  const det = t.slice(t.indexOf("router.get('/:id'"), t.indexOf("router.post('/',"));
  assert.ok(lista.includes('f.empresa_id = c.empresa_id'));
  assert.ok(det.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(det.includes('WHERE compra_id = ? AND empresa_id = ?'));
  assert.ok(det.includes('compra.empresa_id'));
  console.log('  T03 GET / e GET /:id financeiro isolados (05.64)');
}

function t04mutacoesOpacas() {
  const t = rotas();
  assert.ok(t.includes("router.post('/:id/cancelar'"));
  assert.ok(t.includes("router.post('/:id/devolver'"));
  const canc = t.slice(t.indexOf("router.post('/:id/cancelar'"), t.indexOf("router.post('/parse-xml'"));
  const dev = t.slice(t.indexOf("router.post('/:id/devolver'"), t.indexOf("router.get('/relatorio/uso-consumo'"));
  assert.ok(canc.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(dev.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(canc.includes('WHERE id = ?') && canc.includes('AND empresa_id = ?'));
  console.log('  T04 cancelar/devolver: load opaco 05.59; cancelar UPDATE com empresa_id');
}

function t05devolverUpdateSemEmpresa() {
  const t = rotas();
  const dev = t.slice(t.indexOf("router.post('/:id/devolver'"), t.indexOf("router.get('/relatorio/uso-consumo'"));
  assert.ok(/UPDATE compras\s+SET status = \?[\s\S]*?WHERE id = \?/.test(dev));
  assert.ok(!/UPDATE compras[\s\S]*?WHERE id = \?[\s\S]*?AND empresa_id = \?/.test(
    dev.slice(dev.lastIndexOf('UPDATE compras'))
  ));
  console.log('  T05 devolução: UPDATE compras só por id (após ownership; defesa em profundidade ausente)');
}

function t06chaveGlobal() {
  const t = rotas();
  assert.ok(t.includes("SELECT id, status FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1"));
  assert.ok(!t.includes("SELECT id, status FROM compras WHERE chave_acesso = ? LIMIT 1"));
  const persist = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(persist.includes('SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1'));
  console.log('  T06 POST 05.67 e Central 05.68: chave + empresa_id');
}

function t07nfeDevolucaoSemGuard() {
  const t = rotas();
  const bloco = t.slice(t.indexOf("router.get('/:id/nfe-devolucao/preparar'"));
  assert.ok(bloco.includes('autorizarCompraParaNfeDevolucao'));
  assert.ok(bloco.includes('autorizarNotaNfeDevolucaoCompra'));
  assert.ok(bloco.includes("emitirNFeDevolucaoCompra(compraId"));
  const svc = src('backend/services/fiscal/nfeDevolucaoCompra.js');
  assert.ok(svc.includes('WHERE c.id = ?'));
  console.log('  T07 NF-e devolução: rotas com guard 05.66; service ainda carrega compra por id');
}

function t08usoConsumoIsolado() {
  const t = rotas();
  const rel = t.slice(t.indexOf("router.get('/relatorio/uso-consumo'"), t.indexOf("router.get('/politicas-entrada'"));
  assert.ok(rel.includes('d.empresa_id = c.empresa_id'));
  assert.ok((rel.match(/f\.empresa_id\s*=\s*c\.empresa_id/g) || []).length === 3);
  console.log('  T08 relatório uso/consumo: JOIN Central + financeiro 05.61/05.62');
}

function t09classificadorGlobal() {
  const c = src('backend/services/compras/ClassificadorEntradaCompra.js');
  assert.ok(c.includes('FROM compras'));
  assert.ok(c.includes('historicoFornecedor'));
  const hist = c.slice(c.indexOf('async function historicoFornecedor'), c.indexOf('async function historicoFornecedor') + 900);
  assert.ok(!hist.includes('empresa_id'));
  console.log('  T09 classificador: histórico de CNPJ em compras sem filtro empresarial');
}

function t10listaFiscalResidual() {
  const t = rotas();
  const lista = t.slice(t.indexOf("router.get('/',"), t.indexOf("router.get('/:id'"));
  assert.ok(lista.includes('nfe_devolucoes_compra'));
  assert.ok(lista.includes('WHERE d.compra_id = c.id AND d.status'));
  assert.ok(!/nfe_devolucoes_compra[\s\S]{0,200}empresa_id/.test(lista));
  const helpers = src('backend/utils/comprasEmpresaHelpers.js');
  assert.ok(helpers.includes('backfillComprasEmpresaId'));
  console.log('  T10 GET / agrega NF-e devolução só por compra_id; backfill helper existe (E)');
}

function main() {
  console.log('05.65 auditoria final ownership módulo compras');
  t01writersCompras();
  t02writersSatelites();
  t03listaDetalheFinanceiro();
  t04mutacoesOpacas();
  t05devolverUpdateSemEmpresa();
  t06chaveGlobal();
  t07nfeDevolucaoSemGuard();
  t08usoConsumoIsolado();
  t09classificadorGlobal();
  t10listaFiscalResidual();
  console.log('T01–T10 OK');
}

main();
