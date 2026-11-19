'use strict';

/**
 * Diff real da correção de homologação S05 (isolamento unidade).
 * Baseline = estado pós-S05 inicial (antes desta correção), reconstruído removendo
 * as alterações desta correção dos arquivos atuais.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const baseDir = path.join(os.tmpdir(), 'cds-s05-homolog-baseline');
const outPatch = path.join(__dirname, 'DIFF-CORRECAO-HOMOLOGACAO-S05.patch');
fs.mkdirSync(baseDir, { recursive: true });

function gitDiff(a, b) {
  try {
    return execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--', a, b], {
      encoding: 'utf8', cwd: repo, maxBuffer: 10 * 1024 * 1024
    });
  } catch (e) {
    if (typeof e.stdout === 'string') return e.stdout;
    throw e;
  }
}

function normalize(diffText, logical, absA, absB) {
  let out = diffText;
  for (const v of [absA, absA.replace(/\//g, '\\'), path.resolve(absA)]) {
    out = out.split(v).join(`a/${logical}`);
  }
  for (const v of [absB, absB.replace(/\//g, '\\'), path.resolve(absB)]) {
    out = out.split(v).join(`b/${logical}`);
  }
  out = out.replace(/diff --git "a\/[^"]+" "b\/[^"]+"/g, `diff --git a/${logical} b/${logical}`);
  out = out.replace(/^--- .*$/m, `--- a/${logical}`);
  out = out.replace(/^\+\+\+ .*$/m, `+++ b/${logical}`);
  return out;
}

// --- Service: revert to optional unidade ---
const srcService = path.join(repo, 'backend/services/cozinha/CozinhaPreparacaoService.js');
let s = fs.readFileSync(srcService, 'utf8');
s = s.replace(
  "const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');\n",
  ''
);
s = s.replace(
  `/**
 * Garante vínculo item ↔ rodada ↔ unidade ↔ comanda na mesma empresa.
 * unidadeIdAutorizada é obrigatória (origem: sessão autenticada via rota).
 */
