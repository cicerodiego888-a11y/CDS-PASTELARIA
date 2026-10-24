'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const { cotarPrecoProduto, CotacaoPrecoErro } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const Motor = require('../../backend/services/vendas/MotorPrecoAtacado');
const MotorBrowser = require('../../frontend/shared/js/motor-preco-atacado.js');

const AGORA = new Date('2026-03-15T12:00:00Z');

function run(db, sql, p = []) { return new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); })); }
function all(db, sql, p = []) { return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r)))); }

async function criarBanco() {
    const db = new sqlite3.Database(':memory:');
    await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, unidade TEXT, preco_venda DECIMAL(18,6),
        preco_unidade DECIMAL(18,6), permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
        vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0)`);
    await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original DECIMAL, preco_promocional DECIMAL,
        data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
    await run(db, `CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado DECIMAL(18,6))`);
    await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY)`);
    await run(db, `CREATE TABLE movimentacoes_estoque (id INTEGER PRIMARY KEY)`);
    await run(db, `CREATE TABLE contas_receber (id INTEGER PRIMARY KEY)`);
    await run(db, `CREATE TABLE ficha_tecnica_consumo (id INTEGER PRIMARY KEY)`);
    return db;
}

async function produto(db, v) {
    await run(db, `INSERT INTO produtos (id, nome, unidade, preco_venda, preco_unidade, permite_venda_unidade, produto_fracionado, venda_atacado)
        VALUES (?,?,?,?,?,?,?,?)`,
    [v.id, 'P' + v.id, v.unidade || 'un', v.preco_venda, v.preco_unidade ?? null, v.permite_venda_unidade ?? 0, v.produto_fracionado ?? 0, v.venda_atacado ?? 0]);
}

