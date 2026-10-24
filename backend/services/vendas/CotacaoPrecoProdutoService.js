/**
 * Sprint 2.3 — Cotação de preço autoritativa no backend (somente leitura).
 *
 * Reproduz as regras de formação de preço do carrinho do PDV (frontend/pdv/js/pdv.js)
 * usando o mesmo núcleo numérico (frontend/shared/js/motor-preco-atacado.js).
 * Preços globais: `empresaId` é obrigatório para identificar o contexto, mas não altera o preço.
 *
 * Não reserva saldo, não bloqueia concorrência e não garante validade futura.
 * Usa exclusivamente a conexão injetada; não importa o banco padrão e não executa DDL.
 */
'use strict';

const crypto = require('crypto');
const Motor = require('./MotorPrecoAtacado');

const TIPO_VENDA = Object.freeze({ PESO: 'PESO', UNIDADE: 'UNIDADE', ETIQUETA_BALANCA: 'ETIQUETA_BALANCA' });
const VERSAO_COTACAO = 'cotacao-preco-produto/1';
const REGRA_ARREDONDAMENTO = Object.freeze({
    nucleo: Motor.NUCLEO_VERSAO,
    casasInternas: Motor.CASAS_INTERNAS,
    casasExibicao: 2,
    quantidadeCasasMotor: 3,
    metodo: 'Math.round(n*10^c)/10^c; subtotal = round6(precoInterno*qtd); total = round2(subtotal)'
});

const COLUNAS_PRODUTO = ['id', 'preco_venda', 'preco_unidade', 'permite_venda_unidade',
    'produto_fracionado', 'vendido_por_peso', 'unidade', 'venda_atacado'];

class CotacaoPrecoErro extends Error {
    constructor(codigo, mensagem) {
        super(mensagem || codigo);
        this.name = 'CotacaoPrecoErro';
        this.codigo = codigo;
    }
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}

async function colunasDe(db, tabela) {
    const rows = await dbAll(db, `PRAGMA table_info(${tabela})`);
    return new Set(rows.map((r) => r.name));
}

async function validarSchema(db) {
    const prod = await colunasDe(db, 'produtos');
    const faltando = COLUNAS_PRODUTO.filter((c) => !prod.has(c));
    if (faltando.length) {
        throw new CotacaoPrecoErro('SCHEMA_INCOMPATIVEL', `produtos sem colunas: ${faltando.join(', ')}`);
    }
    const promo = await colunasDe(db, 'promocoes');
    const atac = await colunasDe(db, 'produto_atacado');
    const pOk = ['id', 'produto_id', 'preco_promocional', 'data_inicio', 'data_fim', 'status'].every((c) => promo.has(c));
    const aOk = ['id', 'produto_id', 'quantidade_minima', 'preco_atacado'].every((c) => atac.has(c));
    if (!pOk || !aOk) throw new CotacaoPrecoErro('SCHEMA_INCOMPATIVEL', 'promocoes/produto_atacado incompatíveis');
    return true;
}

function usaConversao(produto) {
    return Number(produto.produto_fracionado ?? produto.vendido_por_peso ?? 0) === 1;
}

function usaDecimais(produto) {
    return usaConversao(produto) || String(produto.unidade || '').toLowerCase() === 'kg';
}

function normalizarTipoVenda(tipo) {
    const t = String(tipo || TIPO_VENDA.PESO).trim().toUpperCase();
    if (!TIPO_VENDA[t]) throw new CotacaoPrecoErro('TIPO_VENDA_INVALIDO', `tipoVenda inválido: ${tipo}`);
    return t;
}

