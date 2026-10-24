/**
 * Apresentações comerciais (ProdutoEmbalagem) — UI do cadastro de produtos
 */
(function (global) {
    'use strict';

    const TIPOS_APRESENTACAO = Object.freeze([
        { value: 'UN', label: 'Unidade (UN)' },
        { value: 'CX', label: 'Caixa (CX)' },
        { value: 'FD', label: 'Fardo (FD)' },
        { value: 'PCT', label: 'Pacote (PCT)' },
        { value: 'KIT', label: 'Kit (KIT)' },
        { value: 'DISPLAY', label: 'Display (DISPLAY)' },
        { value: 'SACO', label: 'Saco (SACO)' },
        { value: 'ROLO', label: 'Rolo (ROLO)' },
        { value: 'BOBINA', label: 'Bobina (BOBINA)' },
        { value: 'BALDE', label: 'Balde (BALDE)' },
        { value: 'GALAO', label: 'Galão (GALAO)' }
    ]);
    const UNIDADES_CONTEUDO = Object.freeze(['UN', 'G', 'KG', 'ML', 'L', 'M', 'CM', 'MM', 'M2', 'M3']);

    function num(valor, casas = 3) {
        const n = parseFloat(String(valor ?? '').replace(',', '.'));
        if (!Number.isFinite(n)) return 0;
        return Number(n.toFixed(casas));
    }

    function normalizarTipo(valor) {
        return String(valor || 'UN').trim().toUpperCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function legadoParaApresentacoes(produto) {
        if (!produto) return [];
        const flag = Number(produto.compra_por_embalagem || 0) === 1;
        const legado = String(produto.unidade_comercial || 'UN').toUpperCase() !== 'UN'
            && Number(produto.quantidade_por_embalagem || 0) > 0;
        if (!flag && !legado) return [];

        const mapa = {
            CAIXA: 'CX', CX: 'CX', FARDO: 'FD', FD: 'FD', PACOTE: 'PCT', PCT: 'PCT',
            SACO: 'SACO', ROLO: 'ROLO', BALDE: 'BALDE', UN: 'UN'
        };
        const uc = String(produto.unidade_comercial || 'PACOTE').toUpperCase();
        const qtd = num(produto.quantidade_por_embalagem, 3) || 1;

        return [{
            tipo: mapa[uc] || 'PCT',
            descricao: '',
            quantidade: qtd,
            unidade: produto.unidade || 'un',
            gtin: produto.codigo_barras || '',
            codigo_fornecedor: '',
            fornecedor_nome: produto.fornecedor || '',
            valor_compra: num(produto.valor_compra_embalagem, 2),
            preco_venda: num((Number(produto.preco_venda || 0) * qtd), 2),
            principal: 1,
            compra: 1,
            venda: 1,
            estoque: 1,
            ativa: 1
        }];
    }

    function inicializarLista(produto) {
        if (produto && Array.isArray(produto.embalagens) && produto.embalagens.length) {
            return produto.embalagens.map((e) => ({ ...e }));
        }
        return legadoParaApresentacoes(produto);
    }

    function montarOptionsTipo(selecionado) {
        const atual = normalizarTipo(selecionado);
        return TIPOS_APRESENTACAO.map((t) =>
            `<option value="${t.value}" ${atual === t.value ? 'selected' : ''}>${t.label}</option>`
        ).join('');
    }

    function escaparHtml(valor) {
        return String(valor ?? '').replace(/[&<>"']/g, (caractere) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[caractere]));
    }

    function montarOptionsUnidadeConteudo(selecionada) {
        const raw = String(selecionada ?? '').trim();
        const atual = raw
            ? (normalizarUnidadeRelacao(raw) || raw.toUpperCase())
            : '';
        const unidades = [...UNIDADES_CONTEUDO];
        if (atual && !unidades.includes(atual)) unidades.push(atual);
        return [
            '<option value="">Selecione...</option>',
            ...unidades.map((unidade) => {
                const segura = escaparHtml(unidade);
                return `<option value="${segura}" ${atual === unidade ? 'selected' : ''}>${segura}</option>`;
            })
        ].join('');
    }

    function unidadePadraoNovaApresentacao() {
        if (utilizaConversaoAtiva()) return '';
        return String($('#unidade').val() || 'un').trim().toLowerCase();
    }

    function montarLinhaApresentacao(emb, index) {
        const tipo = normalizarTipo(emb.tipo);
        const qtdReadonly = tipo === 'UN' ? 'readonly' : '';
        const unidadeInformada = String(emb.unidade ?? '').trim();
        const unidadeConteudo = unidadeInformada
            || (utilizaConversaoAtiva() ? '' : String($('#unidade').val() || 'UN').trim());
        return `
            <tr data-apresentacao-index="${index}">
                <td>
                    <select class="form-control form-control-sm ap-tipo">${montarOptionsTipo(tipo)}</select>
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm ap-descricao"
                        value="${String(emb.descricao || '').replace(/"/g, '&quot;')}" placeholder="Opcional">
                </td>
                <td>
                    <input type="number" step="0.001" min="0" class="form-control form-control-sm ap-quantidade"
                        value="${num(emb.quantidade, 3) || ''}" placeholder="Ex.: 12" ${qtdReadonly}>
                </td>
                <td>
                    <select class="form-control form-control-sm ap-unidade-conteudo" aria-label="Unidade do conteúdo">
                        ${montarOptionsUnidadeConteudo(unidadeConteudo)}
                    </select>
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm ap-gtin"
                        value="${String(emb.gtin || '').replace(/"/g, '&quot;')}" placeholder="GTIN/EAN">
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm ap-codigo-fornecedor"
                        value="${String(emb.codigo_fornecedor || '').replace(/"/g, '&quot;')}" placeholder="cProd">
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm ap-fornecedor"
                        value="${String(emb.fornecedor_nome || '').replace(/"/g, '&quot;')}" placeholder="Fornecedor">
                </td>
                <td>
                    <input type="number" step="0.01" min="0" class="form-control form-control-sm ap-valor-compra"
                        value="${num(emb.valor_compra, 2) || ''}" placeholder="R$ compra">
                </td>
                <td class="text-center">
                    <input type="radio" name="apresentacao_principal" class="form-check-input ap-principal"
                        ${Number(emb.principal) === 1 ? 'checked' : ''} title="Principal">
                </td>
                <td class="text-center">
                    <input type="checkbox" class="form-check-input ap-compra"
                        ${Number(emb.compra ?? 0) === 1 ? 'checked' : ''} title="Utilizar na Compra">
                </td>
                <td class="text-center">
                    <input type="checkbox" class="form-check-input ap-venda"
                        ${Number(emb.venda ?? 1) === 1 ? 'checked' : ''} title="Utilizar na Venda">
                </td>
                <td class="text-center">
                    <input type="checkbox" class="form-check-input ap-estoque"
                        ${Number(emb.estoque ?? 1) === 1 ? 'checked' : ''} title="Estoque">
                </td>
                <td class="text-center">
                    <input type="checkbox" class="form-check-input ap-ativa"
                        ${Number(emb.ativa ?? 1) === 1 ? 'checked' : ''} title="Ativa">
                </td>
                <td class="text-end">
                    <button type="button" class="btn btn-sm btn-outline-danger ap-remover" title="Remover">&times;</button>
                </td>
            </tr>
        `;
    }

    function renderTabelaApresentacoes(lista) {
        const $tbody = $('#tabelaApresentacoes tbody');
        if (!$tbody.length) return;
        $tbody.empty();
        (lista || []).forEach((emb, index) => {
            $tbody.append(montarLinhaApresentacao(emb, index));
        });
        fixarEventosApresentacoes();
        atualizarUnidadesOrigemSimulacao();
    }

    function obterListaDoModal() {
        return $('#produtoModal').data('apresentacoesTemp') || [];
    }

    function salvarListaNoModal(lista) {
        $('#produtoModal').data('apresentacoesTemp', lista);
    }

    function utilizaConversaoAtiva() {
        return String($('input[name="utiliza_conversao"]:checked').val() || '0') === '1';
    }

    function capturarApresentacoesConversao() {
        return coletarApresentacoesDoFormulario().map((ap) => ({
            tipo: normalizarTipo(ap.tipo),
            quantidade: Number(ap.quantidade || 0),
            unidade: String(ap.unidade || '').trim().toUpperCase(),
            compra: Number(ap.compra ?? 0),
            ativa: Number(ap.ativa ?? 1)
        }));
    }

    function snapshotConfiguracaoMuc(config = null, apresentacoes = null) {
        const usa = config
            ? Number(config.utiliza_conversao ?? config.utilizaConversao) === 1
            : utilizaConversaoAtiva();
        const relacoes = config
            ? (config.relacoes || [])
            : (usa ? coletarRelacoesDoFormulario() : []);
        return JSON.stringify({
            utiliza_conversao: usa ? 1 : 0,
            unidade_estoque: usa
                ? String(config
                    ? (config.unidade_estoque || config.unidadeEstoque || '')
                    : ($('#unidade_estoque').val() || '')).trim().toUpperCase()
                : null,
            relacoes: usa ? relacoes.map((rel) => ({
                unidade_origem: String(rel.unidade_origem || rel.de || '').trim().toUpperCase(),
                unidade_destino: String(rel.unidade_destino || rel.para || '').trim().toUpperCase(),
                fator: Number(rel.fator || 0)
            })) : [],
            apresentacoes: apresentacoes || capturarApresentacoesConversao()
        });
    }

    function marcarConfiguracaoMucPersistida(config = null, apresentacoes = null) {
        const $modal = $('#produtoModal');
        const salvas = apresentacoes || capturarApresentacoesConversao();
        $modal.data('mucApresentacoesPersistidas', salvas);
        $modal.data('mucConfiguracaoPersistida', snapshotConfiguracaoMuc(config, salvas));
        atualizarEstadoConfiguracaoMuc();
    }

    function configuracaoMucPendente() {
        const inicial = $('#produtoModal').data('mucConfiguracaoPersistida');
        return typeof inicial === 'string' && inicial !== snapshotConfiguracaoMuc();
    }

    function atualizarEstadoConfiguracaoMuc() {
        const pendente = configuracaoMucPendente();
        $('#statusConfiguracaoMuc').toggleClass('d-none', !pendente);
        return pendente;
    }

    function invalidarSimulacaoMuc() {
        $('#resultado_simular_muc').removeClass('text-danger text-success').empty();
        atualizarEstadoConfiguracaoMuc();
    }

    function atualizarVisibilidadeConversaoMuc() {
        if (utilizaConversaoAtiva()) {
            $('#bloco_conversao_muc_detalhe').removeClass('d-none');
        } else {
            $('#bloco_conversao_muc_detalhe').addClass('d-none');
            $('#resultado_simular_muc').empty();
        }
            atualizarEstadoConfiguracaoMuc();
    }

    function montarLinhaRelacaoMuc(rel, index) {
        const origem = String(rel.unidade_origem || rel.de || 'UN').replace(/"/g, '&quot;');
        const destino = String(rel.unidade_destino || rel.para || 'ML').replace(/"/g, '&quot;');
        const fator = num(rel.fator, 6);
        const idAttr = rel.id ? ` data-relacao-id="${rel.id}"` : '';
        return `
            <tr${idAttr} data-relacao-index="${index}">
                <td class="text-center">1</td>
                <td><input type="text" class="form-control form-control-sm rel-origem" value="${origem}" placeholder="UN"></td>
                <td class="text-center">=</td>
                <td><input type="text" inputmode="decimal" class="form-control form-control-sm rel-fator" value="${fator > 0 ? fator : ''}" placeholder="2000"></td>
                <td><input type="text" class="form-control form-control-sm rel-destino" value="${destino}" placeholder="ML"></td>
                <td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger rel-remover" title="Remover">&times;</button></td>
            </tr>
        `;
    }

    function renderTabelaRelacoesMuc(lista) {
        const $tbody = $('#tabelaRelacoesMuc tbody');
        if (!$tbody.length) return;
        $tbody.empty();
        (lista || []).forEach((rel, index) => {
            $tbody.append(montarLinhaRelacaoMuc(rel, index));
        });
        fixarEventosRelacoesMuc();
        atualizarUnidadesOrigemSimulacao(true);
    }

    function coletarRelacoesDoFormulario() {
        const lista = [];
        $('#tabelaRelacoesMuc tbody tr').each(function coletarRel() {
            const $tr = $(this);
            const origem = String($tr.find('.rel-origem').val() || '').trim();
            const destino = String($tr.find('.rel-destino').val() || '').trim();
            const fator = num($tr.find('.rel-fator').val(), 6);
            const id = $tr.data('relacao-id') || null;
            if (!origem && !destino && !(fator > 0)) return;
            lista.push({
                id,
                unidade_origem: origem,
                unidade_destino: destino,
                de: origem,
                para: destino,
                fator
            });
        });
        return lista;
    }

    function atualizarUnidadesOrigemSimulacao(definirOrigemInicial = false) {
        const $origem = $('#simular_un_muc');
        const $opcoes = $('#unidades_origem_simular_muc');
        if (!$origem.length || !$opcoes.length) return;

        const unidades = new Set();
        const relacoes = coletarRelacoesDoFormulario();
        const adicionar = (valor) => {
            const unidade = String(valor || '').trim().toUpperCase();
            if (unidade) unidades.add(unidade);
        };
        relacoes.forEach((rel) => {
            adicionar(rel.unidade_origem);
            adicionar(rel.unidade_destino);
        });
        $('#tabelaApresentacoes tbody tr').each(function coletarApresentacao() {
            const $tr = $(this);
            if ($tr.find('.ap-ativa').is(':checked')) {
                adicionar($tr.find('.ap-tipo').val());
            }
        });
        const unidadeEstoque = String($('#unidade_estoque').val() || '').trim().toUpperCase();
        adicionar(unidadeEstoque);

        $opcoes.empty();
        unidades.forEach((unidade) => {
            $('<option>').val(unidade).appendTo($opcoes);
        });

        if (definirOrigemInicial && !$('#produtoModal').data('simulacaoOrigemPersonalizada')) {
            const primeiraOrigem = relacoes.find((rel) => String(rel.unidade_origem || '').trim());
            $origem.val(
                (primeiraOrigem && String(primeiraOrigem.unidade_origem).trim().toUpperCase())
                || unidadeEstoque
                || 'UN'
            );
        }
    }

    const UNIDADES_RELACAO = Object.freeze({
        UN: 'UN', UND: 'UN', UNI: 'UN', KG: 'KG', G: 'G', L: 'L', LTRO: 'L', ML: 'ML',
        M: 'M', MT: 'M', CM: 'CM', MM: 'MM', M2: 'M2', M3: 'M3',
        CX: 'CAIXA', CXA: 'CAIXA', CAIXA: 'CAIXA', FD: 'FARDO', FARDO: 'FARDO',
        PC: 'PACOTE', PCT: 'PACOTE', PACOTE: 'PACOTE', SC: 'SACO', SACO: 'SACO',
        LT: 'LATA', LATA: 'LATA', BD: 'BALDE', BALDE: 'BALDE', RL: 'ROLO', ROLO: 'ROLO',
        BR: 'BARRA', BARRA: 'BARRA', KIT: 'KIT', DISPLAY: 'DISPLAY', BOBINA: 'BOBINA', GALAO: 'GALAO'
    });

    function normalizarUnidadeRelacao(valor) {
        const token = String(valor || '').trim().toUpperCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
        return UNIDADES_RELACAO[token] || null;
    }

    // Valida cada relação (origem, fator, destino) com o mesmo critério do backend, indicando o campo.
    function validarRelacoesFormulario(lista) {
        const origemLista = Array.isArray(lista) ? lista : coletarRelacoesDoFormulario();
        const normalizadas = [];
        for (let i = 0; i < origemLista.length; i += 1) {
            const rel = origemLista[i];
            const n = i + 1;
            const falha = (campo, mensagem) => ({ ok: false, indice: i, campo, mensagem: `Relação ${n}: ${mensagem}`, relacoes: [] });
            const origemTxt = String(rel.unidade_origem || rel.de || '').trim();
            const destinoTxt = String(rel.unidade_destino || rel.para || '').trim();
            if (!origemTxt) return falha('origem', 'informe a unidade de origem.');
            const origem = normalizarUnidadeRelacao(origemTxt);
            if (!origem) return falha('origem', `unidade de origem "${origemTxt}" não reconhecida (ex.: UN, G, KG, ML, L).`);
            const fator = num(rel.fator, 6);
            if (!(fator > 0) || !Number.isFinite(fator)) {
                return falha('fator', 'informe um fator maior que zero.');
            }
            if (!destinoTxt) return falha('destino', 'informe a unidade de destino.');
            const destino = normalizarUnidadeRelacao(destinoTxt);
            if (!destino) return falha('destino', `unidade de destino "${destinoTxt}" não reconhecida (ex.: UN, G, KG, ML, L).`);
            if (origem === destino) return falha('destino', 'origem e destino devem ser diferentes.');
            normalizadas.push({
                id: rel.id || null,
                unidade_origem: origem,
                unidade_destino: destino,
                de: origem,
                para: destino,
                fator
            });
        }
        return { ok: true, relacoes: normalizadas };
    }

    function focarCampoRelacao(indice, campo) {
        const classe = { origem: '.rel-origem', destino: '.rel-destino', fator: '.rel-fator' }[campo];
        const $campo = $('#tabelaRelacoesMuc tbody tr').eq(indice).find(classe);
        if ($campo.length) $campo.trigger('focus');
    }

    function fixarEventosRelacoesMuc() {
        $('#btnAdicionarRelacaoMuc').off('click.relMuc').on('click.relMuc', () => {
            const lista = coletarRelacoesDoFormulario();
            lista.push({ unidade_origem: 'UN', unidade_destino: 'ML', fator: '' });
            renderTabelaRelacoesMuc(lista);
            invalidarSimulacaoMuc();
        });
        $('#tabelaRelacoesMuc').off('click.relMuc').on('click.relMuc', '.rel-remover', function onRemoverRel() {
            const $tr = $(this).closest('tr');
            const relacaoId = $tr.data('relacao-id');
            const produtoId = $('#produtoId').val();
            const token = localStorage.getItem('token') || '';
            if (relacaoId && produtoId && utilizaConversaoAtiva()) {
                if (!window.confirm('Excluir esta relação? Se ela for necessária para o caminho de conversão, o sistema bloqueará a exclusão.')) {
                    return;
                }
                $.ajax({
                    url: `${typeof API_URL !== 'undefined' ? API_URL : '/api'}/produtos/${produtoId}/conversao/relacoes/${relacaoId}`,
                    method: 'DELETE',
                    headers: { Authorization: 'Bearer ' + token },
                    success: function onExcluiu(cfg) {
                        renderTabelaRelacoesMuc(cfg.relacoes || []);
                        const apresentacoesSalvas = $('#produtoModal').data('mucApresentacoesPersistidas');
                        marcarConfiguracaoMucPersistida(cfg, apresentacoesSalvas);
                        invalidarSimulacaoMuc();
                    },
                    error: function onErroExcluir(xhr) {
                        const msg = (xhr.responseJSON && xhr.responseJSON.error)
                            || 'Não é possível excluir esta relação: a configuração ficaria inconsistente.';
                        if (typeof global.showNotification === 'function') {
                            global.showNotification(msg, 'warning');
                        } else {
                            window.alert(msg);
                        }
                    }
                });
                return;
            }
            $tr.remove();
            atualizarUnidadesOrigemSimulacao(true);
            invalidarSimulacaoMuc();
        });
        $('#produtoModal')
            .off('.mucDirty')
            .on(
                'input.mucDirty change.mucDirty',
                '#utiliza_conversao_sim, #utiliza_conversao_nao, #unidade_estoque, #tabelaRelacoesMuc input, #tabelaApresentacoes input, #tabelaApresentacoes select, #simular_qtd_muc, #simular_un_muc',
                function onAlteracaoMuc() {
                    const $campo = $(this);
                    const alterouRelacao = $campo.closest('#tabelaRelacoesMuc').length > 0;
                    if ($campo.is('#simular_un_muc')) {
                        $('#produtoModal').data('simulacaoOrigemPersonalizada', true);
                    }
                    atualizarUnidadesOrigemSimulacao(alterouRelacao);
                    invalidarSimulacaoMuc();
                }
            );
        $('#produtoModal')
            .off('click.mucOrigem')
            .on('click.mucOrigem', '#tabelaApresentacoes .ap-remover', () => {
                setTimeout(atualizarUnidadesOrigemSimulacao, 0);
            });
        $('#btnSimularConversaoMuc').off('click.relMuc').on('click.relMuc', function onSimular() {
            const $out = $('#resultado_simular_muc');
            $out.removeClass('text-danger text-success').empty();
            const produtoId = $('#produtoId').val();
            const token = localStorage.getItem('token') || '';
            const apiBase = typeof API_URL !== 'undefined' ? API_URL : '/api';
            const unidadeOrigem = ($('#simular_un_muc').val() || '').trim();
            const entrada = {
                quantidade: num($('#simular_qtd_muc').val(), 6),
                unidade: unidadeOrigem,
                unidadeOrigem,
                unidadeDestino: ($('#unidade_estoque').val() || '').trim()
            };
            let url = `${apiBase}/produtos/${produtoId}/conversao/simular`;
            let payload = entrada;
            if (!(entrada.quantidade > 0)) {
                $out.addClass('text-danger').text('Informe uma quantidade maior que zero para simular.');
                $('#simular_qtd_muc').trigger('focus');
                return;
            }
            if (!entrada.unidade) {
                $out.addClass('text-danger').text('Informe a unidade de origem da simulação.');
                $('#simular_un_muc').trigger('focus');
                return;
            }
            if (!entrada.unidadeDestino) {
                $out.addClass('text-danger').text('Selecione a unidade de estoque.');
                return;
            }
            if (!produtoId) {
                const v = validarRelacoesFormulario();
                if (!v.ok) {
                    $out.addClass('text-danger').text(v.mensagem);
                    focarCampoRelacao(v.indice, v.campo);
                    return;
                }
                url = `${apiBase}/produtos/conversao/simular`;
                payload = {
                    ...entrada,
                    unidade_estoque: entrada.unidadeDestino,
                    relacoes: v.relacoes,
                    apresentacoes: coletarApresentacoesDoFormulario()
                };
            } else if (configuracaoMucPendente()) {
                const v = validarRelacoesFormulario();
                if (!v.ok) {
                    $out.addClass('text-danger').text(v.mensagem);
                    focarCampoRelacao(v.indice, v.campo);
                    return;
                }
                payload = {
                    ...entrada,
                    configuracao: {
                        utiliza_conversao: utilizaConversaoAtiva() ? 1 : 0,
                        unidade_estoque: entrada.unidadeDestino,
                        relacoes: v.relacoes,
                        apresentacoes: coletarApresentacoesDoFormulario()
                    }
                };
            }
            $.ajax({
                url,
                method: 'POST',
                contentType: 'application/json',
                headers: { Authorization: 'Bearer ' + token },
                data: JSON.stringify(payload),
                success: function onOk(r) {
                    const caminhoArr = Array.isArray(r.caminho) ? r.caminho : [];
                    const caminho = caminhoArr.length && typeof caminhoArr[0] === 'string'
                        ? caminhoArr.join(' → ')
                        : (caminhoArr.length && caminhoArr[0] && caminhoArr[0].de
                            ? [caminhoArr[0].de].concat(caminhoArr.map((e) => e.para)).join(' → ')
                            : '');
                    const qtd = r.quantidade;
                    if (qtd == null || !Number.isFinite(Number(qtd))) {
                        $out.addClass('text-danger').text('Conversão não disponível.');
                        return;
                    }
                    const qtdOrigem = r.quantidade_origem != null ? r.quantidade_origem : entrada.quantidade;
                    const unOrigem = r.unidade_origem || entrada.unidade.toUpperCase();
                    const unEstoque = r.unidade_estoque || entrada.unidadeDestino;
                    $out.addClass('text-success').append(
                        $('<div class="badge bg-info text-dark mb-1">').text(
                            r.persistido === false ? 'Simulação — alterações não salvas' : 'Simulação — configuração salva'
                        ),
                        $('<div>').text(`Origem: ${Number(qtdOrigem).toLocaleString('pt-BR')} ${unOrigem}`)
                    );
                    (Array.isArray(r.etapas) ? r.etapas : []).forEach((etapa) => {
                        const de = String(etapa.de || '').trim().toUpperCase();
                        const para = String(etapa.para || '').trim().toUpperCase();
                        const fator = Number(etapa.fator);
                        if (!de || !para || !Number.isFinite(fator) || fator <= 0) return;
                        const fatorTexto = fator.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
                        $out.append(
                            $('<div>').text(`Relação aplicada: 1 ${de} = ${fatorTexto} ${para}`)
                        );
                    });
                    $out.append(
                        $('<strong>').text(`Resultado: ${Number(qtd).toLocaleString('pt-BR')} ${r.unidade || ''}`),
                        $('<div class="text-muted">').text(`Unidade de estoque: ${unEstoque}`)
                    );
                    if (caminho) {
                        $out.append($('<div class="text-muted">').text(`Caminho: ${caminho}`));
                    }
                    if (r.mensagem) {
                        $out.append($('<div class="text-info">').text(r.mensagem));
                    }
                },
                error: function onFail(xhr) {
                    const msg = (xhr.responseJSON && xhr.responseJSON.error)
                        || 'Conversão não disponível.';
                    $out.addClass('text-danger').text(msg);
                }
            });
        });
        $('input[name="utiliza_conversao"]').off('change.relMuc').on('change.relMuc', atualizarVisibilidadeConversaoMuc);
    }

    function inicializarConversaoMuc(produto) {
        const usa = Number(produto?.utiliza_conversao || 0) === 1;
        $('#produtoModal').data('simulacaoOrigemPersonalizada', false);
        $('#utiliza_conversao_sim').prop('checked', usa);
        $('#utiliza_conversao_nao').prop('checked', !usa);
        const dest = String(produto?.unidade_estoque || (usa ? produto?.unidade : '') || 'UN').toUpperCase();
        if ($('#unidade_estoque option[value="' + dest + '"]').length) {
            $('#unidade_estoque').val(dest);
        } else if (dest) {
            $('#unidade_estoque').append(`<option value="${dest}">${dest}</option>`).val(dest);
        }
        renderTabelaRelacoesMuc(produto?.relacoes || []);
        atualizarVisibilidadeConversaoMuc();
        fixarEventosRelacoesMuc();
    }

    function coletarApresentacoesDoFormulario() {
        const unidadeBase = String($('#unidade').val() || 'un').trim();
        const lista = [];
        $('#tabelaApresentacoes tbody tr').each(function coletarLinha() {
            const $tr = $(this);
            const tipo = normalizarTipo($tr.find('.ap-tipo').val());
            const unidadeConteudo = String($tr.find('.ap-unidade-conteudo').val() ?? '').trim();
            lista.push({
                id: $tr.data('apresentacao-id') || null,
                tipo,
                descricao: ($tr.find('.ap-descricao').val() || '').trim() || null,
                quantidade: tipo === 'UN' ? 1 : num($tr.find('.ap-quantidade').val(), 3),
                unidade: unidadeConteudo || (utilizaConversaoAtiva() ? '' : unidadeBase),
                gtin: ($tr.find('.ap-gtin').val() || '').trim() || null,
                codigo_fornecedor: ($tr.find('.ap-codigo-fornecedor').val() || '').trim() || null,
                fornecedor_nome: ($tr.find('.ap-fornecedor').val() || '').trim() || null,
                valor_compra: num($tr.find('.ap-valor-compra').val(), 2),
                preco_venda: 0,
                principal: $tr.find('.ap-principal').is(':checked') ? 1 : 0,
                compra: $tr.find('.ap-compra').is(':checked') ? 1 : 0,
                venda: $tr.find('.ap-venda').is(':checked') ? 1 : 0,
                estoque: $tr.find('.ap-estoque').is(':checked') ? 1 : 0,
                ativa: $tr.find('.ap-ativa').is(':checked') ? 1 : 0
            });
        });

        if (lista.length && !lista.some((e) => Number(e.principal) === 1)) {
            lista[0].principal = 1;
        }
        return lista;
    }

    function obterApresentacaoPrincipal() {
        const lista = coletarApresentacoesDoFormulario()
            .filter((e) => Number(e.ativa) === 1);
        return lista.find((e) => Number(e.principal) === 1)
            || lista.find((e) => Number(e.compra) === 1)
            || lista[0]
            || null;
    }

    function sincronizarFormacaoPrecoApresentacaoPrincipal(origem) {
        const principal = obterApresentacaoPrincipal();
        const motor = global.MotorUnidadesMedidaCliente;
        if (!principal || normalizarTipo(principal.tipo) === 'UN' || !motor) {
            $('#wrap_valor_embalagem_venda').addClass('d-none');
            return false;
        }

        const mapaTipo = {
            CX: 'CAIXA', FD: 'FARDO', PCT: 'PACOTE', SACO: 'SACO', ROLO: 'ROLO',
            BALDE: 'BALDE', GALAO: 'BALDE', KIT: 'PACOTE', DISPLAY: 'PACOTE', BOBINA: 'ROLO'
        };
        const qtdEmb = num(principal.quantidade, 3);
        const valorEmbCompra = num(principal.valor_compra, 2);
        if (qtdEmb <= 0) return false;

        const calc = motor.calcularFormacaoPrecoCadastro({
            compraPorEmbalagem: true,
            unidadeComercial: mapaTipo[normalizarTipo(principal.tipo)] || 'PACOTE',
            quantidadePorEmbalagem: qtdEmb,
            valorEmbalagemCompra: valorEmbCompra,
            custoUnitario: num($('#preco_compra').val(), 4),
            margemPercentual: num($('#lucro_percentual').val(), 2),
            precoVendaUnitario: num($('#preco_venda').val(), 2),
            origem: origem === 'venda' ? 'venda' : (origem === 'lucro' ? 'margem' : 'embalagem')
        });

        $('#wrap_valor_embalagem_venda').removeClass('d-none');
        $('#preco_compra').prop('readonly', true).addClass('bg-light');
        if (valorEmbCompra > 0 || origem === 'embalagem' || origem === 'init') {
            $('#preco_compra').val(calc.custoUnitario.toFixed(4));
        }
        if (origem === 'venda') {
            $('#lucro_percentual').val(calc.margemPercentual.toFixed(2));
        } else if (origem !== 'init' || num($('#preco_venda').val(), 2) <= 0) {
            $('#preco_venda').val(calc.precoVendaUnitario.toFixed(2));
        }
        $('#valor_embalagem_venda').val(
            typeof global.formatCurrency === 'function'
                ? global.formatCurrency(calc.valorEmbalagemVenda)
                : `R$ ${calc.valorEmbalagemVenda.toFixed(2)}`
        );
        if (typeof global.atualizarPreviewValorTotalEstoqueCadastro === 'function') {
            global.atualizarPreviewValorTotalEstoqueCadastro();
        }
        if (typeof global.atualizarFormacaoPrecoMargemInfo === 'function') {
            global.atualizarFormacaoPrecoMargemInfo();
        }
        return true;
    }

    function contarEmbalagensComerciaisAtivas() {
        return coletarApresentacoesDoFormulario().filter((e) => {
            if (Number(e.ativa) !== 1) return false;
            const tipo = normalizarTipo(e.tipo);
            return tipo !== 'UN' && Number(e.quantidade || 0) > 0;
        }).length;
    }

    function fixarEventosCompraPorEmbalagem() {
        const $toggle = $('#compra_por_embalagem');
        if (!$toggle.length) return;

        $toggle.off('change.compraEmb').on('change.compraEmb', function onToggleCompraEmb() {
            const ativo = $(this).is(':checked');
            if (ativo && contarEmbalagensComerciaisAtivas() === 0) {
                $('#alerta_sem_embalagens_compra').removeClass('d-none');
            } else {
                $('#alerta_sem_embalagens_compra').addClass('d-none');
            }
            if (typeof global.atualizarVisibilidadeEmbalagemComercialCadastro === 'function') {
                global.atualizarVisibilidadeEmbalagemComercialCadastro();
            }
        });

        $('#btnCadastrarEmbalagensCompra').off('click.compraEmb').on('click.compraEmb', () => {
            $('#alerta_sem_embalagens_compra').addClass('d-none');
            const lista = coletarApresentacoesDoFormulario();
            if (!lista.some((e) => normalizarTipo(e.tipo) !== 'UN')) {
                lista.push({
                    tipo: 'PCT',
                    descricao: '',
                    quantidade: 0,
                    unidade: unidadePadraoNovaApresentacao(),
                    gtin: '',
                    codigo_fornecedor: '',
                    fornecedor_nome: ($('#fornecedor').val() || '').trim(),
                    valor_compra: 0,
                    principal: 0,
                    compra: 1,
                    venda: 0,
                    estoque: 1,
                    ativa: 1
                });
                renderTabelaApresentacoes(lista);
            }
            $('#tabelaApresentacoes tbody tr:last .ap-quantidade').focus();
        });

        $('#btnAgoraNaoEmbalagensCompra').off('click.compraEmb').on('click.compraEmb', () => {
            $('#alerta_sem_embalagens_compra').addClass('d-none');
            $toggle.prop('checked', false);
        });
    }

    function inicializarCompraPorEmbalagem(produto) {
        const ativo = Number(produto?.compra_por_embalagem || 0) === 1;
        $('#compra_por_embalagem').prop('checked', ativo);
        $('#alerta_sem_embalagens_compra').addClass('d-none');
        fixarEventosCompraPorEmbalagem();
    }

    function obterCompraPorEmbalagemAtiva() {
        return $('#compra_por_embalagem').is(':checked');
    }

    function fixarEventosApresentacoes() {
        fixarEventosCompraPorEmbalagem();
        const $painel = $('#painel_apresentacoes');
        $painel.off('change.apresentacoes input.apresentacoes click.apresentacoes');

        $painel.on('change.apresentacoes', '.ap-tipo', function onTipo() {
            const $tr = $(this).closest('tr');
            const tipo = normalizarTipo($(this).val());
            const $qtd = $tr.find('.ap-quantidade');
            if (tipo === 'UN') {
                $qtd.val(1).prop('readonly', true);
            } else {
                $qtd.prop('readonly', false);
            }
            sincronizarFormacaoPrecoApresentacaoPrincipal('embalagem');
        });

        $painel.on('input.apresentacoes change.apresentacoes', '.ap-quantidade, .ap-valor-compra', () => {
            sincronizarFormacaoPrecoApresentacaoPrincipal('embalagem');
        });

        $painel.on('change.apresentacoes', '.ap-principal', function onPrincipal() {
            if ($(this).is(':checked')) {
                $painel.find('.ap-principal').not(this).prop('checked', false);
            }
        });

        $painel.on('click.apresentacoes', '.ap-remover', function onRemover() {
            $(this).closest('tr').remove();
            sincronizarFormacaoPrecoApresentacaoPrincipal('init');
        });

        $('#btnAdicionarApresentacao').off('click.apresentacoes').on('click.apresentacoes', () => {
            const lista = coletarApresentacoesDoFormulario();
            lista.push({
                tipo: 'PCT',
                descricao: '',
                quantidade: 0,
                unidade: unidadePadraoNovaApresentacao(),
                gtin: '',
                codigo_fornecedor: '',
                fornecedor_nome: ($('#fornecedor').val() || '').trim(),
                valor_compra: 0,
                principal: lista.length === 0 ? 1 : 0,
                compra: 1,
                venda: 0,
                estoque: 1,
                ativa: 1
            });
            renderTabelaApresentacoes(lista);
        });
    }

    function montarHtmlPainelApresentacoes() {
        return `
            <div class="col-12" id="painel_apresentacoes">
                <div class="border rounded p-3 bg-light">
                    <div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
                        <div>
                            <h6 class="mb-1">Comercialização</h6>
                            <small class="text-muted">Embalagens comerciais para compra e venda (MUC).</small>
                        </div>
                    </div>
                    <div class="form-check form-switch mb-3">
                        <input class="form-check-input" type="checkbox" role="switch" id="compra_por_embalagem">
                        <label class="form-check-label fw-semibold" for="compra_por_embalagem">
                            Compra por Embalagem Comercial
                        </label>
                        <small class="text-muted d-block ms-0">
                            Quando ativo, o lançamento manual de compras utiliza embalagens e conversão MUC.
                        </small>
                    </div>
                    <div class="border rounded p-3 bg-white mb-3" id="painel_conversao_muc">
                        <h6 class="mb-2">Conversão / estoque</h6>
                        <p class="small text-muted mb-2">Independente de comercial ou insumo. O MUC calcula; compras registra o estoque.</p>
                        <div class="mb-2">
                            <span class="fw-semibold d-block mb-1">Utiliza conversão?</span>
                            <div class="form-check form-check-inline">
                                <input class="form-check-input" type="radio" name="utiliza_conversao" id="utiliza_conversao_nao" value="0" checked>
                                <label class="form-check-label" for="utiliza_conversao_nao">Não</label>
                            </div>
                            <div class="form-check form-check-inline">
                                <input class="form-check-input" type="radio" name="utiliza_conversao" id="utiliza_conversao_sim" value="1">
                                <label class="form-check-label" for="utiliza_conversao_sim">Sim</label>
                            </div>
                        </div>
                        <div id="statusConfiguracaoMuc" class="small text-warning mb-2 d-none" role="status">
                            Alterações não salvas
                        </div>
                        <div id="bloco_conversao_muc_detalhe" class="d-none">
                            <details class="border rounded p-2 mb-3 muc-ajuda">
                                <summary class="fw-semibold">Como preencher?</summary>
                                <div class="pt-2">
                                    <p class="small mb-2"><strong>Origem</strong> é a unidade que será informada na entrada. <strong>Fator</strong> é a quantidade real na unidade de destino para cada 1 unidade de origem. <strong>Destino</strong> é a unidade em que o estoque será controlado.</p>
                                    <p class="small mb-2">Exemplo de relação do produto:</p>
                                    <div class="table-responsive">
                                        <table class="table table-sm table-bordered w-auto mb-2" aria-label="Exemplo de relação MUC">
                                            <thead class="table-light"><tr><th>1</th><th>Origem</th><th>=</th><th>Fator</th><th>Destino</th></tr></thead>
                                            <tbody><tr><td>1</td><td>KG</td><td>=</td><td>850</td><td>ML</td></tr></tbody>
                                        </table>
                                    </div>
                                    <img src="/erp/assets/muc-relacao-preenchida.svg" class="img-fluid border rounded mb-2" alt="Tabela de relação preenchida com 1 KG igual a 850 ML" loading="lazy">
                                    <p class="small mb-2"><strong>Simulação:</strong> entrada de 5 KG → resultado esperado de 4.250 ML.</p>
                                    <p class="small mb-2">Se preferir controlar em litros, cadastre 1 KG = 0,850 L (ou 0.850 L) e use L como destino; 5 KG resultarão em 4,25 L. Também é possível usar ML como destino com fator 850.</p>
                                    <div class="alert alert-warning py-2 mb-0 small">O fator deve representar a relação real deste produto. KG e ML não têm equivalência universal: a conversão só será feita quando esta relação explícita estiver cadastrada.</div>
                                </div>
                            </details>
                            <div class="mb-2">
                                <label class="form-label" for="unidade_estoque">Unidade de estoque</label>
                                <select class="form-control form-control-sm" id="unidade_estoque">
                                    <option value="UN">UN</option>
                                    <option value="ML">ML</option>
                                    <option value="L">L</option>
                                    <option value="G">G</option>
                                    <option value="KG">KG</option>
                                    <option value="PACOTE">PACOTE (PCT)</option>
                                </select>
                                <small class="text-muted">Para controlar o saldo em pacotes, selecione PACOTE (PCT). Cadastre 1 PCT = 50 UN em Apresentações Comerciais, não em Relações SI.</small>
                            </div>
                            <div class="mb-2">
                                <div class="d-flex justify-content-between align-items-center">
                                    <h6 class="mb-0">Relações</h6>
                                    <button type="button" class="btn btn-sm btn-outline-secondary" id="btnAdicionarRelacaoMuc">+ Adicionar relação</button>
                                </div>
                                <small class="text-muted">Ex.: 1 UN = 2.000 ML. Não cadastre 1 CAIXA = 24.000 ML no lugar das duas etapas.</small>
                                <table class="table table-sm table-bordered mt-2 mb-0" id="tabelaRelacoesMuc">
                                    <thead class="table-light"><tr><th>1</th><th>Origem</th><th>=</th><th>Fator</th><th>Destino</th><th></th></tr></thead>
                                    <tbody></tbody>
                                </table>
                            </div>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-3">
                                    <label class="form-label small" for="simular_qtd_muc">Quantidade de origem</label>
                                    <input type="number" class="form-control form-control-sm" id="simular_qtd_muc" min="0" step="0.001" value="1">
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small" for="simular_un_muc">Unidade de origem</label>
                                    <input type="text" class="form-control form-control-sm" id="simular_un_muc" list="unidades_origem_simular_muc" value="">
                                    <datalist id="unidades_origem_simular_muc"></datalist>
                                </div>
                                <div class="col-md-3">
                                    <button type="button" class="btn btn-sm btn-primary" id="btnSimularConversaoMuc">Simular conversão</button>
                                </div>
                                <div class="col-12 small text-muted">
                                    Simular não grava a configuração nem movimenta o estoque. Use “Salvar” para persistir as alterações.
                                </div>
                                <div class="col-12">
                                    <div id="resultado_simular_muc" class="small"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="alerta_sem_embalagens_compra" class="alert alert-warning py-2 d-none mb-3">
                        <div class="small mb-2">Este produto ainda não possui embalagens comerciais cadastradas. Deseja cadastrá-las agora?</div>
                        <div class="d-flex gap-2 flex-wrap">
                            <button type="button" class="btn btn-sm btn-primary" id="btnCadastrarEmbalagensCompra">Cadastrar Embalagens</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" id="btnAgoraNaoEmbalagensCompra">Agora Não</button>
                        </div>
                    </div>
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <div>
                            <h6 class="mb-0">Apresentações Comerciais</h6>
                            <small class="text-muted">Informe quantidade e unidade do conteúdo por embalagem (ex.: 1 PCT = 350 G; 1 CAIXA = 12 UN).</small>
                        </div>
                        <button type="button" class="btn btn-sm btn-outline-primary" id="btnAdicionarApresentacao">
                            + Apresentação
                        </button>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-sm table-bordered mb-0" id="tabelaApresentacoes">
                            <thead class="table-light">
                                <tr>
                                    <th>Tipo</th>
                                    <th>Descrição</th>
                                    <th>Qtd. conteúdo</th>
                                    <th>Un. conteúdo</th>
                                    <th>GTIN</th>
                                    <th>Cód. forn.</th>
                                    <th>Fornecedor</th>
                                    <th>Vlr compra</th>
                                    <th class="text-center" title="Principal">Princ.</th>
                                    <th class="text-center" title="Utilizar na Compra">Na Compra</th>
                                    <th class="text-center" title="Utilizar na Venda">Na Venda</th>
                                    <th class="text-center" title="Conversão estoque">Est.</th>
                                    <th class="text-center" title="Ativa">Ativa</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    function inicializarApresentacoes(produto) {
        const lista = inicializarLista(produto);
        salvarListaNoModal(lista);
        inicializarCompraPorEmbalagem(produto);
        inicializarConversaoMuc(produto);
        renderTabelaApresentacoes(lista);
        marcarConfiguracaoMucPersistida();
        setTimeout(() => sincronizarFormacaoPrecoApresentacaoPrincipal('init'), 0);
    }

    function recarregarConfiguracaoPersistida(produtoId) {
        const token = localStorage.getItem('token') || '';
        const apiBase = typeof API_URL !== 'undefined' ? API_URL : '/api';
        return $.ajax({
            url: `${apiBase}/produtos/${produtoId}/conversao`,
            method: 'GET',
            headers: { Authorization: 'Bearer ' + token }
        }).then((config) => {
            inicializarConversaoMuc(config);
            marcarConfiguracaoMucPersistida(config);
            return config;
        });
    }

    function obterApresentacaoCompraProduto(produto) {
        if (typeof ProdutoApresentacaoResolver !== 'undefined') {
            return ProdutoApresentacaoResolver.resolverApresentacaoCompra(produto);
        }
        if (!produto) return null;
        if (Array.isArray(produto.embalagens) && produto.embalagens.length) {
            const ativas = produto.embalagens.filter((e) => Number(e.ativa ?? 1) === 1);
            return ativas.find((e) => Number(e.compra) === 1)
                || ativas.find((e) => Number(e.principal) === 1)
                || ativas[0]
                || null;
        }
        return null;
    }

    global.ProdutoEmbalagensUI = {
        TIPOS_APRESENTACAO,
        montarHtmlPainelApresentacoes,
        inicializarApresentacoes,
        coletarApresentacoesDoFormulario,
        coletarRelacoesDoFormulario,
        validarRelacoesFormulario,
        focarCampoRelacao,
        normalizarUnidadeRelacao,
        utilizaConversaoAtiva,
        obterApresentacaoPrincipal,
        obterApresentacaoCompraProduto,
        obterCompraPorEmbalagemAtiva,
        sincronizarFormacaoPrecoApresentacaoPrincipal,
        legadoParaApresentacoes,
        recarregarConfiguracaoPersistida
    };
}(window));
