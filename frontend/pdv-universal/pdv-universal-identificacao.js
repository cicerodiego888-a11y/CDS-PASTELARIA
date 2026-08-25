/**
 * Adaptador oficial de identificação do PDV Universal (Sprint 05.21 + etiqueta A.1).
 * Consome POST /produtos/identificar + GET consulta-pdv/buscar
 * + POST /equipamentos/etiquetas/interpretar (Motor Equipamentos — sem parser local).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalIdentificacao = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TIPOS = Object.freeze({
        VAZIO: 'VAZIO',
        UNICO: 'UNICO',
        MULTIPLOS: 'MULTIPLOS',
        NAO_ENCONTRADO: 'NAO_ENCONTRADO',
        ERRO: 'ERRO'
    });

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlIdentificar() {
        return `${baseApi()}/produtos/identificar`;
    }

    function urlConsultaPdv(termo) {
        return `${baseApi()}/produtos/consulta-pdv/buscar?q=${encodeURIComponent(termo)}`;
    }

    function urlInterpretarEtiqueta() {
        return `${baseApi()}/equipamentos/etiquetas/interpretar`;
    }

    /** EAN-13 prefixo 2 — mesma regra do LayoutEtiquetaService. */
    function codigoEhEtiquetaBalanca(codigo) {
        const limpo = digitos(codigo);
        return /^2\d{12}$/.test(limpo);
    }

    function arredQtd3(n) {
        return Math.round(Number(n) * 1000) / 1000;
    }

    function headersAuth(extra) {
        const headers = Object.assign({ Accept: 'application/json' }, extra || {});
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
            const emp = typeof localStorage !== 'undefined' ? localStorage.getItem('cds_empresa_id') : '';
            if (emp) headers['X-Empresa-Id'] = emp;
        } catch (_e) { /* ignore */ }
        return headers;
    }

    function digitos(v) {
        return String(v == null ? '' : v).replace(/\D/g, '');
    }

    function idsNumericosIguais(a, b) {
        const da = digitos(a);
        const db = digitos(b);
        if (!da || !db) return false;
        return da === db || Number(da) === Number(db);
    }

    function produtoCorrespondeAoTermo(produto, termo) {
        const t = String(termo || '').trim();
        if (!produto || !t) return false;
        if (idsNumericosIguais(produto.codigo, t)) return true;
        if (idsNumericosIguais(produto.codigo_barras, t)) return true;
        if (idsNumericosIguais(produto.plu, t)) return true;
        if (idsNumericosIguais(produto.id, t)) return true;
        return false;
    }

    function normalizarProdutoMip(mip, termo) {
        if (!mip || !mip.encontrado) return null;
        const id = mip.produtoId != null
            ? Number(mip.produtoId)
            : (mip.produto && mip.produto.id != null ? Number(mip.produto.id) : null);
        if (!Number.isInteger(id) || id <= 0) return null;
        const base = mip.produto && typeof mip.produto === 'object' ? mip.produto : {};
        const produto = Object.assign({}, base, {
            id,
            nome: base.nome || base.descricao || ('Produto #' + id),
            preco_venda: base.preco_venda != null ? base.preco_venda : base.preco,
            match_exato: 1,
            _fonte: 'identificar',
            _termoOrigem: termo,
            _strategy: mip.strategy || null,
            _metodo: mip.metodo || null
        });
        if (mip.meta && mip.meta.plu != null) {
            produto.plu = String(mip.meta.plu);
        }
        return produto;
    }

    function produtoEhFracionado(produto) {
        if (!produto || typeof produto !== 'object') return false;
        return Number(
            produto.produto_fracionado ?? produto.produto_pesavel ?? produto.vendido_por_peso ?? 0
        ) === 1;
    }

    /**
     * meta.peso do MIP — numérico ou string com vírgula/ponto (até 3 casas via arredQtd3).
     */
    function parseMetaPeso(valor) {
        if (valor == null || valor === '') return null;
        const s = String(valor).trim().replace(',', '.');
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) return null;
        return arredQtd3(n);
    }

    /**
     * Prioridade: etiqueta resolvida → meta.peso (produto fracionado) → 1.
     */
    function resolverQuantidadeOperacional(opcoes) {
        const o = opcoes || {};
        const etiqueta = o.quantidadeEtiqueta;
        if (etiqueta && etiqueta.ok === true && Number(etiqueta.quantidade) > 0) {
            return {
                quantidade: etiqueta.quantidade,
                origem: etiqueta.origem || 'ETIQUETA'
            };
        }
        const mip = o.mip;
        const produto = o.produto;
        const meta = mip && mip.meta;
        const peso = parseMetaPeso(meta && meta.peso);
        if (peso != null && produtoEhFracionado(produto)) {
            return { quantidade: peso, origem: 'META_PESO' };
        }
        return { quantidade: 1, origem: 'PADRAO' };
    }

    /**
     * Quantidade padrão quando não há etiqueta interpretada (MIP comum).
     * @deprecated preferir resolverQuantidadeOperacional
     */
    function quantidadeOperacionalPadrao(mip, produto) {
        return resolverQuantidadeOperacional({ mip, produto }).quantidade;
    }

    /**
     * PLU extraído do retorno oficial POST /equipamentos/etiquetas/interpretar.
     */
    function extrairPluDeEtiqueta(interpretacao) {
        const res = interpretacao && interpretacao.resultado;
        if (!res) return null;
        const raw = res.pluRaw != null && String(res.pluRaw).trim() !== ''
            ? String(res.pluRaw).trim()
            : (res.plu != null ? String(res.plu) : '');
        return raw || null;
    }

    /**
     * Quantidade operacional a partir do resultado oficial da etiqueta.
     * Usa campos retornados pelo motor: tipoPayload, peso, valorTotal.
     */
    function quantidadeOperacionalDeEtiqueta(interpretacao, produto) {
        const res = interpretacao && interpretacao.resultado;
        if (!res) {
            return { ok: false, quantidade: 1, mensagem: 'Etiqueta sem resultado interpretado.' };
        }
        const preco = Number(
            produto && (produto.preco_venda != null ? produto.preco_venda : produto.preco)
        );
        const tipo = String(res.tipoPayload || '').toUpperCase();
        const peso = res.peso != null ? Number(res.peso) : null;
        const valorTotal = res.valorTotal != null ? Number(res.valorTotal) : null;

        if (tipo === 'PESO' && peso != null && Number.isFinite(peso) && peso > 0) {
            return { ok: true, quantidade: arredQtd3(peso), origem: 'ETIQUETA_PESO' };
        }

        if (tipo === 'VALOR' || (valorTotal != null && Number.isFinite(valorTotal) && valorTotal > 0)) {
            if (preco > 0 && valorTotal > 0) {
                const q = arredQtd3(valorTotal / preco);
                if (q > 0) {
                    return { ok: true, quantidade: q, origem: 'ETIQUETA_VALOR' };
                }
            }
            if (peso != null && Number.isFinite(peso) && peso > 0) {
                return { ok: true, quantidade: arredQtd3(peso), origem: 'ETIQUETA_PESO_FALLBACK' };
            }
            return {
                ok: false,
                quantidade: 1,
                mensagem: 'Não foi possível calcular quantidade a partir do valor da etiqueta.'
            };
        }

        if (peso != null && Number.isFinite(peso) && peso > 0) {
            return { ok: true, quantidade: arredQtd3(peso), origem: 'ETIQUETA_PESO' };
        }

        return {
            ok: false,
            quantidade: 1,
            mensagem: 'Não foi possível obter peso/valor da etiqueta.'
        };
    }

    async function chamarInterpretarEtiqueta(codigo, contexto, fetchFn) {
        const fn = fetchFn || fetch;
        const limpo = digitos(codigo);
        const body = { codigo: limpo };
        const ctx = contexto || {};
        if (ctx.equipamento_id != null) body.equipamento_id = Number(ctx.equipamento_id);
        else if (ctx.equipamentoId != null) body.equipamento_id = Number(ctx.equipamentoId);
        else if (typeof globalThis !== 'undefined' && globalThis.PDV_BALANCA_EQUIPAMENTO_ID) {
            body.equipamento_id = Number(globalThis.PDV_BALANCA_EQUIPAMENTO_ID);
        }
        const res = await fn(urlInterpretarEtiqueta(), {
            method: 'POST',
            headers: headersAuth({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(payload.error || ('HTTP ' + res.status));
            err.code = payload.code || 'ERRO_ETIQUETA';
            err.status = res.status;
            err.payload = payload;
            throw err;
        }
        return payload.success === true ? payload : Object.assign({ success: true }, payload);
    }

    async function chamarIdentificar(codigo, contexto, fetchFn) {
        const fn = fetchFn || fetch;
        const headers = headersAuth({ 'Content-Type': 'application/json' });
        const body = {
            codigo: String(codigo || '').trim(),
            contexto: Object.assign({ origem: 'pdv-universal' }, contexto || {})
        };
        const res = await fn(urlIdentificar(), {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(payload.error || ('HTTP ' + res.status));
            err.code = payload.code || 'ERRO_IDENTIFICAR';
            err.status = res.status;
            err.payload = payload;
            throw err;
        }
        return payload;
    }

    async function chamarConsultaPdv(termo, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlConsultaPdv(termo), {
            method: 'GET',
            headers: headersAuth()
        });
        if (!res.ok) return [];
        const body = await res.json().catch(() => []);
        return Array.isArray(body) ? body : (body.itens || []);
    }

    /**
     * Entrada operacional → resolução sem duplicar detector do backend.
     * @returns {Promise<{ tipo, produtos, metodo, mip, quantidade, meta, mensagem }>}
     */
    async function identificarEntradaPdv(valor, contexto, deps) {
        const d = deps || {};
        const termo = String(valor || '').trim();
        if (!termo) {
            return {
                tipo: TIPOS.VAZIO,
                produtos: [],
                metodo: null,
                mip: null,
                quantidade: 1,
                meta: null,
                mensagem: ''
            };
        }

        const identificarFn = d.identificar || chamarIdentificar;
        const consultaFn = d.consultar || chamarConsultaPdv;
        const interpretarEtiquetaFn = d.interpretarEtiqueta || chamarInterpretarEtiqueta;
        const fetchFn = d.fetchFn;

        const limpo = digitos(termo);
        if (codigoEhEtiquetaBalanca(limpo)) {
            let etiqueta = null;
            try {
                etiqueta = await interpretarEtiquetaFn(limpo, contexto || {}, fetchFn);
            } catch (err) {
                return {
                    tipo: TIPOS.ERRO,
                    produtos: [],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: null,
                    quantidade: 1,
                    meta: null,
                    mensagem: (err && err.message) || 'Falha ao interpretar etiqueta.'
                };
            }

            if (etiqueta.semLayoutAtivo) {
                return {
                    tipo: TIPOS.ERRO,
                    produtos: [],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: null,
                    quantidade: 1,
                    meta: { etiquetaCodigo: limpo, semLayoutAtivo: true },
                    mensagem: etiqueta.mensagem || 'Nenhuma balança configurada para o PDV.'
                };
            }

            const plu = extrairPluDeEtiqueta(etiqueta);
            const pluOk = plu != null && String(plu).replace(/\D/g, '').length > 0;
            if (!etiqueta.sucesso || !etiqueta.resultado || !pluOk) {
                return {
                    tipo: TIPOS.ERRO,
                    produtos: [],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: null,
                    quantidade: 1,
                    meta: { etiquetaCodigo: limpo },
                    mensagem: etiqueta.mensagem || 'Não foi possível interpretar a etiqueta.'
                };
            }

            let mipEtiqueta = null;
            try {
                mipEtiqueta = await identificarFn(
                    plu,
                    Object.assign({}, contexto || {}, { origem: 'pdv-universal', aposEtiquetaBalanca: true }),
                    fetchFn
                );
            } catch (err) {
                return {
                    tipo: TIPOS.ERRO,
                    produtos: [],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: null,
                    quantidade: 1,
                    meta: { etiquetaCodigo: limpo, plu },
                    mensagem: (err && err.message) || 'Produto da etiqueta não identificado.'
                };
            }

            const produtoEtiqueta = normalizarProdutoMip(mipEtiqueta, plu);
            if (!produtoEtiqueta) {
                return {
                    tipo: TIPOS.NAO_ENCONTRADO,
                    produtos: [],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: mipEtiqueta,
                    quantidade: 1,
                    meta: { etiquetaCodigo: limpo, plu, etiqueta: etiqueta.resultado },
                    mensagem: 'Produto da etiqueta não encontrado.'
                };
            }

            const qtyEtiqueta = quantidadeOperacionalDeEtiqueta(etiqueta, produtoEtiqueta);
            if (!qtyEtiqueta.ok) {
                return {
                    tipo: TIPOS.ERRO,
                    produtos: [produtoEtiqueta],
                    metodo: 'ETIQUETA_BALANCA',
                    mip: mipEtiqueta,
                    quantidade: 1,
                    meta: {
                        etiquetaCodigo: limpo,
                        plu,
                        etiqueta: etiqueta.resultado
                    },
                    mensagem: qtyEtiqueta.mensagem || 'Quantidade da etiqueta inválida.'
                };
            }

            const qtyResolvida = resolverQuantidadeOperacional({
                quantidadeEtiqueta: qtyEtiqueta,
                mip: mipEtiqueta,
                produto: produtoEtiqueta
            });

            return {
                tipo: TIPOS.UNICO,
                produtos: [produtoEtiqueta],
                metodo: 'ETIQUETA_BALANCA',
                mip: mipEtiqueta,
                quantidade: qtyResolvida.quantidade,
                meta: {
                    etiquetaCodigo: limpo,
                    plu,
                    etiqueta: etiqueta.resultado,
                    quantidadeOrigem: qtyResolvida.origem
                },
                mensagem: ''
            };
        }

        let mip = null;
        try {
            mip = await identificarFn(termo, contexto || {}, fetchFn);
        } catch (err) {
            // Identificar falhou: complementar com consulta textual (não derrubar atendimento)
            const listaErro = await consultaFn(termo, fetchFn).catch(() => []);
            if (listaErro.length === 1) {
                return {
                    tipo: TIPOS.UNICO,
                    produtos: listaErro,
                    metodo: 'CONSULTA_PDV',
                    mip: null,
                    quantidade: 1,
                    meta: null,
                    mensagem: ''
                };
            }
            if (listaErro.length > 1) {
                const exatas = listaErro.filter((p) => produtoCorrespondeAoTermo(p, termo));
                if (exatas.length === 1) {
                    return {
                        tipo: TIPOS.UNICO,
                        produtos: exatas,
                        metodo: 'CONSULTA_EXATA',
                        mip: null,
                        quantidade: 1,
                        meta: null,
                        mensagem: ''
                    };
                }
                return {
                    tipo: TIPOS.MULTIPLOS,
                    produtos: listaErro,
                    metodo: 'CONSULTA_PDV',
                    mip: null,
                    quantidade: 1,
                    meta: null,
                    mensagem: 'Vários produtos encontrados. Selecione um.'
                };
            }
            return {
                tipo: TIPOS.ERRO,
                produtos: [],
                metodo: 'IDENTIFICAR',
                mip: null,
                quantidade: 1,
                meta: null,
                mensagem: (err && err.message) || 'Falha na identificação.'
            };
        }

        const produtoMip = normalizarProdutoMip(mip, termo);
        if (produtoMip) {
            const qtyResolvida = resolverQuantidadeOperacional({ mip, produto: produtoMip });
            const metaOut = qtyResolvida.origem !== 'PADRAO'
                ? Object.assign({}, mip.meta && typeof mip.meta === 'object' ? mip.meta : {}, {
                    quantidadeOrigem: qtyResolvida.origem
                })
                : (mip.meta || null);
            return {
                tipo: TIPOS.UNICO,
                produtos: [produtoMip],
                metodo: mip.strategy || mip.metodo || 'IDENTIFICAR',
                mip,
                quantidade: qtyResolvida.quantidade,
                meta: metaOut,
                mensagem: ''
            };
        }

        const lista = await consultaFn(termo, fetchFn);
        if (!lista.length) {
            return {
                tipo: TIPOS.NAO_ENCONTRADO,
                produtos: [],
                metodo: mip && mip.habilitado === false ? 'MIP_OFF_CONSULTA' : 'CONSULTA_PDV',
                mip,
                quantidade: 1,
                meta: null,
                mensagem: 'Produto não encontrado.'
            };
        }

        if (lista.length === 1) {
            return {
                tipo: TIPOS.UNICO,
                produtos: lista,
                metodo: 'CONSULTA_PDV',
                mip,
                quantidade: 1,
                meta: null,
                mensagem: ''
            };
        }

        const exatas = lista.filter((p) => produtoCorrespondeAoTermo(p, termo));
        if (exatas.length === 1) {
            return {
                tipo: TIPOS.UNICO,
                produtos: exatas,
                metodo: 'CONSULTA_EXATA',
                mip,
                quantidade: 1,
                meta: null,
                mensagem: ''
            };
        }

        return {
            tipo: TIPOS.MULTIPLOS,
            produtos: lista,
            metodo: 'CONSULTA_PDV',
            mip,
            quantidade: 1,
            meta: null,
            mensagem: 'Vários produtos encontrados. Selecione um.'
        };
    }

    return {
        TIPOS,
        urlIdentificar,
        urlConsultaPdv,
        urlInterpretarEtiqueta,
        codigoEhEtiquetaBalanca,
        identificarEntradaPdv,
        normalizarProdutoMip,
        produtoCorrespondeAoTermo,
        quantidadeOperacionalPadrao,
        quantidadeOperacionalDeEtiqueta,
        resolverQuantidadeOperacional,
        parseMetaPeso,
        produtoEhFracionado,
        extrairPluDeEtiqueta,
        chamarIdentificar,
        chamarConsultaPdv,
        chamarInterpretarEtiqueta,
        idsNumericosIguais,
        arredQtd3
    };
});