function normalizarQuantidade(qtdBruta, produto, tipoVenda) {
    const qtd = Number(qtdBruta);
    if (!Number.isFinite(qtd) || qtd <= 0) throw new CotacaoPrecoErro('QUANTIDADE_INVALIDA', 'quantidade deve ser > 0');
    let q;
    if (tipoVenda === TIPO_VENDA.UNIDADE) q = Math.round(qtd);
    else if (tipoVenda === TIPO_VENDA.ETIQUETA_BALANCA) q = Number(qtd.toFixed(3));
    else q = usaDecimais(produto) ? Number(qtd.toFixed(2)) : Math.round(qtd);
    if (q <= 0) throw new CotacaoPrecoErro('QUANTIDADE_INVALIDA', 'quantidade normalizada <= 0');
    return q;
}

function dataReferenciaIso(agora) {
    const d = agora instanceof Date ? agora : new Date(agora);
    if (Number.isNaN(d.getTime())) throw new CotacaoPrecoErro('DATA_REFERENCIA_INVALIDA', 'agora inválido');
    return d;
}

/**
 * Mesma condição de GET /produtos/:id/promocao-ativa, com data de referência explícita (UTC, como date('now')).
 * data_fim é exclusiva (divergente do QueryOptimizer, onde é inclusiva).
 */
function buscarPromocaoAtiva(db, produtoId, dataIso) {
    return dbGet(db,
        `SELECT id, produto_id, preco_original, preco_promocional, data_inicio, data_fim, status
           FROM promocoes
          WHERE produto_id = ? AND status = 'ativa'
            AND date(data_inicio) <= date(?) AND date(data_fim) > date(?)
          ORDER BY id ASC LIMIT 1`,
        [produtoId, dataIso, dataIso]);
}

function buscarFaixasAtacado(db, produtoId) {
    return dbAll(db,
        `SELECT id, quantidade_minima, preco_atacado FROM produto_atacado
          WHERE produto_id = ? ORDER BY quantidade_minima ASC, id ASC`,
        [produtoId]);
}

