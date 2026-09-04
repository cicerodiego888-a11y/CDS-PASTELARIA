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

    function montarLinhaApresentacao(emb, index) {
        const tipo = normalizarTipo(emb.tipo);
        const qtdReadonly = tipo === 'UN' ? 'readonly' : '';
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

    function atualizarVisibilidadeConversaoMuc() {
        if (utilizaConversaoAtiva()) {
            $('#bloco_conversao_muc_detalhe').removeClass('d-none');
        } else {
            $('#bloco_conversao_muc_detalhe').addClass('d-none');
            $('#resultado_simular_muc').empty();
        }
    }

    function montarLinhaRelacaoMuc(rel, index) {
        const origem = String(rel.unidade_origem || rel.de || 'UN').replace(/"/g, '&quot;');
        const destino = String(rel.unidade_destino || rel.para || 'ML').replace(/"/g, '&quot;');
        const fator = Number(rel.fator);
        const idAttr = rel.id ? ` data-relacao-id="${rel.id}"` : '';
        return `
            <tr${idAttr} data-relacao-index="${index}">
                <td class="text-center">1</td>
                <td><input type="text" class="form-control form-control-sm rel-origem" value="${origem}" placeholder="UN"></td>
                <td class="text-center">=</td>
                <td><input type="number" step="0.001" min="0" class="form-control form-control-sm rel-fator" value="${Number.isFinite(fator) && fator > 0 ? fator : ''}" placeholder="2000"></td>
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

    function fixarEventosRelacoesMuc() {
        $('#btnAdicionarRelacaoMuc').off('click.relMuc').on('click.relMuc', () => {
            const lista = coletarRelacoesDoFormulario();
            lista.push({ unidade_origem: 'UN', unidade_destino: 'ML', fator: '' });
            renderTabelaRelacoesMuc(lista);
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
        });
        $('#btnSimularConversaoMuc').off('click.relMuc').on('click.relMuc', function onSimular() {
            const $out = $('#resultado_simular_muc');
            $out.removeClass('text-danger text-success').empty();
            const produtoId = $('#produtoId').val();
            if (!produtoId) {
                $out.addClass('text-danger').text('Salve o produto antes de simular a conversão.');
                return;
            }
            const token = localStorage.getItem('token') || '';
            $.ajax({
                url: `${typeof API_URL !== 'undefined' ? API_URL : '/api'}/produtos/${produtoId}/conversao/simular`,
                method: 'POST',
                contentType: 'application/json',
                headers: { Authorization: 'Bearer ' + token },
                data: JSON.stringify({
                    quantidade: num($('#simular_qtd_muc').val(), 6),
                    unidade: ($('#simular_un_muc').val() || '').trim(),
                    unidadeOrigem: ($('#simular_un_muc').val() || '').trim(),
                    unidadeDestino: ($('#unidade_estoque').val() || '').trim()
                }),
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
                    $out.addClass('text-success').html(
                        `<strong>${Number(qtd).toLocaleString('pt-BR')} ${r.unidade || ''}</strong>`
                        + (caminho ? `<div class="text-muted">Caminho: ${caminho}</div>` : '')
                    );
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
        const unidadeBase = utilizaConversaoAtiva()
            ? 'UN'
            : String($('#unidade').val() || 'un').trim().toLowerCase();
        const lista = [];
        $('#tabelaApresentacoes tbody tr').each(function coletarLinha() {
            const $tr = $(this);
            const tipo = normalizarTipo($tr.find('.ap-tipo').val());
            lista.push({
                id: $tr.data('apresentacao-id') || null,
                tipo,
                descricao: ($tr.find('.ap-descricao').val() || '').trim() || null,
                quantidade: tipo === 'UN' ? 1 : num($tr.find('.ap-quantidade').val(), 3),
                unidade: unidadeBase,
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
                    unidade: String($('#unidade').val() || 'un').trim().toLowerCase(),
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
                unidade: String($('#unidade').val() || 'un').trim().toLowerCase(),
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
                        <div id="bloco_conversao_muc_detalhe" class="d-none">
                            <div class="mb-2">
                                <label class="form-label" for="unidade_estoque">Unidade de estoque</label>
                                <select class="form-control form-control-sm" id="unidade_estoque">
                                    <option value="UN">UN</option>
                                    <option value="ML">ML</option>
                                    <option value="L">L</option>
                                    <option value="G">G</option>
                                    <option value="KG">KG</option>
                                </select>
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
                                    <label class="form-label small" for="simular_qtd_muc">Simular qtd</label>
                                    <input type="number" class="form-control form-control-sm" id="simular_qtd_muc" min="0" step="0.001" value="12">
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small" for="simular_un_muc">Unidade</label>
                                    <input type="text" class="form-control form-control-sm" id="simular_un_muc" value="CAIXA">
                                </div>
                                <div class="col-md-3">
                                    <button type="button" class="btn btn-sm btn-primary" id="btnSimularConversaoMuc">Simular conversão</button>
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
                            <small class="text-muted">Cadastre múltiplas embalagens (UN, CX, FD, PCT…). Com conversão ativa, a quantidade é em UN (ex.: 1 CAIXA = 12 UN).</small>
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
                                    <th>Qtd conv.</th>
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
        renderTabelaApresentacoes(lista);
        inicializarCompraPorEmbalagem(produto);
        inicializarConversaoMuc(produto);
        setTimeout(() => sincronizarFormacaoPrecoApresentacaoPrincipal('init'), 0);
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
        utilizaConversaoAtiva,
        obterApresentacaoPrincipal,
        obterApresentacaoCompraProduto,
        obterCompraPorEmbalagemAtiva,
        sincronizarFormacaoPrecoApresentacaoPrincipal,
        legadoParaApresentacoes
    };
}(window));
