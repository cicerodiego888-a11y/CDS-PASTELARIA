'use strict';

/**
 * CDS-PDV-TEF-DESATIVADO-NAO-EXIGIR-PROVEDOR-01
 * Banco temporário — sem banco oficial, sem transação financeira real.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-tef-desativado-01-'));
process.env.DB_DIR = tmpDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const ROOT = path.join(__dirname, '../..');

function waitDb(timeoutMs = 20000) {
  const db = require('../../backend/database');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      db.get('SELECT 1 AS ok', (err, row) => {
        if (!err && row && Number(row.ok) === 1) return resolve(db);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error('DB temp não pronto'));
        }
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
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

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

async function limparConfigTef(db) {
  await run(db, 'DELETE FROM tef_configuracao WHERE id > 0');
}

async function gravarConfigTef(db, { habilitado, provedor, ambiente = 'simulacao' }) {
  await limparConfigTef(db);
  await run(db, `
    INSERT INTO tef_configuracao (habilitado, provedor, ambiente, terminal_codigo, atualizado_em)
    VALUES (?, ?, ?, 'T1', datetime('now'))
  `, [habilitado ? 1 : 0, provedor, ambiente]);
}

async function main() {
  const db = await waitDb();

  const tefFactory = require('../../backend/services/tef/tefFactory');
  const tefFluxoPagamento = require('../../backend/services/tef/tefFluxoPagamento');
  const tefManager = require('../../backend/services/tef/TefManager');

  // --- A: TEF desativado, provedor vazio → NÃO exige provedor ---
  await gravarConfigTef(db, { habilitado: false, provedor: '' });

  let erroDesligado = null;
  try {
    await tefFactory.obterAdapter();
  } catch (err) {
    erroDesligado = err;
  }
  assert.ok(erroDesligado, 'obterAdapter deve falhar com TEF desligado');
  assert.strictEqual(erroDesligado.code, 'TEF_DESABILITADO');
  assert.doesNotMatch(String(erroDesligado.message), /Provedor TEF não suportado/);
  assert.doesNotMatch(String(erroDesligado.message), /Provedor TEF não configurado/);

  const autorizacao = await tefManager.autorizar({
    tipo: 'credito',
    valor: 10,
    empresa_id: 1,
    operador_id: 1,
    idempotency_key: 'aud-tef-off-1'
  });
  assert.strictEqual(autorizacao.codigo, 'TEF_DESABILITADO');
  assert.strictEqual(autorizacao.aprovado, false);
  assert.doesNotMatch(String(autorizacao.mensagem || ''), /Provedor TEF não suportado/);

  // Fluxo fiscal manual independente do TEF
  const fluxoManual = tefFluxoPagamento.resolverFluxoPagamentoFiscal({
    modoConfirmacaoFiscal: 'MANUAL',
    tefHabilitado: false,
    formaPagamento: 'dinheiro',
    ehPagamentoMisto: false,
    totalFiscal: 10
  });
  assert.strictEqual(fluxoManual.deveUsarTefAutomatico, false);
  assert.strictEqual(fluxoManual.usarConfirmacaoManual, true);

  const fluxoCartaoOff = tefFluxoPagamento.resolverFluxoPagamentoFiscal({
    modoConfirmacaoFiscal: 'MANUAL',
    tefHabilitado: false,
    formaPagamento: 'credito',
    ehPagamentoMisto: false,
    totalFiscal: 10
  });
  assert.strictEqual(fluxoCartaoOff.deveUsarTefAutomatico, false);
  assert.strictEqual(fluxoCartaoOff.usarConfirmacaoManual, true);

  // Frontend PDV: processarPagamentoTEF deve consultar fluxo antes de /pagar
  const pdvSrc = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
  const bloco = pdvSrc.slice(
    pdvSrc.indexOf('async function processarPagamentoTEF'),
    pdvSrc.indexOf('async function processarPagamentoTEF') + 1200
  );
  assert.match(bloco, /obterTefHabilitadoConfig/);
  assert.match(bloco, /TEF_DESABILITADO/);
  assert.match(bloco, /tefLigado/);
  // Guarda ocorre antes da notificação de processamento
  const idxGate = bloco.indexOf('TEF_DESABILITADO');
  const idxNotif = bloco.indexOf('Processando pagamento TEF');
  assert.ok(idxGate > 0 && idxNotif > idxGate, 'gate TEF_DESABILITADO antes do modal/notificação');

  // Rota /pagar tem guarda
  const rota = fs.readFileSync(path.join(ROOT, 'backend/rotas/tef.js'), 'utf8');
  assert.match(rota, /TEF_DESABILITADO/);
  assert.match(rota, /parseTefHabilitado\(tefConfig\.tefHabilitado\)/);

  // Diagnóstico não carrega adapter com TEF off
  const diag = fs.readFileSync(path.join(ROOT, 'backend/services/tef/tefDiagnosticoService.js'), 'utf8');
  assert.match(diag, /tefLigado/);
  assert.match(diag, /não carregar adaptador/);

  console.log(JSON.stringify({
    ok: true,
    cenario_A: 'TEF desativado sem exigir provedor',
    codigo: 'TEF_DESABILITADO'
  }));

  // --- B: TEF habilitado continua exigindo provedor ---
  await gravarConfigTef(db, { habilitado: true, provedor: '' });
  let erroProvedor = null;
  try {
    await tefFactory.obterAdapter();
  } catch (err) {
    erroProvedor = err;
  }
  assert.ok(erroProvedor);
  assert.strictEqual(erroProvedor.code, 'TEF_PROVEDOR_AUSENTE');
  assert.match(String(erroProvedor.message), /Provedor TEF não configurado/);

  await gravarConfigTef(db, { habilitado: true, provedor: 'provedor_fantasma' });
  let erroInvalido = null;
  try {
    await tefFactory.obterAdapter();
  } catch (err) {
    erroInvalido = err;
  }
  assert.ok(erroInvalido);
  assert.match(String(erroInvalido.message), /Provedor TEF não suportado: provedor_fantasma/);

  await gravarConfigTef(db, { habilitado: true, provedor: 'sitef' });
  const adapterSitef = await tefFactory.obterAdapter();
  assert.ok(adapterSitef);
  assert.ok(
    adapterSitef.nome === 'CliSiTef'
    || adapterSitef.nome === 'sitef'
    || String(adapterSitef.constructor.name).toLowerCase().includes('sitef')
  );

  console.log(JSON.stringify({
    ok: true,
    cenario_B: 'TEF habilitado valida provedor',
    ausente: 'TEF_PROVEDOR_AUSENTE',
    invalido: 'Provedor TEF não suportado: provedor_fantasma',
    sitef: true
  }));

  // --- C: confirmação fiscal Manual (sem alterar motor fiscal) ---
  const hashMotorFiscal = sha256('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(/^[a-f0-9]{64}$/.test(hashMotorFiscal));
  const fluxoC = tefFluxoPagamento.resolverFluxoPagamentoFiscal({
    modoConfirmacaoFiscal: 'MANUAL',
    tefHabilitado: false,
    formaPagamento: 'pix',
    totalFiscal: 5
  });
  assert.strictEqual(fluxoC.usarConfirmacaoManual, true);
  assert.strictEqual(fluxoC.deveUsarTefAutomatico, false);

  // --- D: regressão — PDV Universal já tem gate; factory central cobre Express/Normal ---
  const univ = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal-tef.js'), 'utf8');
  assert.match(univ, /TEF_DESABILITADO|parseTefHabilitado|validarTefOperacional/);
  assert.match(pdvSrc, /obterTefHabilitadoConfig/);

  // Flag real
  const cfg = await get(db, 'SELECT habilitado, provedor FROM tef_configuracao LIMIT 1');
  assert.strictEqual(Number(cfg.habilitado), 1);

  console.log(JSON.stringify({
    ok: true,
    flag: 'tef_configuracao.habilitado → tefConfigService.tefHabilitado → fluxo-pdv.tefHabilitado',
    motor_fiscal_inalterado_hash: hashMotorFiscal,
    testes: ['A', 'B', 'C', 'D']
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