function hash(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Lê (uma única vez) as dependências persistidas da cotação. Independe da quantidade, exceto
 * a escolha da faixa de atacado, feita em cotarComDependencias.
 */
async function carregarDependenciasCotacao(opts = {}) {
    const { db, empresaId, produtoId } = opts;
    if (!db || typeof db.get !== 'function' || typeof db.all !== 'function') {
        throw new CotacaoPrecoErro('CONEXAO_OBRIGATORIA', 'db explícito é obrigatório');
    }
    if (!Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
        throw new CotacaoPrecoErro('EMPRESA_OBRIGATORIA', 'empresaId explícito é obrigatório');
    }
    if (!Number.isInteger(Number(produtoId)) || Number(produtoId) <= 0) {
        throw new CotacaoPrecoErro('PRODUTO_INVALIDO', 'produtoId inválido');
    }
    const tipoVenda = normalizarTipoVenda(opts.tipoVenda);
    const agora = dataReferenciaIso(opts.agora ?? new Date());
    const dataIso = agora.toISOString().slice(0, 10);

    await validarSchema(db);
    const produto = await dbGet(db, 'SELECT * FROM produtos WHERE id = ?', [Number(produtoId)]);
    if (!produto) throw new CotacaoPrecoErro('PRODUTO_INEXISTENTE', `produto ${produtoId} não encontrado`);

    const precoVenda = Number(produto.preco_venda || 0);
    const regras = [];
    let precoBaseFonte;
    let precoBase;
    let promocao = null;
    let faixas = [];

    if (tipoVenda === TIPO_VENDA.UNIDADE) {
        if (!(usaConversao(produto) && Number(produto.permite_venda_unidade ?? 0) === 1)) {
            throw new CotacaoPrecoErro('VENDA_UNIDADE_NAO_PERMITIDA', 'produto não permite venda por unidade');
        }
        precoBaseFonte = 'produtos.preco_unidade';
        precoBase = Number(produto.preco_unidade || 0);
        regras.push({ tipo: 'PRECO_UNIDADE' });
    } else {
        precoBaseFonte = 'produtos.preco_venda';
        precoBase = precoVenda;
        regras.push({ tipo: 'PRECO_REGULAR' });
    }
    if (!(precoBase > 0)) throw new CotacaoPrecoErro('PRECO_BASE_INVALIDO', `${precoBaseFonte} deve ser > 0`);

    if (tipoVenda === TIPO_VENDA.PESO) {
        promocao = await buscarPromocaoAtiva(db, Number(produtoId), dataIso);
        if (Number(produto.venda_atacado || 0) === 1) {
            faixas = await buscarFaixasAtacado(db, Number(produtoId));
        }
    }
    return {
        empresaId: Number(empresaId),
        produtoId: Number(produtoId),
        produto,
        tipoVenda,
        agora,
        dataIso,
        precoVenda,
        precoBase,
        precoBaseFonte,
        regrasBase: regras,
        promocao,
        faixas
    };
}

/** Menor preço unitário interno que qualquer quantidade pode alcançar (limite inferior seguro). */
function precoUnitarioMinimoPossivel(deps) {
    let minimo = Motor.arredondarInterno(deps.precoBase);
    if (deps.promocao) {
        const pp = Number(deps.promocao.preco_promocional || 0);
        if (pp > 0) minimo = Math.min(minimo, Motor.arredondarInterno(pp));
    }
    for (const f of deps.faixas) {
        const pa = Number(f.preco_atacado);
        if (pa > 0) minimo = Math.min(minimo, Motor.arredondarInterno(pa));
    }
    return minimo;
}

/** Fingerprint das dependências lidas (independe da quantidade). */
function fingerprintDependenciasCotacao(deps) {
    return hash({
        versao: VERSAO_COTACAO,
        regraArredondamento: REGRA_ARREDONDAMENTO,
        produtoId: deps.produtoId,
        tipoVenda: deps.tipoVenda,
        precoBase: { fonte: deps.precoBaseFonte, valor: deps.precoBase },
        vendaUnidade: deps.tipoVenda === TIPO_VENDA.UNIDADE
            ? { permite: Number(deps.produto.permite_venda_unidade), fracionado: usaConversao(deps.produto) ? 1 : 0 }
            : null,
        promocao: deps.promocao
            ? { id: deps.promocao.id, preco: Number(deps.promocao.preco_promocional || 0), status: deps.promocao.status, inicio: deps.promocao.data_inicio, fim: deps.promocao.data_fim, referencia: deps.dataIso }
            : null,
        atacado: deps.tipoVenda === TIPO_VENDA.PESO && Number(deps.produto.venda_atacado || 0) === 1
            ? deps.faixas.map((f) => [f.id, Number(f.quantidade_minima), Number(f.preco_atacado)])
            : null
    });
}

/** Cálculo puro (síncrono) sobre dependências já carregadas. */
function cotarComDependencias(deps, quantidade, valoresInformados) {
    const { produto, tipoVenda, precoVenda, precoBase, precoBaseFonte, promocao, faixas, agora, dataIso } = deps;
    const produtoId = deps.produtoId;
    const empresaId = deps.empresaId;
    const qtd = normalizarQuantidade(quantidade, produto, tipoVenda);
    const regras = deps.regrasBase.slice();
    let faixaEscolhida = null;
    let precoFinal = precoBase;
    if (promocao) {
        const pp = Number(promocao.preco_promocional || 0);
        // Igual ao PDV: preço promocional 0/nulo recai no preço base
        precoFinal = pp || precoBase;
        regras.push({ tipo: 'PROMOCAO', id: promocao.id, precoPromocional: pp });
    }
    if (tipoVenda === TIPO_VENDA.PESO && Number(produto.venda_atacado || 0) === 1) {
        for (const f of faixas) {
            if (qtd >= Number(f.quantidade_minima)) faixaEscolhida = f;
        }
        if (faixaEscolhida && Number(faixaEscolhida.preco_atacado) > 0) {
            const calc = Motor.calcularLinhaAtacadoFaixa({
                precoVenda: precoVenda || precoBase,
                precoAtacado: Number(faixaEscolhida.preco_atacado),
                quantidade: qtd
            });
            const menor = Math.min(precoFinal, calc.precoUnitarioInterno);
            if (menor < precoFinal) {
                precoFinal = menor;
                regras.push({ tipo: 'ATACADO', id: faixaEscolhida.id, quantidadeMinima: Number(faixaEscolhida.quantidade_minima), precoAtacado: Number(faixaEscolhida.preco_atacado) });
            }
        }
    }

    const linha = Motor.calcularLinhaPrecoUnitarioInformado({
        precoOriginal: precoBase,
        quantidade: qtd,
        precoUnitarioInformado: precoFinal
    });

    const dependencias = {
        dependencias: deps.fingerprintDependencias || (deps.fingerprintDependencias = fingerprintDependenciasCotacao(deps)),
        quantidade: qtd,
        faixaEscolhida: faixaEscolhida ? faixaEscolhida.id : null,
        precoUnitarioInterno: linha.precoUnitarioInterno,
        subtotalInterno: linha.totalInterno,
        subtotalCentavos: Math.round(linha.total * 100)
    };

    const cotacao = {
        versao: VERSAO_COTACAO,
        empresaId: Number(empresaId),
        produtoId: Number(produtoId),
        quantidade: qtd,
        tipoVenda,
        precoBase: { fonte: precoBaseFonte, valor: precoBase },
        regrasAplicadas: regras,
        precoUnitarioInterno: linha.precoUnitarioInterno,
        precoUnitarioExibicao: linha.precoUnitarioExibicao,
        subtotalInterno: linha.totalInterno,
        subtotalCentavos: dependencias.subtotalCentavos,
        regraArredondamento: REGRA_ARREDONDAMENTO,
        cotadoEm: agora.toISOString(),
        fingerprint: hash(dependencias),
        efeitosOperacionais: false,
        reservaSaldo: false
    };

    if (valoresInformados && typeof valoresInformados === 'object') {
        const divergencias = [];
        if (valoresInformados.precoUnitario != null
            && Motor.arredondarMoeda(valoresInformados.precoUnitario) !== cotacao.precoUnitarioExibicao) {
            divergencias.push('precoUnitario');
        }
        if (valoresInformados.subtotal != null
            && Math.round(Number(valoresInformados.subtotal) * 100) !== cotacao.subtotalCentavos) {
            divergencias.push('subtotal');
        }
        cotacao.validacaoInformados = { confere: divergencias.length === 0, divergencias };
    }
    return cotacao;
}

/**
 * @param {{db:object, empresaId:number, produtoId:number, quantidade:number, tipoVenda?:string,
 *          agora?:Date|string|number, valoresInformados?:{precoUnitario?:number, subtotal?:number}}} opts
 */
async function cotarPrecoProduto(opts = {}) {
    const deps = await carregarDependenciasCotacao(opts);
    return cotarComDependencias(deps, opts.quantidade, opts.valoresInformados);
}

/**
 * Cotador reutilizável para uma simulação: lê as dependências uma vez e cota qualquer quantidade
 * de forma síncrona, com cache local por quantidade. O cotador não deve sobreviver à simulação.
 */
async function criarCotadorPreco(opts = {}) {
    const deps = await carregarDependenciasCotacao(opts);
    const cache = new Map();
    const dependenciasFingerprint = fingerprintDependenciasCotacao(deps);
    deps.fingerprintDependencias = dependenciasFingerprint;
    return {
        produtoId: deps.produtoId,
        tipoVenda: deps.tipoVenda,
        dataReferencia: deps.agora.toISOString(),
        dependenciasFingerprint,
        precoUnitarioMinimoInterno: precoUnitarioMinimoPossivel(deps),
        cotar(quantidade) {
            const chave = Number(quantidade);
            if (!cache.has(chave)) cache.set(chave, cotarComDependencias(deps, chave));
            return cache.get(chave);
        },
        get consultasCotacao() { return cache.size; }
    };
}

module.exports = { cotarPrecoProduto, criarCotadorPreco, CotacaoPrecoErro, TIPO_VENDA, VERSAO_COTACAO, REGRA_ARREDONDAMENTO };