async function validarIntegridadeOperacional(db, item, rodada, {
  empresaId,
  unidadeIdAutorizada
}) {
  if (Number(item.rodada_id) !== Number(rodada.id)) {
    throw erro('Item não pertence à rodada informada.', 409, 'ITEM_RODADA_INCOMPATIVEL');
  }
  if (Number(item.empresa_id) !== Number(empresaId)
    || Number(rodada.empresa_id) !== Number(empresaId)) {
    throw erro('Isolamento empresarial violado.', 403, 'EMPRESA_ISOLAMENTO');
  }
  if (Number(item.unidade_id) !== Number(rodada.unidade_id)) {
    throw erro(
      'Item e rodada com unidades divergentes.',
      409,
      'ITEM_UNIDADE_INCOMPATIVEL'
    );
  }

  const unidadeId = exigirUnidadeOperacional(unidadeIdAutorizada);
  if (unidadeId !== Number(item.unidade_id)) {
    throw erro(
      'Item não pertence à unidade operacional autorizada.',
      409,
      'UNIDADE_ISOLAMENTO'
    );
  }

  const comanda = await get(db, \`
    SELECT id, empresa_id, atendimento_id, pedido_id
    FROM cozinha_comandas
    WHERE id = ? AND empresa_id = ?
  \`, [item.comanda_id, empresaId]);
  if (!comanda) {
    throw erro('Comanda do item não encontrada.', 409, 'COMANDA_ITEM_INEXISTENTE');
  }
  if (Number(rodada.atendimento_id) !== Number(comanda.atendimento_id)) {
    throw erro(
      'Comanda e rodada com atendimentos divergentes.',
      409,
      'COMANDA_RODADA_INCOMPATIVEL'
    );
  }

  return { comanda, unidadeId };
}
`,
  `/**
 * Garante vínculo item ↔ rodada ↔ unidade ↔ comanda na mesma empresa.
 * Se unidade_id for informado na entrada, deve coincidir com a do item/rodada.
 */
async function validarIntegridadeOperacional(db, item, rodada, {
  empresaId,
  unidadeIdOpcional
}) {
  if (Number(item.rodada_id) !== Number(rodada.id)) {
    throw erro('Item não pertence à rodada informada.', 409, 'ITEM_RODADA_INCOMPATIVEL');
  }
  if (Number(item.empresa_id) !== Number(empresaId)
    || Number(rodada.empresa_id) !== Number(empresaId)) {
    throw erro('Isolamento empresarial violado.', 403, 'EMPRESA_ISOLAMENTO');
  }
  if (Number(item.unidade_id) !== Number(rodada.unidade_id)) {
    throw erro(
      'Item e rodada com unidades divergentes.',
      409,
      'ITEM_UNIDADE_INCOMPATIVEL'
    );
  }

  if (unidadeIdOpcional != null && unidadeIdOpcional !== '') {
    const unidadeId = Number(unidadeIdOpcional);
    if (!Number.isInteger(unidadeId) || unidadeId <= 0) {
      throw erro('unidade_id inválida.', 400, 'UNIDADE_INVALIDA');
    }
    if (unidadeId !== Number(item.unidade_id)) {
      throw erro(
        'Item não pertence à unidade operacional informada.',
        409,
        'UNIDADE_ISOLAMENTO'
      );
    }
  }

  const comanda = await get(db, \`
    SELECT id, empresa_id, atendimento_id, pedido_id
    FROM cozinha_comandas
    WHERE id = ? AND empresa_id = ?
  \`, [item.comanda_id, empresaId]);
  if (!comanda) {
    throw erro('Comanda do item não encontrada.', 409, 'COMANDA_ITEM_INEXISTENTE');
  }
  if (Number(rodada.atendimento_id) !== Number(comanda.atendimento_id)) {
    throw erro(
      'Comanda e rodada com atendimentos divergentes.',
      409,
      'COMANDA_RODADA_INCOMPATIVEL'
    );
  }

  return { comanda };
}
`
);
s = s.replace(
  /unidadeIdAutorizada: entrada\.unidade_id != null \? entrada\.unidade_id : entrada\.unidadeId/g,
  'unidadeIdOpcional: entrada.unidade_id != null ? entrada.unidade_id : entrada.unidadeId'
);
const baseService = path.join(baseDir, 'CozinhaPreparacaoService.js');
fs.writeFileSync(baseService, s);

// --- Routes: old body/query propagation ---
const srcRoutes = path.join(repo, 'backend/rotas/cozinha.js');
let r = fs.readFileSync(srcRoutes, 'utf8');
r = r.replace(
  "const { resolverUnidadeOperacionalReq } = require('../services/cozinha/cozinhaUnidadeOperacional');\n",
  ''
);
r = r.replace(
  `router.post('/itens/:id/iniciar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaPreparacao.iniciarPreparacao({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      // unidade autoritativa = JWT (body/query só podem coincidir)
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});`,
  `router.post('/itens/:id/iniciar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaPreparacao.iniciarPreparacao({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: body.unidade_id != null ? body.unidade_id : req.query.unidade_id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});`
);
r = r.replace(
  `router.post('/itens/:id/pronto', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaPreparacao.marcarItemPronto({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});`,
  `router.post('/itens/:id/pronto', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaPreparacao.marcarItemPronto({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: body.unidade_id != null ? body.unidade_id : req.query.unidade_id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});`
);
r = r.replace(
  `      unidade_id: resolverUnidadeOperacionalReq(req),
      qty_entregue: body.qty_entregue != null ? body.qty_entregue : body.quantidade`,
  `      unidade_id: body.unidade_id != null ? body.unidade_id : req.query.unidade_id,
      qty_entregue: body.qty_entregue != null ? body.qty_entregue : body.quantidade`
);
const baseRoutes = path.join(baseDir, 'cozinha.js');
fs.writeFileSync(baseRoutes, r);

// --- Auth: remove unidade_cozinha_id ---
const srcAuth = path.join(repo, 'backend/rotas/auth.js');
let a = fs.readFileSync(srcAuth, 'utf8');
a = a.replace(
  `    // Cozinha S05: unidade operacional autenticada no JWT (mesmo padrão de terminal/caixa).
    // Uma vez assinada, o cliente não consegue forjar outra unidade sem o segredo.
    const unidadeCozinhaId = parsePositiveInteger(
      req.body?.unidade_cozinha_id != null
        ? req.body.unidade_cozinha_id
        : req.body?.unidadeCozinhaId
    );

`,
  ''
);
a = a.replace(/\n\s*unidade_cozinha_id: unidadeCozinhaId,/g, '');
a = a.replace(/\n\s*unidade_cozinha_id: unidadeCozinhaId\n/g, '\n');
const baseAuth = path.join(baseDir, 'auth.js');
fs.writeFileSync(baseAuth, a);

const emptyHelper = path.join(baseDir, 'cozinhaUnidadeOperacional.js');
fs.writeFileSync(emptyHelper, '');
const srcHelper = path.join(repo, 'backend/services/cozinha/cozinhaUnidadeOperacional.js');

let patch = [
  '# DIFF REAL — Correção de homologação Sprint 05 (isolamento operacional por unidade)',
  '# Baseline: S05 inicial (unidade opcional via body/query)',
  '# Alvo: código atual',
  '',
  ''
].join('\n');

patch += normalize(gitDiff(baseService, srcService), 'backend/services/cozinha/CozinhaPreparacaoService.js', baseService, srcService) + '\n';
patch += normalize(gitDiff(baseRoutes, srcRoutes), 'backend/rotas/cozinha.js', baseRoutes, srcRoutes) + '\n';
patch += normalize(gitDiff(baseAuth, srcAuth), 'backend/rotas/auth.js', baseAuth, srcAuth) + '\n';
patch += normalize(gitDiff(emptyHelper, srcHelper), 'backend/services/cozinha/cozinhaUnidadeOperacional.js', emptyHelper, srcHelper) + '\n';

fs.writeFileSync(outPatch, patch, 'utf8');
console.log('wrote', outPatch, 'bytes', Buffer.byteLength(patch));
console.log('hunks', (patch.match(/^@@/gm) || []).length);