describe('Sprint 2.3 — cotação backend', () => {
    let db;
    beforeEach(async () => { db = await criarBanco(); });
    afterEach(() => new Promise((r) => db.close(r)));

    const cotar = (extra) => cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: 1, agora: AGORA, ...extra });

    it('núcleo numérico único: backend e browser são o mesmo objeto', () => {
        assert.equal(Motor, MotorBrowser);
        assert.equal(Motor.CASAS_INTERNAS, 6);
        assert.equal(typeof Motor.NUCLEO_VERSAO, 'string');
        const src = fs.readFileSync(path.join(__dirname, '../../backend/services/vendas/MotorPrecoAtacado.js'), 'utf8');
        assert.ok(!/function arredondarInterno/.test(src));
    });

    it('preço-base regular', async () => {
        await produto(db, { id: 1, preco_venda: 10.5 });
        const c = await cotar({ quantidade: 3 });
        assert.equal(c.precoBase.fonte, 'produtos.preco_venda');
        assert.equal(c.precoUnitarioInterno, 10.5);
        assert.equal(c.subtotalCentavos, 3150);
        assert.deepEqual(c.regrasAplicadas.map((r) => r.tipo), ['PRECO_REGULAR']);
        assert.equal(c.efeitosOperacionais, false);
    });

    it('preço por unidade (exige conversão + permite_venda_unidade; sem promoção/atacado)', async () => {
        await produto(db, { id: 1, unidade: 'kg', preco_venda: 40, preco_unidade: 7.5, permite_venda_unidade: 1, produto_fracionado: 1, venda_atacado: 1 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,40,1,'2026-01-01','2026-12-31','ativa')`);
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,1,1)`);
        const c = await cotar({ tipoVenda: 'UNIDADE', quantidade: 2.6 });
        assert.equal(c.quantidade, 3);
        assert.equal(c.precoBase.fonte, 'produtos.preco_unidade');
        assert.equal(c.subtotalCentavos, 2250);
        assert.deepEqual(c.regrasAplicadas.map((r) => r.tipo), ['PRECO_UNIDADE']);
        await run(db, `UPDATE produtos SET permite_venda_unidade = 0`);
        await assert.rejects(cotar({ tipoVenda: 'UNIDADE' }), (e) => e.codigo === 'VENDA_UNIDADE_NAO_PERMITIDA');
    });

    it('etiqueta de balança: 3 casas, sem promoção/atacado', async () => {
        await produto(db, { id: 1, unidade: 'kg', preco_venda: 50, produto_fracionado: 1, venda_atacado: 1 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,50,10,'2026-01-01','2026-12-31','ativa')`);
        const c = await cotar({ tipoVenda: 'ETIQUETA_BALANCA', quantidade: 0.4567 });
        assert.equal(c.quantidade, 0.457);
        assert.equal(c.precoUnitarioInterno, 50);
        assert.equal(c.subtotalCentavos, 2285);
    });

    it('promoção ativa, inativa e expirada (data_fim exclusiva, como promocao-ativa)', async () => {
        await produto(db, { id: 1, preco_venda: 10 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,10,8,'2026-03-01','2026-03-16','ativa')`);
        let c = await cotar({ quantidade: 2 });
        assert.equal(c.precoUnitarioInterno, 8);
        assert.equal(c.regrasAplicadas[1].id, 1);
        assert.equal(c.subtotalCentavos, 1600);

        await run(db, `UPDATE promocoes SET status='encerrada'`);
        c = await cotar({ quantidade: 2 });
        assert.equal(c.precoUnitarioInterno, 10);

        await run(db, `UPDATE promocoes SET status='ativa', data_fim='2026-03-15'`);
        c = await cotar({ quantidade: 2 });
        assert.equal(c.precoUnitarioInterno, 10, 'data_fim == hoje é expirada');

        await run(db, `UPDATE promocoes SET data_fim='2026-04-01', data_inicio='2026-03-16'`);
        c = await cotar({ quantidade: 2 });
        assert.equal(c.precoUnitarioInterno, 10, 'ainda não iniciada');
    });

    it('promoção com preço 0 recai no preço base (igual ao PDV)', async () => {
        await produto(db, { id: 1, preco_venda: 10 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,10,0,'2026-03-01','2026-04-01','ativa')`);
        assert.equal((await cotar()).precoUnitarioInterno, 10);
    });

    it('atacado: abaixo, no limiar e acima; recalcula subtotal com a quantidade', async () => {
        await produto(db, { id: 1, preco_venda: 10, venda_atacado: 1 });
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,5,9),(2,1,10,8.333333)`);
        let c = await cotar({ quantidade: 4 });
        assert.equal(c.precoUnitarioInterno, 10);
        assert.equal(c.subtotalCentavos, 4000);
        c = await cotar({ quantidade: 5 });
        assert.equal(c.precoUnitarioInterno, 9);
        assert.equal(c.regrasAplicadas.at(-1).tipo, 'ATACADO');
        assert.equal(c.subtotalCentavos, 4500);
        c = await cotar({ quantidade: 9 });
        assert.equal(c.regrasAplicadas.at(-1).id, 1);
        c = await cotar({ quantidade: 10 });
        assert.equal(c.regrasAplicadas.at(-1).id, 2);
        assert.equal(c.precoUnitarioInterno, 8.333333);
        assert.equal(c.precoUnitarioExibicao, 8.33);
        assert.equal(c.subtotalInterno, 83.33333);
        assert.equal(c.subtotalCentavos, 8333);
        c = await cotar({ quantidade: 30 });
        assert.equal(c.subtotalInterno, 249.99999);
        assert.equal(c.subtotalCentavos, 25000, 'total arredondado sobre o interno, não 30*8.33');
    });

    it('atacado ignorado se venda_atacado=0, preço <=0 ou >= base', async () => {
        await produto(db, { id: 1, preco_venda: 10, venda_atacado: 0 });
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,1,5)`);
        assert.equal((await cotar()).precoUnitarioInterno, 10);
        await run(db, `UPDATE produtos SET venda_atacado=1`);
        assert.equal((await cotar()).precoUnitarioInterno, 5);
        await run(db, `UPDATE produto_atacado SET preco_atacado=0`);
        assert.equal((await cotar()).precoUnitarioInterno, 10);
        await run(db, `UPDATE produto_atacado SET preco_atacado=12`);
        assert.equal((await cotar()).precoUnitarioInterno, 10);
    });

    it('promoção combinada com atacado: vence o menor preço', async () => {
        await produto(db, { id: 1, preco_venda: 10, venda_atacado: 1 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,10,8,'2026-03-01','2026-04-01','ativa')`);
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,5,9),(2,1,10,7)`);
        let c = await cotar({ quantidade: 5 });
        assert.equal(c.precoUnitarioInterno, 8);
        assert.deepEqual(c.regrasAplicadas.map((r) => r.tipo), ['PRECO_REGULAR', 'PROMOCAO']);
        c = await cotar({ quantidade: 10 });
        assert.equal(c.precoUnitarioInterno, 7);
        assert.deepEqual(c.regrasAplicadas.map((r) => r.tipo), ['PRECO_REGULAR', 'PROMOCAO', 'ATACADO']);
        assert.equal(c.subtotalCentavos, 7000);
    });

    it('preço interno vs exibição e subtotal', async () => {
        await produto(db, { id: 1, preco_venda: 3.333333 });
        const c = await cotar({ quantidade: 3 });
        assert.equal(c.precoUnitarioInterno, 3.333333);
        assert.equal(c.precoUnitarioExibicao, 3.33);
        assert.equal(c.subtotalInterno, 9.999999);
        assert.equal(c.subtotalCentavos, 1000);
        assert.equal(c.subtotalCentavos === Math.round(c.precoUnitarioExibicao * 3 * 100), false);
    });

    it('quantidade fracionada/inteira conforme produto', async () => {
        await produto(db, { id: 1, unidade: 'kg', preco_venda: 10, produto_fracionado: 1 });
        await produto(db, { id: 2, preco_venda: 10 });
        assert.equal((await cotar({ quantidade: 1.234 })).quantidade, 1.23);
        assert.equal((await cotar({ produtoId: 2, quantidade: 1.6 })).quantidade, 2);
        await assert.rejects(cotar({ quantidade: 0 }), (e) => e.codigo === 'QUANTIDADE_INVALIDA');
    });

    it('fingerprint muda com dependências e é estável sem mudança', async () => {
        await produto(db, { id: 1, preco_venda: 10, venda_atacado: 1 });
        await run(db, `INSERT INTO promocoes VALUES (1,1,10,9,'2026-03-01','2026-04-01','ativa')`);
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,5,8)`);
        const base = (await cotar({ quantidade: 5 })).fingerprint;
        assert.equal((await cotar({ quantidade: 5, agora: new Date('2026-03-15T20:00:00Z') })).fingerprint, base, 'horário não entra');
        assert.notEqual((await cotar({ quantidade: 6 })).fingerprint, base);
        await run(db, `UPDATE produto_atacado SET preco_atacado=7.5`);
        const f2 = (await cotar({ quantidade: 5 })).fingerprint;
        assert.notEqual(f2, base);
        await run(db, `UPDATE promocoes SET preco_promocional=9.5`);
        const f3 = (await cotar({ quantidade: 5 })).fingerprint;
        assert.notEqual(f3, f2);
        await run(db, `UPDATE produto_atacado SET quantidade_minima=4`);
        const f4 = (await cotar({ quantidade: 5 })).fingerprint;
        assert.notEqual(f4, f3);
        await run(db, `UPDATE produtos SET preco_venda=11`);
        assert.notEqual((await cotar({ quantidade: 5 })).fingerprint, f4);
        await run(db, `UPDATE promocoes SET status='encerrada'`);
        assert.notEqual((await cotar({ quantidade: 5 })).fingerprint, f4);
    });

    it('fingerprint muda com preco_unidade e config de venda por unidade', async () => {
        await produto(db, { id: 1, unidade: 'kg', preco_venda: 40, preco_unidade: 7, permite_venda_unidade: 1, produto_fracionado: 1 });
        const a = (await cotar({ tipoVenda: 'UNIDADE', quantidade: 2 })).fingerprint;
        await run(db, `UPDATE produtos SET preco_unidade=7.1`);
        assert.notEqual((await cotar({ tipoVenda: 'UNIDADE', quantidade: 2 })).fingerprint, a);
    });

    it('empresa explícita obrigatória; preços globais iguais entre empresas', async () => {
        await produto(db, { id: 1, preco_venda: 10 });
        await assert.rejects(cotarPrecoProduto({ db, produtoId: 1, quantidade: 1 }), (e) => e.codigo === 'EMPRESA_OBRIGATORIA');
        const a = await cotar({ empresaId: 1 });
        const b = await cotar({ empresaId: 2 });
        assert.equal(a.empresaId, 1);
        assert.equal(b.empresaId, 2);
        assert.equal(a.fingerprint, b.fingerprint);
        assert.equal(a.subtotalCentavos, b.subtotalCentavos);
        assert.deepEqual((await all(db, 'PRAGMA table_info(produtos)')).filter((c) => /empresa/.test(c.name)), []);
    });

    it('valores informados não são autoritativos; apenas comparados', async () => {
        await produto(db, { id: 1, preco_venda: 10 });
        const c = await cotar({ quantidade: 2, valoresInformados: { precoUnitario: 1, subtotal: 2 } });
        assert.equal(c.subtotalCentavos, 2000);
        assert.deepEqual(c.validacaoInformados, { confere: false, divergencias: ['precoUnitario', 'subtotal'] });
        const ok = await cotar({ quantidade: 2, valoresInformados: { precoUnitario: 10, subtotal: 20 } });
        assert.equal(ok.validacaoInformados.confere, true);
    });

    it('erros estruturados: conexão, produto, schema', async () => {
        await assert.rejects(cotarPrecoProduto({ empresaId: 1, produtoId: 1, quantidade: 1 }), (e) => e.codigo === 'CONEXAO_OBRIGATORIA');
        await assert.rejects(cotar({ produtoId: 99 }), (e) => e instanceof CotacaoPrecoErro && e.codigo === 'PRODUTO_INEXISTENTE');
        await assert.rejects(cotar({ tipoVenda: 'X' }), (e) => e.codigo === 'TIPO_VENDA_INVALIDO');
        await produto(db, { id: 3, preco_venda: 0 });
        await assert.rejects(cotar({ produtoId: 3 }), (e) => e.codigo === 'PRECO_BASE_INVALIDO');
        await run(db, 'DROP TABLE produto_atacado');
        await assert.rejects(cotar({ produtoId: 3 }), (e) => e.codigo === 'SCHEMA_INCOMPATIVEL');
    });

    it('somente leitura: sem DDL/DML, schema e tabelas operacionais inalterados', async () => {
        await produto(db, { id: 1, preco_venda: 10, venda_atacado: 1 });
        await run(db, `INSERT INTO produto_atacado VALUES (1,1,1,9)`);
        const snap = async () => JSON.stringify({
            schema: await all(db, 'SELECT type,name,sql FROM sqlite_master ORDER BY name'),
            dados: await all(db, 'SELECT * FROM produtos'),
            op: [await all(db, 'SELECT * FROM vendas'), await all(db, 'SELECT * FROM movimentacoes_estoque'),
                await all(db, 'SELECT * FROM contas_receber'), await all(db, 'SELECT * FROM ficha_tecnica_consumo')]
        });
        const antes = await snap();
        const sqls = [];
        const proxy = {
            get: (s, p, cb) => { sqls.push(s); return db.get(s, p, cb); },
            all: (s, p, cb) => { sqls.push(s); return db.all(s, p, cb); },
            run: () => { throw new Error('run não deve ser usado'); },
            exec: () => { throw new Error('exec não deve ser usado'); }
        };
        await cotarPrecoProduto({ db: proxy, empresaId: 1, produtoId: 1, quantidade: 2, agora: AGORA });
        assert.ok(sqls.length > 0);
        for (const s of sqls) assert.match(s.trim(), /^(SELECT|PRAGMA table_info)/i);
        assert.equal(await snap(), antes);
    });

    it('serviço não importa o banco padrão nem executa DDL (inspeção de fonte)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../backend/services/vendas/CotacaoPrecoProdutoService.js'), 'utf8');
        assert.ok(!/require\(['"][^'"]*database['"]\)/.test(src));
        assert.ok(!/\b(CREATE|ALTER|DROP)\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i.test(src));
    });
});
