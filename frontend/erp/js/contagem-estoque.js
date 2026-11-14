/**
 * Contagem física mínima F×NF — CDS-ESTOQUE-MANUAL-01.
 * CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1 — preserva snapshot do preview na confirmação.
 * CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04 — alerta informativo de entradas da Central sem compra.
 * CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05 — periodicidade informativa por empresa.
 * CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1 — menu Estoque + pesquisa por nome/código/barras.
 * CDS-ESTOQUE-CONTAGEM-CONVERSAO-UNIDADES-F12-05.2 — conversão MUC + campo NF conforme F12.
 * CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3 — saldo atual, conversão e diferença em tempo real.
 * A movimentação oficial ocorre somente em confirmar().
 */
(function (root) {
  'use strict';

  function authHeaders(extra) {
    const h = Object.assign({
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
    }, extra || {});
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.headersJson === 'function') {
      const ctx = root.CdsEmpresaContexto.headersJson();
      if (ctx['X-Empresa-Id']) h['X-Empresa-Id'] = ctx['X-Empresa-Id'];
    }
    return h;
  }

  function empresaIdAtual() {
    if (root.CdsEmpresaContexto) {
      if (typeof root.CdsEmpresaContexto.lerEmpresaId === 'function') {
        const idLer = Number(root.CdsEmpresaContexto.lerEmpresaId());
        if (Number.isInteger(idLer) && idLer > 0) return idLer;
      }
      if (typeof root.CdsEmpresaContexto.getEmpresaId === 'function') {
        const id = Number(root.CdsEmpresaContexto.getEmpresaId());
        if (Number.isInteger(id) && id > 0) return id;
      }
    }
    const h = authHeaders();
    const fromHeader = Number(h['X-Empresa-Id']);
    return Number.isInteger(fromHeader) && fromHeader > 0 ? fromHeader : null;
  }

  function empresaAtual() {
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.lerEmpresa === 'function') {
      return root.CdsEmpresaContexto.lerEmpresa();
    }
    return null;
  }

  function empresaLabelAtual() {
    const id = empresaIdAtual();
    const emp = empresaAtual();
    const nome = emp ? String(emp.nome_fantasia || emp.razao_social || '').trim() : '';
    if (id == null) return 'não selecionada';
    return nome ? (nome + ' (#' + id + ')') : ('Empresa #' + id);
  }

  /** Mesma regra oficial de classificarTipoEmpresa (CNPJ ordem 0001 = matriz). */
  function rotuloTipoEmpresa(emp) {
    if (!emp) return '';
    const tipo = String(emp.tipo_empresa || '').toUpperCase();
    if (tipo === 'MATRIZ') return 'Matriz';
    if (tipo === 'FILIAL') return 'Filial';
    const digitos = String(emp.cnpj || '').replace(/\D/g, '');
    if (digitos.length !== 14) return '';
    return digitos.slice(8, 12) === '0001' ? 'Matriz' : 'Filial';
  }

  function podeAcessarContagem() {
    if (typeof root.podeAjustarEstoque === 'function') return !!root.podeAjustarEstoque();
    if (typeof root.usuarioTemPermissao === 'function') return !!root.usuarioTemPermissao('contagem-estoque');
    return false;
  }

  function notify(msg, tipo) {
    if (typeof root.showNotification === 'function') root.showNotification(msg, tipo || 'info');
    else if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(msg);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatarQtd(valor) {
    if (valor == null || valor === '') return '—';
    const n = Number(valor);
    if (!Number.isFinite(n)) return '—';
    const neg = n < 0;
    const abs = Math.abs(n);
    const texto = String(Math.round(abs * 1e6) / 1e6);
    const partes = texto.split('.');
    partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const corpo = partes.length > 1 ? (partes[0] + ',' + partes[1]) : partes[0];
    return (neg ? '-' : '') + corpo;
  }

  function classificarDiferenca(valor) {
    if (valor == null || valor === '') return null;
    const n = Number(valor);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) <= 1e-9) return 'sem_diferenca';
    return n < 0 ? 'baixa' : 'acrescimo';
  }

  function rotuloDiferenca(classe) {
    if (classe === 'baixa') return 'Baixa prevista';
    if (classe === 'acrescimo') return 'Acréscimo previsto';
    if (classe === 'sem_diferenca') return 'Sem diferença';
    return '';
  }

  function classeBadge(classe) {
    if (classe === 'baixa') return 'cef-badge cef-badge--baixa';
    if (classe === 'acrescimo') return 'cef-badge cef-badge--acrescimo';
    if (classe === 'sem_diferenca') return 'cef-badge cef-badge--zero';
    return 'cef-badge';
  }

  function linhaTemDiferenca(linha) {
    const fiscal = classificarDiferenca(linha && linha.diferenca_fiscal);
    if (fiscal && fiscal !== 'sem_diferenca') return true;
    if (!linha || linha.omitir_nao_fiscal) return false;
    const naoFiscal = classificarDiferenca(linha.diferenca_nao_fiscal);
    return !!(naoFiscal && naoFiscal !== 'sem_diferenca');
  }

  function resumoContagem(itens) {
    const lista = Array.isArray(itens) ? itens : [];
    let com = 0;
    lista.forEach(function (linha) {
      if (linhaTemDiferenca(linha)) com += 1;
    });
    return {
      produtos_adicionados: lista.length,
      produtos_com_diferenca: com,
      produtos_sem_diferenca: lista.length - com,
      ajustes_previstos: com,
      aguardando_confirmacao: true
    };
  }

  function arredondarQtdEstoque(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 1e6) / 1e6;
  }

  function estadoInicialAjusteDirecionado() {
    return {
      operacao: 'AJUSTE_DIRECIONADO',
      tipo: 'BAIXA',
      ligado: false,
      rotulo: 'BAIXA DE ESTOQUE'
    };
  }

  function rotuloTipoAjuste(tipo) {
    const normalizado = String(tipo || '').trim().toUpperCase();
    if (normalizado === 'ACRESCIMO' || normalizado === 'ACRÉSCIMO' || normalizado === 'ON') {
      return 'ACRÉSCIMO DE ESTOQUE';
    }
    return 'BAIXA DE ESTOQUE';
  }

  function calcularSaldoPrevisto(saldo, quantidadeConvertida, tipo) {
    const base = arredondarQtdEstoque(saldo);
    const movimento = arredondarQtdEstoque(quantidadeConvertida);
    if (base == null || movimento == null) return null;
    const normalizado = String(tipo || '').trim().toUpperCase();
    if (normalizado === 'ACRESCIMO' || normalizado === 'ACRÉSCIMO' || normalizado === 'ON') {
      return arredondarQtdEstoque(base + movimento);
    }
    if (normalizado === 'BAIXA' || normalizado === 'OFF') {
      return arredondarQtdEstoque(base - movimento);
    }
    return null;
  }

  function resumoDirecionado(itens) {
    const lista = Array.isArray(itens) ? itens : [];
    let baixas = 0;
    let acrescimos = 0;
    let contagens = 0;
    const porUnidade = {};
    lista.forEach(function (linha) {
      if (linha.tipo_ajuste === 'BAIXA') baixas += 1;
      else if (linha.tipo_ajuste === 'ACRESCIMO') acrescimos += 1;
      else contagens += 1;
      if (linha.tipo_ajuste !== 'BAIXA' && linha.tipo_ajuste !== 'ACRESCIMO') return;
      const unidade = linha.unidade_base || 'UN';
      if (!porUnidade[unidade]) {
        porUnidade[unidade] = {
          baixa_fiscal: 0,
          acrescimo_fiscal: 0,
          baixa_nao_fiscal: 0,
          acrescimo_nao_fiscal: 0
        };
      }
      const movF = Math.abs(Number(linha.diferenca_fiscal) || 0);
      const movNf = linha.omitir_nao_fiscal ? 0 : Math.abs(Number(linha.diferenca_nao_fiscal) || 0);
      if (linha.tipo_ajuste === 'BAIXA') {
        porUnidade[unidade].baixa_fiscal += movF;
        porUnidade[unidade].baixa_nao_fiscal += movNf;
      } else {
        porUnidade[unidade].acrescimo_fiscal += movF;
        porUnidade[unidade].acrescimo_nao_fiscal += movNf;
      }
    });
    return {
      produtos: lista.length,
      baixas: baixas,
      acrescimos: acrescimos,
      contagens: contagens,
      por_unidade: porUnidade,
      aguardando_confirmacao: true
    };
  }

  /**
   * Exibe os números devolvidos pelo backend. Não multiplica quantidade × fator.
   */
  function textoConversao(preview, campo) {
    if (!preview) return '';
    const informada = campo === 'nf'
      ? preview.quantidade_nao_fiscal_informada
      : preview.quantidade_fiscal_informada;
    const convertida = campo === 'nf'
      ? preview.quantidade_nao_fiscal_contada
      : preview.quantidade_fiscal_contada;
    if (informada == null || convertida == null) return '';
    const un = preview.unidade_informada || 'UN';
    const ub = preview.unidade_base || '';
    const fator = preview.fator_total != null ? Number(preview.fator_total) : null;
    if (fator != null && fator !== 1) {
      return formatarQtd(informada) + ' ' + un + ' × ' + formatarQtd(fator) + ' ' + ub
        + ' = ' + formatarQtd(convertida) + ' ' + ub;
    }
    return formatarQtd(convertida) + (ub ? (' ' + ub) : '');
  }

  function calculoAindaValido(ctx) {
    if (!ctx) return false;
    if (Number(ctx.seqResposta) !== Number(ctx.seqAtual)) return false;
    if (ctx.produtoResposta == null || ctx.produtoAtual == null) return false;
    return Number(ctx.produtoResposta) === Number(ctx.produtoAtual);
  }

  function mesmaQuantidade(a, b) {
    if (a == null || b == null || a === '' || b === '') return false;
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) <= 1e-9;
  }

  /** Linhas com snapshot imutável do preview (não recalcular no browser). */
  let linhas = [];
  let confirmacaoEmAndamento = false;
  let aguardandoNovoPreview = false;
  /** @type {{ id: number, nome: string, codigo?: string|null, codigo_barras?: string|null, unidade?: string }|null} */
  let produtoSelecionado = null;
  let saldoConsulta = null;
  let previewAtual = null;
  let buscaTimer = null;
  let calcTimer = null;
  let editTimer = null;
  let buscaSeq = 0;
  let saldoSeq = 0;
  let calcSeq = 0;
  let editSeq = 0;
  let editandoIndice = null;
  let listenerSugestoesDoc = false;
  /** Modo F12 capturado ao abrir/atualizar a tela — mudança exige novo preview. */
  let modoFiscalSessao = null;
  /** Ajuste direcionado começa sempre em BAIXA. Não é preferência persistida. */
  let operacaoForm = 'AJUSTE_DIRECIONADO';
  let tipoAjusteForm = 'BAIXA';

  function lerModoFiscalAtivo() {
    if (typeof root.modoFiscalAtivoSistema === 'function') return !!root.modoFiscalAtivoSistema();
    if (typeof root.modoFiscalQueryParam === 'function') return root.modoFiscalQueryParam() === '1';
    try {
      return localStorage.getItem('pdv_modo_fiscal_ativo') === '1';
    } catch (_) {
      return true;
    }
  }

  function sincronizarModoFiscalSessao() {
    modoFiscalSessao = lerModoFiscalAtivo();
    return modoFiscalSessao;
  }

  function modoFiscalMudou() {
    return modoFiscalSessao != null && lerModoFiscalAtivo() !== modoFiscalSessao;
  }

  function snapshotDaLinha(preview, metaProduto) {
    const meta = metaProduto || {};
    return {
      produto_id: Number(preview.produto_id),
      produto_nome: meta.nome || preview.produto_nome || ('Produto #' + preview.produto_id),
      produto_codigo: meta.codigo != null ? meta.codigo : (preview.produto_codigo || null),
      empresa_id: preview.empresa_id != null ? Number(preview.empresa_id) : null,
      unidade_informada: preview.unidade_informada || meta.unidade || meta.unidade_comercial || null,
      unidade_base: preview.unidade_base || meta.unidade_base || null,
      fator_total: preview.fator_total != null ? preview.fator_total : meta.fator_conversao,
      apresentacao_id: meta.apresentacao_id != null
        ? Number(meta.apresentacao_id)
        : (preview.apresentacao_id != null ? Number(preview.apresentacao_id) : null),
      quantidade_fiscal_informada: preview.quantidade_fiscal_informada,
      quantidade_nao_fiscal_informada: preview.quantidade_nao_fiscal_informada,
      quantidade_fiscal_contada: preview.quantidade_fiscal_contada,
      quantidade_nao_fiscal_contada: preview.quantidade_nao_fiscal_contada,
      omitir_nao_fiscal: !!preview.omitir_nao_fiscal,
      modo_fiscal: preview.modo_fiscal || (preview.omitir_nao_fiscal ? '1' : '0'),
      mensagem_conversao_fiscal: preview.mensagem_conversao_fiscal || null,
      saldo_fiscal_anterior: preview.saldo_fiscal_anterior,
      saldo_nao_fiscal_anterior: preview.saldo_nao_fiscal_anterior,
      saldo_fiscal_esperado: preview.saldo_fiscal_esperado != null
        ? preview.saldo_fiscal_esperado
        : preview.saldo_fiscal_anterior,
      saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado != null
        ? preview.saldo_nao_fiscal_esperado
        : preview.saldo_nao_fiscal_anterior,
      diferenca_fiscal: preview.diferenca_fiscal,
      diferenca_nao_fiscal: preview.diferenca_nao_fiscal,
      operacao: preview.operacao || 'CONTAGEM_FISICA',
      tipo_ajuste: preview.tipo_ajuste || null,
      saldo_fiscal_previsto: preview.saldo_fiscal_previsto != null
        ? preview.saldo_fiscal_previsto
        : preview.quantidade_fiscal_contada,
      saldo_nao_fiscal_previsto: preview.saldo_nao_fiscal_previsto != null
        ? preview.saldo_nao_fiscal_previsto
        : (preview.omitir_nao_fiscal
          ? preview.saldo_nao_fiscal_esperado
          : preview.quantidade_nao_fiscal_contada),
      saldo_insuficiente: !!preview.saldo_insuficiente,
      saldo_disponivel_fiscal: preview.saldo_disponivel_fiscal,
      saldo_disponivel_nao_fiscal: preview.saldo_disponivel_nao_fiscal,
      quantidade_solicitada_fiscal: preview.quantidade_solicitada_fiscal,
      quantidade_solicitada_nao_fiscal: preview.quantidade_solicitada_nao_fiscal
    };
  }

  /** Contrato Sprint 03.1 — valores do preview (unidade-base) + snapshot. */
  function itemConfirmacao(l) {
    return {
      produto_id: l.produto_id,
      quantidade_fiscal_contada: l.quantidade_fiscal_contada,
      quantidade_nao_fiscal_contada: l.quantidade_nao_fiscal_contada,
      saldo_fiscal_esperado: l.saldo_fiscal_esperado,
      saldo_nao_fiscal_esperado: l.saldo_nao_fiscal_esperado
    };
  }

  /**
   * Payload de confirmação 05.2: preserva snapshot 03.1 e envia quantidades
   * comerciais informadas para reconversão oficial no backend.
   * Com F12 ON (omitir_nao_fiscal), não envia quantidade NF (ausência ≠ zero).
   */
  function itemConfirmacaoApi(l) {
    const item = itemConfirmacao(l);
    const omitirNf = !!l.omitir_nao_fiscal;
    item.modo_fiscal = l.modo_fiscal || (omitirNf ? '1' : '0');
    item.omitir_nao_fiscal = omitirNf;
    item.quantidade_fiscal_informada = l.quantidade_fiscal_informada != null
      ? l.quantidade_fiscal_informada
      : l.quantidade_fiscal_contada;
    if (l.unidade_informada) item.unidade_informada = l.unidade_informada;
    if (l.apresentacao_id != null) item.apresentacao_id = l.apresentacao_id;
    if (omitirNf) {
      delete item.quantidade_nao_fiscal_contada;
    } else {
      item.quantidade_nao_fiscal_informada = l.quantidade_nao_fiscal_informada != null
        ? l.quantidade_nao_fiscal_informada
        : l.quantidade_nao_fiscal_contada;
    }
    if (l.tipo_ajuste === 'BAIXA' || l.tipo_ajuste === 'ACRESCIMO') {
      item.tipo_ajuste = l.tipo_ajuste;
      item.operacao = 'AJUSTE_DIRECIONADO';
    } else {
      item.operacao = 'CONTAGEM_FISICA';
    }
    return item;
  }

  function incluirNaLista(linhas, preview, meta) {
    const copia = Array.isArray(linhas) ? linhas.slice() : [];
    if (!preview || preview.saldo_fiscal_esperado == null || preview.saldo_nao_fiscal_esperado == null) {
      return { ok: false, code: 'SNAPSHOT_AUSENTE', linhas: copia };
    }
    if (preview.saldo_insuficiente) {
      return { ok: false, code: 'SALDO_INSUFICIENTE', linhas: copia };
    }
    if (linhas.some(function (l) { return Number(l.produto_id) === Number(preview.produto_id); })) {
      const indice = copia.findIndex(function (l) {
        return Number(l.produto_id) === Number(preview.produto_id);
      });
      return { ok: false, code: 'PRODUTO_JA_NA_LISTA', indice: indice, linhas: copia };
    }
    copia.push(snapshotDaLinha(preview, meta || {}));
    return { ok: true, linhas: copia };
  }

  function atualizarLinhaPorPreview(linhasAtuais, indice, preview, meta) {
    const copia = Array.isArray(linhasAtuais) ? linhasAtuais.slice() : [];
    if (!Number.isInteger(indice) || indice < 0 || indice >= copia.length || !preview) {
      return { ok: false, code: 'LINHA_INVALIDA', linhas: copia };
    }
    const anterior = copia[indice];
    if (Number(preview.produto_id) !== Number(anterior.produto_id)) {
      return { ok: false, code: 'PRODUTO_DIVERGENTE', linhas: linhasAtuais.slice() };
    }
    copia[indice] = snapshotDaLinha(preview, meta || {
      nome: anterior.produto_nome,
      codigo: anterior.produto_codigo,
      apresentacao_id: anterior.apresentacao_id,
      unidade_base: anterior.unidade_base
    });
    return { ok: true, linhas: copia };
  }

  function removerDaLista(linhasAtuais, indice) {
    const copia = Array.isArray(linhasAtuais) ? linhasAtuais.slice() : [];
    if (indice >= 0 && indice < copia.length) copia.splice(indice, 1);
    return copia;
  }

  function limparSugestoes() {
    const box = document.getElementById('cef-produtos-sugestoes');
    if (box) {
      box.innerHTML = '';
      box.classList.add('d-none');
    }
  }

  function limparQuantidadesFormulario() {
    const qf = document.getElementById('cef-qf');
    const qnf = document.getElementById('cef-qnf');
    if (qf) qf.value = '';
    if (qnf) qnf.value = '';
  }

  function limparCalculoVisual() {
    previewAtual = null;
    const conv = document.getElementById('cef-conv-box');
    const diff = document.getElementById('cef-diff-box');
    if (conv) conv.innerHTML = '';
    if (diff) diff.innerHTML = '';
  }

  function mostrarErro(msg) {
    const box = document.getElementById('cef-erro');
    if (!box) return;
    if (!msg) {
      box.classList.add('d-none');
      box.textContent = '';
      return;
    }
    box.classList.remove('d-none');
    box.textContent = msg;
  }

  function definirProdutoSelecionado(item) {
    const anteriorId = produtoSelecionado ? produtoSelecionado.id : null;
    produtoSelecionado = item
      ? {
        id: Number(item.id || item.produto_id),
        nome: item.nome || '',
        codigo: item.codigo || item.codigo_interno || null,
        codigo_barras: item.codigo_barras || null,
        unidade: item.unidade_comercial || item.unidade || 'UN',
        unidade_comercial: item.unidade_comercial || item.unidade || 'UN',
        unidade_base: item.unidade_base || null,
        utiliza_conversao: !!item.utiliza_conversao,
        fator_conversao: item.fator_conversao != null ? item.fator_conversao : null,
        apresentacao_id: item.apresentacao_id != null ? Number(item.apresentacao_id) : null,
        apresentacoes: Array.isArray(item.apresentacoes) ? item.apresentacoes : []
      }
      : null;
    const mudou = !produtoSelecionado || produtoSelecionado.id !== anteriorId;
    if (mudou) {
      saldoConsulta = null;
      limparCalculoVisual();
      limparQuantidadesFormulario();
      mostrarErro('');
    }
    const input = document.getElementById('cef-produto-busca');
    const sel = document.getElementById('cef-produto-selecionado');
    if (input && produtoSelecionado && mudou) input.value = produtoSelecionado.nome;
    if (sel) {
      if (!produtoSelecionado) {
        sel.textContent = 'Nenhum produto selecionado. Selecione um produto na pesquisa para consultar o saldo atual.';
        sel.className = 'small text-muted mt-1';
      } else {
        sel.innerHTML = 'Selecionado: <strong>' + escapeHtml(produtoSelecionado.nome) + '</strong>';
        sel.className = 'small text-success mt-1';
      }
    }
    pintarCartaoProduto();
    limparSugestoes();
    if (produtoSelecionado && mudou) consultarSaldoSelecionado();
  }

  function aplicarVisibilidadeF12() {
    const wrapNf = document.getElementById('cef-wrap-qnf');
    const inputNf = document.getElementById('cef-qnf');
    const badge = document.getElementById('cef-f12-badge');
    const cardNf = document.getElementById('cef-card-nf');
    const labelQf = document.getElementById('cef-label-qf');
    const f12On = !!modoFiscalSessao;
    if (wrapNf) {
      if (f12On) wrapNf.classList.add('d-none');
      else wrapNf.classList.remove('d-none');
    }
    if (cardNf) {
      if (f12On) cardNf.classList.add('d-none');
      else cardNf.classList.remove('d-none');
    }
    if (inputNf && f12On) inputNf.value = '';
    if (labelQf) {
      if (operacaoForm === 'AJUSTE_DIRECIONADO') {
        labelQf.textContent = f12On
          ? 'Quantidade para ajuste'
          : 'Quantidade fiscal para ajuste';
      } else {
        labelQf.textContent = f12On
          ? 'Quantidade física encontrada'
          : 'Quantidade fiscal contada';
      }
    }
    const labelQnf = document.getElementById('cef-label-qnf');
    if (labelQnf) {
      labelQnf.textContent = operacaoForm === 'AJUSTE_DIRECIONADO'
        ? 'Quantidade não fiscal para ajuste'
        : 'Qtd não fiscal contada';
    }
    if (badge) {
      badge.textContent = f12On
        ? 'F12 ON — somente quantidade fiscal (saldo não fiscal preservado)'
        : 'F12 OFF — quantidades fiscal e não fiscal';
      badge.className = 'cef-chip ' + (f12On ? 'cef-chip--f12-on' : 'cef-chip--f12-off');
    }
  }

  function htmlBadgeDiferenca(valor, unidade) {
    const classe = classificarDiferenca(valor);
    if (!classe) return '<span class="text-muted">—</span>';
    const sinal = classe === 'baixa' ? 'cef-diff-valor cef-diff-valor--baixa'
      : (classe === 'acrescimo' ? 'cef-diff-valor cef-diff-valor--acrescimo' : 'cef-diff-valor cef-diff-valor--zero');
    return '<span class="' + classeBadge(classe) + '">' + escapeHtml(rotuloDiferenca(classe)) + '</span> '
      + '<span class="' + sinal + '">' + escapeHtml(formatarQtd(valor))
      + (unidade ? ' ' + escapeHtml(unidade) : '') + '</span>';
  }

  function pintarCartaoProduto() {
    const card = document.getElementById('cef-produto-card');
    if (!card) return;
    if (!produtoSelecionado) {
      card.classList.add('d-none');
      card.innerHTML = '';
      return;
    }
    const saldo = saldoConsulta
      && Number(saldoConsulta.produtoId) === Number(produtoSelecionado.id)
      ? saldoConsulta.data
      : null;
    const f12On = !!modoFiscalSessao;
    const nome = (saldo && saldo.nome) || produtoSelecionado.nome;
    const codigo = (saldo && (saldo.codigo || saldo.codigo_interno)) || produtoSelecionado.codigo;
    const unCom = (saldo && saldo.unidade_comercial) || produtoSelecionado.unidade_comercial || 'UN';
    const unBase = (saldo && saldo.unidade_base) || produtoSelecionado.unidade_base || '—';
    const fator = saldo && saldo.conversao_confiavel ? saldo.fator_conversao : null;
    const convTxt = fator != null
      ? ('1 ' + unCom + ' = ' + formatarQtd(fator) + ' ' + unBase)
      : (saldo && saldo.conversao_confiavel === false
        ? 'Conversão indisponível no cadastro'
        : 'Consultando…');
    const fiscalTxt = saldo
      ? (formatarQtd(saldo.saldo_fiscal_atual) + ' ' + (unBase === '—' ? '' : unBase))
      : 'Consultando saldo atual…';
    const nfTxt = saldo
      ? (formatarQtd(saldo.saldo_nao_fiscal_atual) + ' ' + (unBase === '—' ? '' : unBase))
      : 'Consultando saldo atual…';
    const apresentacoes = (saldo && Array.isArray(saldo.apresentacoes) && saldo.apresentacoes.length > 1)
      ? saldo.apresentacoes
      : (produtoSelecionado.apresentacoes || []);
    let selectHtml = '';
    if (apresentacoes.length > 1) {
      selectHtml = '<div class="cef-field mt-2"><label for="cef-apresentacao">Apresentação</label>'
        + '<select id="cef-apresentacao" class="form-select">'
        + apresentacoes.map(function (a) {
          const id = a.id != null ? String(a.id) : '';
          const selected = produtoSelecionado.apresentacao_id != null
            && Number(produtoSelecionado.apresentacao_id) === Number(a.id) ? ' selected' : '';
          const rotulo = (a.tipo || 'UN') + ' · ' + formatarQtd(a.quantidade) + ' ' + (a.unidade || '');
          return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(rotulo) + '</option>';
        }).join('')
        + '</select></div>';
    }
    card.classList.remove('d-none');
    card.innerHTML = '<h3>' + escapeHtml(nome || 'Produto') + '</h3>'
      + '<dl class="cef-meta">'
      + '<div><dt>Código</dt><dd>' + escapeHtml(codigo || '—') + '</dd></div>'
      + '<div><dt>Unidade comercial</dt><dd>' + escapeHtml(unCom) + '</dd></div>'
      + '<div><dt>Unidade-base</dt><dd>' + escapeHtml(unBase) + '</dd></div>'
      + '<div><dt>Conversão</dt><dd>' + escapeHtml(convTxt) + '</dd></div>'
      + '</dl>'
      + '<div class="cef-saldos"><div class="cef-saldo"><span>Saldo atual fiscal</span><strong>'
      + escapeHtml(fiscalTxt) + '</strong></div>'
      + '<div class="cef-saldo ' + (f12On ? 'd-none' : '') + '" id="cef-card-nf"><span>Saldo atual não fiscal</span><strong>'
      + escapeHtml(nfTxt) + '</strong></div></div>'
      + selectHtml;
    const selAp = document.getElementById('cef-apresentacao');
    if (selAp) {
      selAp.addEventListener('change', function () {
        const id = Number(selAp.value);
        const hit = apresentacoes.find(function (a) { return Number(a.id) === id; });
        produtoSelecionado.apresentacao_id = Number.isInteger(id) && id > 0 ? id : null;
        if (hit) {
          produtoSelecionado.fator_conversao = hit.quantidade;
          produtoSelecionado.unidade_base = hit.unidade || produtoSelecionado.unidade_base;
          if (hit.tipo) produtoSelecionado.unidade_comercial = hit.tipo;
        }
        limparCalculoVisual();
        agendarCalculo();
      });
    }
  }

  function pintarSeletorAjuste() {
    const box = document.getElementById('cef-tipo-ajuste');
    const btn = document.getElementById('cef-switch-ajuste');
    const rotulo = document.getElementById('cef-switch-rotulo');
    const direcionado = operacaoForm === 'AJUSTE_DIRECIONADO';
    const ligado = direcionado && tipoAjusteForm === 'ACRESCIMO';
    const rotuloTxt = ligado ? 'ACRÉSCIMO DE ESTOQUE' : 'BAIXA DE ESTOQUE';
    if (box) box.classList.toggle('d-none', !direcionado);
    if (btn) {
      btn.classList.toggle('is-on', ligado);
      btn.classList.toggle('is-off', direcionado && !ligado);
      btn.setAttribute('aria-pressed', ligado ? 'true' : 'false');
      btn.title = ligado
        ? 'ON: a quantidade informada será adicionada ao saldo atual.'
        : 'OFF: a quantidade informada será retirada do saldo atual.';
    }
    if (rotulo) {
      rotulo.innerHTML = ligado
        ? '<i class="fas fa-sign-in-alt" aria-hidden="true"></i> ' + rotuloTxt
        : '<i class="fas fa-sign-out-alt" aria-hidden="true"></i> ' + rotuloTxt;
    }
  }

  function resetarAjusteDirecionado() {
    operacaoForm = 'AJUSTE_DIRECIONADO';
    tipoAjusteForm = 'BAIXA';
    pintarSeletorAjuste();
    aplicarVisibilidadeF12();
  }

  function htmlTipoLinha(tipo) {
    if (tipo === 'BAIXA') {
      return '<span class="cef-badge cef-badge--baixa"><i class="fas fa-sign-out-alt" aria-hidden="true"></i> Baixa de estoque</span>';
    }
    if (tipo === 'ACRESCIMO') {
      return '<span class="cef-badge cef-badge--acrescimo"><i class="fas fa-sign-in-alt" aria-hidden="true"></i> Acréscimo de estoque</span>';
    }
    return '<span class="cef-badge">Contagem física</span>';
  }

  function htmlSaldoSeta(anterior, previsto, unidade) {
    if (previsto == null || previsto === '') return '<span class="text-muted">—</span>';
    const un = unidade ? (' ' + unidade) : '';
    return '<span class="cef-previsto">'
      + escapeHtml(formatarQtd(anterior) + un)
      + ' → '
      + escapeHtml(formatarQtd(previsto) + un)
      + '</span>';
  }

  function htmlMovimentoConvertido(tipo, valor, unidade) {
    if (valor == null || valor === '') return '<span class="text-muted">—</span>';
    const un = unidade ? (' ' + unidade) : '';
    if (tipo === 'BAIXA') {
      return '<span class="cef-movimento cef-movimento--baixa">−'
        + escapeHtml(formatarQtd(Math.abs(Number(valor))) + un) + '</span>';
    }
    if (tipo === 'ACRESCIMO') {
      return '<span class="cef-movimento cef-movimento--entrada">+'
        + escapeHtml(formatarQtd(Math.abs(Number(valor))) + un) + '</span>';
    }
    return escapeHtml(formatarQtd(valor) + un);
  }

  function pintarConversao(data) {
    const conv = document.getElementById('cef-conv-box');
    const diff = document.getElementById('cef-diff-box');
    if (!conv || !diff || !data) return;
    const un = data.unidade_base || '';
    let formula = '<strong>Conversão para o estoque</strong>';
    const fiscalTxt = textoConversao(data, 'fiscal');
    if (fiscalTxt) formula += '<p class="cef-formula" id="cef-conv-formula">' + escapeHtml(fiscalTxt) + '</p>';
    if (!data.omitir_nao_fiscal) {
      const nfTxt = textoConversao(data, 'nf');
      if (nfTxt) formula += '<p class="cef-formula">Não fiscal: ' + escapeHtml(nfTxt) + '</p>';
    } else {
      formula += '<p class="small text-muted mb-0">Não fiscal: não contado (F12 ON — saldo preservado).</p>';
    }
    conv.innerHTML = formula;
    if (data.operacao === 'AJUSTE_DIRECIONADO') {
      const tipoTxt = data.tipo_ajuste === 'ACRESCIMO' ? 'Acréscimo' : 'Baixa';
      let diffHtml = '<strong>' + escapeHtml(rotuloTipoAjuste(data.tipo_ajuste)) + '</strong>'
        + '<p class="mb-1">Tipo: ' + escapeHtml(tipoTxt) + '.</p>'
        + '<div>Fiscal: ' + htmlSaldoSeta(data.saldo_fiscal_anterior, data.saldo_fiscal_previsto, un) + '</div>'
        + '<div class="mt-1">Movimento: ' + htmlMovimentoConvertido(data.tipo_ajuste, data.quantidade_fiscal_contada, un) + '</div>';
      if (!data.omitir_nao_fiscal) {
        diffHtml += '<div class="mt-1"><span class="small text-muted">Não fiscal </span>'
          + htmlSaldoSeta(data.saldo_nao_fiscal_anterior, data.saldo_nao_fiscal_previsto, un) + '</div>';
      }
      diffHtml += '<p class="small text-muted mb-0 mt-1">Ajuste previsto. Aguardando confirmação.</p>';
      diff.innerHTML = diffHtml;
      return;
    }
    let diffHtml = '<strong>Diferença calculada</strong><div class="mt-1">'
      + htmlBadgeDiferenca(data.diferenca_fiscal, un) + '</div>';
    if (!data.omitir_nao_fiscal) {
      diffHtml += '<div class="mt-1"><span class="small text-muted">Não fiscal </span>'
        + htmlBadgeDiferenca(data.diferenca_nao_fiscal, un) + '</div>';
    }
    diffHtml += '<p class="small text-muted mb-0 mt-1">Ajuste previsto. Aguardando confirmação.</p>';
    diff.innerHTML = diffHtml;
  }

  function renderSugestoes(itens) {
    const box = document.getElementById('cef-produtos-sugestoes');
    if (!box) return;
    if (!itens || !itens.length) {
      box.classList.remove('d-none');
      box.innerHTML = '<div class="list-group-item text-muted small">'
        + 'Nenhum produto encontrado. Verifique o nome, código de barras ou código interno.'
        + '</div>';
      return;
    }
    box.classList.remove('d-none');
    box.innerHTML = itens.map(function (p) {
      return '<button type="button" class="list-group-item list-group-item-action py-2" data-cef-prod-id="'
        + escapeHtml(p.id) + '">'
        + '<div class="fw-semibold">' + escapeHtml(p.nome || '—') + '</div>'
        + '<div class="small text-muted">'
        + (p.codigo ? 'Cód. interno: ' + escapeHtml(p.codigo) + ' · ' : '')
        + (p.codigo_barras ? 'Barras: ' + escapeHtml(p.codigo_barras) + ' · ' : '')
        + 'Comercial: ' + escapeHtml(p.unidade_comercial || p.unidade || 'UN')
        + (p.unidade_base ? ' · Estoque: ' + escapeHtml(p.unidade_base) : '')
        + (p.fator_conversao != null && p.utiliza_conversao
          ? ' · Fator: ' + escapeHtml(p.fator_conversao)
          : '')
        + '</div></button>';
    }).join('');
    box.querySelectorAll('[data-cef-prod-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = Number(btn.getAttribute('data-cef-prod-id'));
        const hit = itens.find(function (x) { return Number(x.id) === id; });
        if (hit) definirProdutoSelecionado(hit);
      });
    });
  }

  async function pesquisarProdutos(termo) {
    const q = String(termo || '').trim();
    const seq = ++buscaSeq;
    if (q.length < 1) {
      limparSugestoes();
      return;
    }
    try {
      const res = await fetch(
        '/api/estoque/contagem-fisica/produtos-busca?q=' + encodeURIComponent(q) + '&limite=20',
        { method: 'GET', headers: authHeaders() }
      );
      const data = await res.json().catch(function () { return {}; });
      if (seq !== buscaSeq) return;
      if (res.status === 403) {
        notify(data.error || 'Acesso não autorizado à pesquisa de produtos.', 'warning');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Falha na pesquisa de produtos');
      renderSugestoes(Array.isArray(data.itens) ? data.itens : []);
    } catch (err) {
      if (seq !== buscaSeq) return;
      notify(err.message || 'Falha na pesquisa', 'danger');
    }
  }

  function agendarPesquisa() {
    const input = document.getElementById('cef-produto-busca');
    if (!input) return;
    if (produtoSelecionado && input.value.trim() !== produtoSelecionado.nome) {
      produtoSelecionado = null;
      saldoConsulta = null;
      limparCalculoVisual();
      pintarCartaoProduto();
      const sel = document.getElementById('cef-produto-selecionado');
      if (sel) {
        sel.textContent = 'Selecione um produto na pesquisa.';
        sel.className = 'small text-muted mt-1';
      }
    }
    if (buscaTimer) clearTimeout(buscaTimer);
    buscaTimer = setTimeout(function () {
      pesquisarProdutos(input.value);
    }, 280);
  }

  function lerCampoQuantidade(id) {
    const el = document.getElementById(id);
    if (!el || el.closest('.d-none')) return { ok: false, vazio: true };
    const raw = String(el.value == null ? '' : el.value).trim();
    if (raw === '') return { ok: false, vazio: true };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, invalido: true, raw: raw };
    return { ok: true, valor: raw, numero: n };
  }

  function corpoPreview(produto, qf, qnf, opts) {
    const optsNorm = opts || {};
    const f12On = optsNorm.omitirNaoFiscal != null ? !!optsNorm.omitirNaoFiscal : !!modoFiscalSessao;
    const body = {
      produto_id: Number(produto.id || produto.produto_id),
      quantidade_fiscal_informada: qf,
      unidade_informada: produto.unidade_comercial || produto.unidade_informada || produto.unidade,
      modo_fiscal: f12On ? '1' : '0',
      omitir_nao_fiscal: f12On
    };
    if (produto.apresentacao_id != null && produto.apresentacao_id !== '') {
      body.apresentacao_id = produto.apresentacao_id;
    }
    if (!f12On) body.quantidade_nao_fiscal_informada = qnf;
    const operacao = optsNorm.operacao
      || (optsNorm.tipoAjuste ? 'AJUSTE_DIRECIONADO' : operacaoForm);
    if (operacao === 'CONTAGEM_FISICA' || operacao === 'CONTAGEM') {
      body.operacao = 'CONTAGEM_FISICA';
    } else {
      body.operacao = 'AJUSTE_DIRECIONADO';
      body.tipo_ajuste = optsNorm.tipoAjuste || tipoAjusteForm || 'BAIXA';
    }
    return body;
  }

  function contextoOperacaoDaLinha(linha, tipoOverride) {
    if (tipoOverride === 'BAIXA' || tipoOverride === 'ACRESCIMO') {
      return { operacao: 'AJUSTE_DIRECIONADO', tipoAjuste: tipoOverride };
    }
    if (linha && (linha.tipo_ajuste === 'BAIXA' || linha.tipo_ajuste === 'ACRESCIMO')) {
      return { operacao: 'AJUSTE_DIRECIONADO', tipoAjuste: linha.tipo_ajuste };
    }
    return { operacao: 'CONTAGEM_FISICA', tipoAjuste: null };
  }

  function mensagemSaldoUi(data) {
    if (!data || !data.saldo_insuficiente) return '';
    const un = data.unidade_base ? (' ' + data.unidade_base) : '';
    const partes = [];
    if (data.saldo_insuficiente_fiscal) {
      partes.push(
        'Saldo fiscal insuficiente para a baixa. Disponível: '
        + formatarQtd(data.saldo_disponivel_fiscal) + un
        + '. Solicitado: ' + formatarQtd(data.quantidade_solicitada_fiscal) + un + '.'
      );
    }
    if (data.saldo_insuficiente_nao_fiscal) {
      partes.push(
        'Saldo não fiscal insuficiente para a baixa. Disponível: '
        + formatarQtd(data.saldo_disponivel_nao_fiscal) + un
        + '. Solicitado: ' + formatarQtd(data.quantidade_solicitada_nao_fiscal) + un + '.'
      );
    }
    return partes.join(' ');
  }

  async function postPreview(body) {
    const res = await fetch('/api/estoque/contagem-fisica/preview', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(function () { return {}; });
    if (res.status === 403) throw new Error(data.error || 'Acesso não autorizado.');
    if (!res.ok) {
      const err = new Error(data.error || 'Falha no preview');
      err.code = data.code || null;
      throw err;
    }
    return data;
  }

  async function consultarSaldoSelecionado() {
    if (!produtoSelecionado) return;
    const produtoId = produtoSelecionado.id;
    const seq = ++saldoSeq;
    saldoConsulta = null;
    pintarCartaoProduto();
    try {
      const res = await fetch(
        '/api/estoque/contagem-fisica/saldo-atual?produto_id=' + encodeURIComponent(produtoId),
        { method: 'GET', headers: authHeaders() }
      );
      const data = await res.json().catch(function () { return {}; });
      if (!calculoAindaValido({
        seqResposta: seq,
        seqAtual: saldoSeq,
        produtoResposta: produtoId,
        produtoAtual: produtoSelecionado && produtoSelecionado.id
      })) return;
      if (!res.ok) throw new Error(data.error || 'Falha ao consultar o saldo atual');
      saldoConsulta = { produtoId: produtoId, data: data };
      if (data.unidade_comercial) produtoSelecionado.unidade_comercial = data.unidade_comercial;
      if (data.unidade_base) produtoSelecionado.unidade_base = data.unidade_base;
      produtoSelecionado.utiliza_conversao = !!data.utiliza_conversao;
      produtoSelecionado.fator_conversao = data.fator_conversao;
      produtoSelecionado.apresentacoes = Array.isArray(data.apresentacoes) ? data.apresentacoes : [];
      if (data.apresentacao_id != null && produtoSelecionado.apresentacao_id == null) {
        produtoSelecionado.apresentacao_id = Number(data.apresentacao_id);
      }
      if (data.codigo) produtoSelecionado.codigo = data.codigo;
      if (data.nome) produtoSelecionado.nome = data.nome;
      pintarCartaoProduto();
      if (data.conversao_confiavel === false) {
        limparCalculoVisual();
        mostrarErro('A conversão deste produto precisa ser revisada no cadastro. Nenhum cálculo foi gerado.');
        return;
      }
      mostrarErro('');
      agendarCalculo();
    } catch (err) {
      if (!calculoAindaValido({
        seqResposta: seq,
        seqAtual: saldoSeq,
        produtoResposta: produtoId,
        produtoAtual: produtoSelecionado && produtoSelecionado.id
      })) return;
      mostrarErro(err.message || 'Falha ao consultar o saldo atual');
    }
  }

  function agendarCalculo() {
    if (calcTimer) clearTimeout(calcTimer);
    calcTimer = setTimeout(function () {
      calcularTempoReal();
    }, 280);
  }

  async function calcularTempoReal() {
    if (modoFiscalMudou()) {
      const msg = 'O estado F12 mudou desde a abertura desta tela. Clique em "Atualizar contexto F12" e refaça a pré-visualização.';
      mostrarErro(msg);
      return null;
    }
    if (!produtoSelecionado || !Number.isInteger(produtoSelecionado.id)) return null;
    if (saldoConsulta && saldoConsulta.data && saldoConsulta.data.conversao_confiavel === false) {
      limparCalculoVisual();
      mostrarErro('A conversão deste produto precisa ser revisada no cadastro. Nenhum cálculo foi gerado.');
      return null;
    }
    const qf = lerCampoQuantidade('cef-qf');
    const f12On = !!modoFiscalSessao;
    const qnf = f12On ? { ok: true, valor: null } : lerCampoQuantidade('cef-qnf');
    if (qf.vazio || (!f12On && qnf.vazio)) {
      limparCalculoVisual();
      return null;
    }
    if (qf.invalido || qnf.invalido) {
      limparCalculoVisual();
      mostrarErro('Informe uma quantidade física maior ou igual a zero.');
      return null;
    }
    const produtoId = produtoSelecionado.id;
    const seq = ++calcSeq;
    const body = corpoPreview(produtoSelecionado, qf.valor, qnf.valor);
    try {
      const data = await postPreview(body);
      const valido = calculoAindaValido({
        seqResposta: seq,
        seqAtual: calcSeq,
        produtoResposta: produtoId,
        produtoAtual: produtoSelecionado && produtoSelecionado.id
      });
      if (!valido || Number(data.produto_id) !== Number(produtoId)) return null;
      data.produto_nome = produtoSelecionado.nome;
      data.produto_codigo = produtoSelecionado.codigo;
      previewAtual = {
        produtoId: produtoId,
        qf: qf.valor,
        qnf: f12On ? null : qnf.valor,
        apresentacaoId: produtoSelecionado.apresentacao_id || null,
        data: data
      };
      mostrarErro(data.saldo_insuficiente ? mensagemSaldoUi(data) : '');
      pintarConversao(data);
      const box = document.getElementById('cef-preview-box');
      if (box) {
        box.textContent = 'Diferenças calculadas. Aguardando confirmação.';
      }
      return data;
    } catch (err) {
      if (Number(seq) !== Number(calcSeq)) return null;
      limparCalculoVisual();
      mostrarErro(err.message || 'Não foi possível calcular a diferença.');
      return null;
    }
  }

  async function previewLinha() {
    const data = await calcularTempoReal();
    return data;
  }

  function previewAtualCompativel() {
    if (!previewAtual || !produtoSelecionado || !previewAtual.data) return false;
    if (Number(previewAtual.produtoId) !== Number(produtoSelecionado.id)) return false;
    if (Number(previewAtual.data.produto_id) !== Number(produtoSelecionado.id)) return false;
    const qf = lerCampoQuantidade('cef-qf');
    if (!qf.ok || !mesmaQuantidade(previewAtual.qf, qf.valor)) return false;
    if (!modoFiscalSessao) {
      const qnf = lerCampoQuantidade('cef-qnf');
      if (!qnf.ok || !mesmaQuantidade(previewAtual.qnf, qnf.valor)) return false;
    }
    const ap = produtoSelecionado.apresentacao_id || null;
    if (Number(previewAtual.apresentacaoId || 0) !== Number(ap || 0)) return false;
    const opPreview = previewAtual.data.operacao || 'CONTAGEM_FISICA';
    if (opPreview !== operacaoForm) return false;
    if (operacaoForm === 'AJUSTE_DIRECIONADO' && previewAtual.data.tipo_ajuste !== tipoAjusteForm) return false;
    return true;
  }

  function render() {
    const rootEl = document.getElementById('page-content');
    if (!rootEl) return;

    if (!podeAcessarContagem()) {
      rootEl.innerHTML = `
        <div class="container-fluid py-3">
          <div class="alert alert-warning" role="alert">
            <strong>Acesso não autorizado.</strong>
            Contagem Física exige perfil autorizado a ajustar estoque (ADMIN ou SUPER_ADMIN).
            Nenhuma movimentação foi realizada.
          </div>
        </div>`;
      return;
    }

    sincronizarModoFiscalSessao();
    const empLabel = empresaLabelAtual();
    const tipoEmp = rotuloTipoEmpresa(empresaAtual());
    const f12On = !!modoFiscalSessao;
    rootEl.innerHTML = `
      <div class="cef-page" data-cef-layout="proposta-2">
        <header class="cef-header">
          <div>
            <h2 class="cef-title">Contagem Física</h2>
            <p class="cef-sub">Conferência, ajuste e controle do estoque</p>
          </div>
          <div class="cef-chips">
            <span class="cef-chip" id="cef-empresa"><i class="fas fa-building" aria-hidden="true"></i> ${escapeHtml(empLabel)}</span>
            ${tipoEmp ? '<span class="cef-chip" id="cef-tipo-empresa">' + escapeHtml(tipoEmp) + '</span>' : '<span class="cef-chip d-none" id="cef-tipo-empresa"></span>'}
            <span class="cef-chip" id="cef-modo-estoque">Modo de estoque…</span>
            <span id="cef-f12-badge" class="cef-chip ${f12On ? 'cef-chip--f12-on' : 'cef-chip--f12-off'}">${
              f12On
                ? 'F12 ON — somente quantidade fiscal (saldo não fiscal preservado)'
                : 'F12 OFF — quantidades fiscal e não fiscal'
            }</span>
          </div>
        </header>
        <div id="cef-alerta-periodicidade" class="alert alert-secondary cef-alerta d-none" role="status"></div>
        <div id="cef-alerta-pendencias" class="alert alert-info cef-alerta d-none" role="status"></div>
        <div id="cef-alerta-desatualizada" class="alert alert-warning cef-alerta d-none" role="alert"></div>
        <section class="cef-card cef-programacao">
          <h3 class="cef-card-title">Programação da contagem</h3>
          <p class="small text-muted mb-2">Periodicidade da contagem (informativo). Não impede contagens fora da data. Serve para organização e acompanhamento.</p>
          <div class="row g-2 align-items-end">
            <div class="col-md-4 cef-field">
              <label class="form-label" for="cef-periodicidade">Periodicidade</label>
              <select id="cef-periodicidade" class="form-select">
                <option value="SEMANAL">Semanal (7 dias)</option>
                <option value="QUINZENAL">Quinzenal (15 dias)</option>
                <option value="SOB_DEMANDA">Sob demanda</option>
              </select>
            </div>
            <div class="col-md-3">
              <div class="form-check mt-4">
                <input class="form-check-input" type="checkbox" id="cef-period-ativo" checked>
                <label class="form-check-label" for="cef-period-ativo">Alertas ativos</label>
              </div>
            </div>
            <div class="col-md-5">
              <button type="button" class="btn btn-outline-primary" id="cef-salvar-periodicidade">Salvar periodicidade</button>
              <button type="button" class="btn btn-outline-secondary" id="cef-atualizar-status">Atualizar status</button>
            </div>
          </div>
          <div id="cef-period-detalhes" class="small mt-3 text-muted"></div>
        </section>
        <div class="cef-workspace">
          <section class="cef-card cef-form">
            <div class="cef-form-head">
              <h3 class="cef-card-title">Incluir produto</h3>
              <div class="cef-tipo-ajuste" id="cef-tipo-ajuste">
                <span class="cef-tipo-legenda" id="cef-tipo-legenda">Tipo de ajuste</span>
                <button type="button" class="cef-switch is-off" id="cef-switch-ajuste" aria-pressed="false"
                  aria-labelledby="cef-tipo-legenda cef-switch-rotulo">
                  <span class="cef-switch-knob" aria-hidden="true"></span>
                  <span class="cef-switch-text" id="cef-switch-rotulo"><i class="fas fa-sign-out-alt" aria-hidden="true"></i> BAIXA DE ESTOQUE</span>
                </button>
              </div>
            </div>
            <div class="cef-field cef-busca">
              <label class="form-label" for="cef-produto-busca">Pesquisar produto</label>
              <input id="cef-produto-busca" class="form-control" type="text" autocomplete="off"
                placeholder="Digite o nome, código de barras ou código interno">
              <div id="cef-produtos-sugestoes" class="list-group cef-sugestoes position-absolute w-100 shadow-sm d-none"></div>
              <div id="cef-produto-selecionado" class="small text-muted mt-1">Nenhum produto selecionado. Selecione um produto na pesquisa para consultar o saldo atual.</div>
            </div>
            <div id="cef-produto-card" class="cef-produto-card d-none"></div>
            <div class="row g-2 mt-2">
              <div class="col-sm-6 cef-field">
                <label class="form-label" id="cef-label-qf" for="cef-qf">${f12On ? 'Quantidade física encontrada' : 'Quantidade fiscal contada'}</label>
                <input id="cef-qf" class="form-control" type="number" min="0" step="0.000001" inputmode="decimal" placeholder="Ex.: 10">
              </div>
              <div class="col-sm-6 cef-field ${f12On ? 'd-none' : ''}" id="cef-wrap-qnf">
                <label class="form-label" id="cef-label-qnf" for="cef-qnf">Qtd não fiscal contada</label>
                <input id="cef-qnf" class="form-control" type="number" min="0" step="0.000001" inputmode="decimal" placeholder="Ex.: 10">
              </div>
            </div>
            <div id="cef-conv-box" class="cef-conv"></div>
            <div id="cef-diff-box" class="cef-diff"></div>
            <div id="cef-preview-box" class="visually-hidden"></div>
            <div id="cef-erro" class="cef-erro d-none" role="alert"></div>
            <div class="cef-actions">
              <button type="button" class="btn cef-btn-incluir" id="cef-add">Incluir na lista</button>
              <button type="button" class="btn btn-link btn-sm" id="cef-atualizar-f12">Atualizar contexto F12</button>
            </div>
          </section>
          <section class="cef-card cef-lista">
            <h3 class="cef-card-title">Produtos da contagem</h3>
            <div id="cef-resumo" class="cef-resumo"></div>
            <div class="cef-table-wrap">
              <table class="table table-sm align-middle cef-table">
                <thead><tr id="cef-thead"></tr></thead>
                <tbody id="cef-tbody"></tbody>
              </table>
            </div>
            <div class="cef-field mt-2">
              <label class="form-label" for="cef-obs">Observação da contagem (opcional)</label>
              <input id="cef-obs" class="form-control" maxlength="500">
            </div>
            <button type="button" class="btn cef-btn-confirmar" id="cef-confirmar">Confirmar contagem</button>
            <button type="button" class="btn btn-outline-warning d-none mt-2" id="cef-atualizar-preview">Atualizar pré-visualização</button>
            <div id="cef-resultado" class="mt-3"></div>
            <div class="cef-historico">
              <h3 class="cef-card-title">Histórico recente</h3>
              <div class="cef-table-wrap">
                <table class="table table-sm cef-table">
                  <thead><tr>
                    <th>ID</th><th>Data</th><th>Operador</th><th>Produtos</th><th>Resultado</th>
                  </tr></thead>
                  <tbody id="cef-historico-tbody"></tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>`;
    document.getElementById('cef-add').addEventListener('click', adicionarLinha);
    document.getElementById('cef-confirmar').addEventListener('click', confirmar);
    document.getElementById('cef-atualizar-preview').addEventListener('click', atualizarPreviewsDaLista);
    document.getElementById('cef-salvar-periodicidade').addEventListener('click', salvarPeriodicidade);
    document.getElementById('cef-atualizar-status').addEventListener('click', carregarStatusPeriodicidade);
    const btnF12 = document.getElementById('cef-atualizar-f12');
    if (btnF12) {
      btnF12.addEventListener('click', function () {
        sincronizarModoFiscalSessao();
        saldoConsulta = null;
        limparCalculoVisual();
        aplicarVisibilidadeF12();
        pintarTabela();
        if (produtoSelecionado) consultarSaldoSelecionado();
        if (linhas.length) {
          aguardandoNovoPreview = true;
          const alertaF12 = document.getElementById('cef-alerta-desatualizada');
          if (alertaF12) {
            alertaF12.innerHTML = '<strong>O estado F12 mudou.</strong> '
              + 'Atualize a pré-visualização, revise as diferenças e confirme novamente.';
          }
          sincronizarEstadoConflito();
          notify('Contexto F12 atualizado. Atualize a pré-visualização antes de confirmar.', 'warning');
        }
      });
    }
    aplicarVisibilidadeF12();
    pintarSeletorAjuste();
    const btnSwitch = document.getElementById('cef-switch-ajuste');
    if (btnSwitch) {
      btnSwitch.addEventListener('click', function () {
        tipoAjusteForm = tipoAjusteForm === 'ACRESCIMO' ? 'BAIXA' : 'ACRESCIMO';
        pintarSeletorAjuste();
        limparCalculoVisual();
        agendarCalculo();
      });
    }
    const busca = document.getElementById('cef-produto-busca');
    if (busca) {
      busca.addEventListener('input', agendarPesquisa);
      busca.addEventListener('focus', function () {
        if (busca.value.trim().length >= 1 && !produtoSelecionado) pesquisarProdutos(busca.value);
      });
      busca.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') limparSugestoes();
      });
    }
    const qf = document.getElementById('cef-qf');
    const qnf = document.getElementById('cef-qnf');
    if (qf) qf.addEventListener('input', function () { limparCalculoVisual(); agendarCalculo(); });
    if (qnf) qnf.addEventListener('input', function () { limparCalculoVisual(); agendarCalculo(); });
    if (!listenerSugestoesDoc) {
      listenerSugestoesDoc = true;
      document.addEventListener('click', function onDocClick(ev) {
        const wrap = document.getElementById('cef-produtos-sugestoes');
        const inp = document.getElementById('cef-produto-busca');
        if (!wrap || !inp) return;
        if (wrap.contains(ev.target) || inp.contains(ev.target)) return;
        limparSugestoes();
      });
    }
    pintarTabela();
    sincronizarEstadoConflito();
    carregarPendenciasEntrada();
    carregarStatusPeriodicidade();
    carregarHistorico();
    carregarModoEstoque();
  }

  async function carregarModoEstoque() {
    const badge = document.getElementById('cef-modo-estoque');
    if (!badge) return;
    const id = empresaIdAtual();
    if (id == null) {
      badge.textContent = 'Modo de estoque indisponível';
      return;
    }
    try {
      const res = await fetch('/api/empresas/' + encodeURIComponent(id) + '/configuracao-estoque', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.modo) throw new Error(data.error || 'Modo indisponível');
      const manual = String(data.modo).toUpperCase() === 'MANUAL';
      badge.textContent = manual ? 'MANUAL' : 'AUTOMÁTICO';
      badge.className = 'cef-chip ' + (manual ? 'cef-chip--manual' : 'cef-chip--auto');
    } catch (_) {
      badge.textContent = 'Modo de estoque indisponível';
    }
  }

  function formatarBrData(iso) {
    if (!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(iso);
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  async function carregarStatusPeriodicidade() {
    const alerta = document.getElementById('cef-alerta-periodicidade');
    const detalhes = document.getElementById('cef-period-detalhes');
    const sel = document.getElementById('cef-periodicidade');
    const chk = document.getElementById('cef-period-ativo');
    if (!alerta) return;
    try {
      const res = await fetch('/api/estoque/contagem-fisica/status-periodicidade', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 403) {
        alerta.classList.remove('d-none');
        alerta.className = 'alert alert-warning cef-alerta';
        alerta.textContent = data.error || 'Acesso não autorizado.';
        return;
      }
      if (!res.ok || data.consulta_disponivel === false) {
        alerta.classList.remove('d-none');
        alerta.className = 'alert alert-secondary cef-alerta';
        alerta.textContent = data.error
          || 'Não foi possível consultar a periodicidade. Não assumindo situação em dia.';
        return;
      }
      if (sel && data.configuracao) sel.value = data.configuracao.periodicidade || 'SEMANAL';
      if (chk && data.configuracao) chk.checked = data.configuracao.ativo !== false;
      const cls = data.status === 'ATRASADA'
        ? 'alert alert-warning cef-alerta'
        : (data.status === 'PROXIMA_DO_VENCIMENTO' || data.status === 'PRIMEIRA_CONTAGEM_PENDENTE'
          ? 'alert alert-info cef-alerta'
          : 'alert alert-secondary cef-alerta');
      alerta.classList.remove('d-none');
      alerta.className = cls;
      alerta.innerHTML = '<strong>' + escapeHtml(data.status || '—') + '</strong> — '
        + escapeHtml(data.mensagem || '')
        + ' <span class="small">(a contagem continua disponível a qualquer momento)</span>';
      if (detalhes) {
        detalhes.innerHTML = 'Última contagem: <strong>'
          + formatarBrData(data.ultima_contagem_data)
          + '</strong> · Próxima prevista: <strong>'
          + (data.proxima_contagem_data ? formatarBrData(data.proxima_contagem_data) : 'sem vencimento')
          + '</strong> · Periodicidade: <strong>'
          + escapeHtml((data.configuracao && data.configuracao.periodicidade) || '—')
          + '</strong>';
      }
    } catch (err) {
      alerta.classList.remove('d-none');
      alerta.className = 'alert alert-secondary cef-alerta';
      alerta.textContent = 'Não foi possível consultar a periodicidade. Não assumindo situação em dia.';
    }
  }

  async function salvarPeriodicidade() {
    const sel = document.getElementById('cef-periodicidade');
    const chk = document.getElementById('cef-period-ativo');
    try {
      const res = await fetch('/api/estoque/contagem-fisica/periodicidade', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          periodicidade: sel ? sel.value : 'SEMANAL',
          ativo: chk ? !!chk.checked : true
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha ao salvar periodicidade');
      notify('Periodicidade atualizada.', 'success');
      await carregarStatusPeriodicidade();
    } catch (err) {
      notify(err.message, 'danger');
    }
  }

  async function carregarHistorico() {
    const tb = document.getElementById('cef-historico-tbody');
    if (!tb) return;
    try {
      const res = await fetch('/api/estoque/contagem-fisica/historico?limite=15', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha no histórico');
      const itens = Array.isArray(data.itens) ? data.itens : [];
      tb.innerHTML = itens.map(function (h) {
        return '<tr><td>' + escapeHtml(h.id)
          + '</td><td>' + escapeHtml(h.criado_em || '—')
          + '</td><td>' + escapeHtml(h.usuario_nome || h.usuario_id || '—')
          + '</td><td>' + escapeHtml(h.quantidade_produtos)
          + '</td><td>' + escapeHtml(h.resultado || 'CONFIRMADA')
          + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="text-muted">Nenhuma contagem confirmada ainda.</td></tr>';
    } catch (err) {
      tb.innerHTML = '<tr><td colspan="5" class="text-muted">'
        + escapeHtml(err.message || 'Histórico indisponível') + '</td></tr>';
    }
  }

  function formatarDataCurta(valor) {
    if (!valor) return '—';
    const s = String(valor);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  /**
   * Alerta informativo — não bloqueia confirmação e não altera estoque/snapshot.
   */
  async function carregarPendenciasEntrada() {
    const box = document.getElementById('cef-alerta-pendencias');
    if (!box) return;
    box.classList.add('d-none');
    box.innerHTML = '';
    const emp = empresaIdAtual();
    if (emp == null) {
      box.classList.remove('d-none');
      box.className = 'alert alert-secondary cef-alerta';
      box.textContent = 'Selecione a empresa do contexto para verificar entradas pendentes na Central.';
      return;
    }
    try {
      const res = await fetch('/api/estoque/contagem-fisica/pendencias-entrada', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.consulta_disponivel === false) {
        box.classList.remove('d-none');
        box.className = 'alert alert-secondary cef-alerta';
        box.innerHTML = '<strong>Não foi possível verificar as entradas pendentes.</strong> '
          + escapeHtml(data.error || 'Tente novamente ou consulte a Central Inteligente.')
          + ' Esta falha <em>não</em> significa ausência de documentos.';
        return;
      }
      const total = Number(data.total_pendentes_conversao || 0);
      const naoConf = Number(data.total_nao_confirmadas || 0);
      if (total <= 0 && naoConf <= 0) {
        box.classList.add('d-none');
        return;
      }
      const fornecedores = Array.isArray(data.fornecedores) ? data.fornecedores : [];
      const lista = Array.isArray(data.pendentes_conversao) ? data.pendentes_conversao : [];
      const linhasHtml = lista.slice(0, 8).map(function (doc) {
        return '<li><strong>NF '
          + escapeHtml(doc.numero || '—')
          + (doc.serie ? '/' + escapeHtml(doc.serie) : '')
          + '</strong> · '
          + escapeHtml(doc.fornecedor || 'Fornecedor não informado')
          + ' · recebida '
          + escapeHtml(formatarDataCurta(doc.data_recebimento))
          + ' · status <em>'
          + escapeHtml(doc.status_label || doc.status || '—')
          + '</em>'
          + (doc.chave_curta ? ' · chave ' + escapeHtml(doc.chave_curta) : '')
          + '</li>';
      }).join('');
      box.classList.remove('d-none');
      box.className = 'alert alert-warning cef-alerta';
      box.innerHTML = '<div class="cef-pend-head"><strong>ATENÇÃO — EXISTEM ENTRADAS PENDENTES</strong>'
        + '<span>' + total + ' documento(s) sem compra registrada.</span>'
        + '<button type="button" class="btn btn-sm btn-outline-secondary" id="cef-pendencias-toggle">Expandir detalhes</button>'
        + '</div>'
        + '<p class="mb-1 mt-2 small">Este aviso <strong>não bloqueia</strong> a confirmação.</p>'
        + '<div id="cef-pendencias-detalhes" class="d-none">'
        + '<p class="mb-2 mt-2">Foram encontrados <strong>'
        + total
        + '</strong> documento(s) fiscal(is) recebidos pela Central Inteligente que ainda '
        + '<strong>não possuem compra efetivamente registrada</strong>. '
        + 'Esses documentos <strong>ainda não representam crédito de estoque</strong>.</p>'
        + (fornecedores.length
          ? '<p class="mb-1 small">Fornecedores: <strong>'
            + escapeHtml(fornecedores.join(', '))
            + '</strong></p>'
          : '')
        + (naoConf > 0
          ? '<p class="mb-1 small text-muted">' + naoConf
            + ' documento(s) em situação não confirmada (ex.: em importação/erro) — verifique na Central.</p>'
          : '')
        + (linhasHtml ? '<ul class="mb-2 small">' + linhasHtml + '</ul>' : '')
        + '<p class="mb-2 small">Verifique as entradas pendentes antes de confirmar sua contagem física.</p>'
        + '</div>'
        + '<button type="button" class="btn btn-sm btn-outline-primary" id="cef-abrir-central">'
        + 'Abrir Central Inteligente</button> '
        + '<button type="button" class="btn btn-sm btn-outline-secondary" id="cef-atualizar-pendencias">'
        + 'Atualizar alerta</button>';
      const toggle = document.getElementById('cef-pendencias-toggle');
      const detalhes = document.getElementById('cef-pendencias-detalhes');
      if (toggle && detalhes) {
        toggle.addEventListener('click', function () {
          const aberto = !detalhes.classList.contains('d-none');
          if (aberto) {
            detalhes.classList.add('d-none');
            toggle.textContent = 'Expandir detalhes';
          } else {
            detalhes.classList.remove('d-none');
            toggle.textContent = 'Recolher detalhes';
          }
        });
      }
      const btnCentral = document.getElementById('cef-abrir-central');
      if (btnCentral) {
        btnCentral.addEventListener('click', function () {
          if (typeof root.loadPage === 'function') root.loadPage('central-entradas');
        });
      }
      const btnAtt = document.getElementById('cef-atualizar-pendencias');
      if (btnAtt) btnAtt.addEventListener('click', carregarPendenciasEntrada);
    } catch (err) {
      box.classList.remove('d-none');
      box.className = 'alert alert-secondary cef-alerta';
      box.innerHTML = '<strong>Não foi possível verificar as entradas pendentes.</strong> '
        + escapeHtml(err && err.message ? err.message : 'Erro de rede.')
        + ' Esta falha <em>não</em> significa ausência de documentos.';
    }
  }

  function sincronizarEstadoConflito() {
    const alerta = document.getElementById('cef-alerta-desatualizada');
    const btnAtualizar = document.getElementById('cef-atualizar-preview');
    const btnConfirmar = document.getElementById('cef-confirmar');
    if (!alerta || !btnAtualizar || !btnConfirmar) return;
    if (aguardandoNovoPreview) {
      alerta.classList.remove('d-none');
      btnAtualizar.classList.remove('d-none');
      btnConfirmar.disabled = true;
    } else {
      alerta.classList.add('d-none');
      btnAtualizar.classList.add('d-none');
      btnConfirmar.disabled = false;
    }
  }

  function pintarResumo() {
    const box = document.getElementById('cef-resumo');
    if (!box) return;
    const r = resumoContagem(linhas);
    const d = resumoDirecionado(linhas);
    let totais = '';
    Object.keys(d.por_unidade).forEach(function (unidade) {
      const item = d.por_unidade[unidade];
      totais += '<span class="cef-total-un">'
        + escapeHtml(unidade) + ': baixa fiscal '
        + escapeHtml(formatarQtd(item.baixa_fiscal))
        + ' · acréscimo fiscal '
        + escapeHtml(formatarQtd(item.acrescimo_fiscal));
      if (!modoFiscalSessao) {
        totais += ' · baixa não fiscal '
          + escapeHtml(formatarQtd(item.baixa_nao_fiscal))
          + ' · acréscimo não fiscal '
          + escapeHtml(formatarQtd(item.acrescimo_nao_fiscal));
      }
      totais += '</span>';
    });
    box.innerHTML = '<div class="cef-kpi"><strong>' + r.produtos_adicionados
      + '</strong><span>Produtos adicionados</span></div>'
      + '<div class="cef-kpi"><strong>' + d.baixas
      + '</strong><span>Baixas</span></div>'
      + '<div class="cef-kpi"><strong>' + d.acrescimos
      + '</strong><span>Acréscimos</span></div>'
      + '<div class="cef-kpi"><strong>' + r.produtos_com_diferenca
      + '</strong><span>Produtos com diferença</span></div>'
      + '<div class="cef-kpi"><strong>' + r.produtos_sem_diferenca
      + '</strong><span>Produtos sem diferença</span></div>'
      + (totais ? '<p class="cef-resumo-nota mb-0">' + totais + '</p>' : '')
      + '<p class="cef-resumo-nota mb-0">Empresa: ' + escapeHtml(empresaLabelAtual())
      + ' · ' + (modoFiscalSessao ? 'F12 ON' : 'F12 OFF')
      + ' · Diferenças calculadas · Ajustes previstos · Aguardando confirmação.</p>';
  }

  function pintarTabela() {
    const tb = document.getElementById('cef-tbody');
    const th = document.getElementById('cef-thead');
    if (!tb) return;
    const f12On = !!modoFiscalSessao;
    if (th) {
      th.innerHTML = '<th>Produto</th><th>Qtd comercial</th><th>Convertida</th><th>Tipo de ajuste</th>'
        + '<th>Saldo anterior</th><th>Saldo previsto</th><th>Diferença</th><th></th>';
    }
    pintarResumo();
    if (!linhas.length) {
      tb.innerHTML = '<tr><td colspan="8"><p class="cef-empty mb-0">Nenhum produto na contagem. '
        + 'Pesquise um produto, informe a quantidade e inclua na lista. Aguardando confirmação.</p></td></tr>';
      return;
    }
    tb.innerHTML = linhas.map(function (l, idx) {
      const un = l.unidade_base || '';
      const editando = editandoIndice === idx;
      const comercial = editando
        ? '<input class="form-control form-control-sm" type="number" min="0" step="0.000001" data-cef-edit-qf="'
          + idx + '" value="' + escapeHtml(l.quantidade_fiscal_informada != null ? l.quantidade_fiscal_informada : '') + '">'
          + (f12On || l.omitir_nao_fiscal ? ''
            : '<input class="form-control form-control-sm mt-1" type="number" min="0" step="0.000001" data-cef-edit-qnf="'
              + idx + '" value="' + escapeHtml(l.quantidade_nao_fiscal_informada != null ? l.quantidade_nao_fiscal_informada : '') + '">')
        : (escapeHtml(formatarQtd(l.quantidade_fiscal_informada)) + ' ' + escapeHtml(l.unidade_informada || '')
          + (f12On || l.omitir_nao_fiscal ? ''
            : '<div class="small text-muted">NF ' + escapeHtml(formatarQtd(l.quantidade_nao_fiscal_informada))
              + ' ' + escapeHtml(l.unidade_informada || '') + '</div>'));
      const saldo = formatarQtd(l.saldo_fiscal_esperado) + ' ' + un
        + (f12On ? '' : '<div class="small text-muted">NF ' + formatarQtd(l.saldo_nao_fiscal_esperado) + ' ' + escapeHtml(un) + '</div>');
      const previsto = htmlSaldoSeta(l.saldo_fiscal_esperado, l.saldo_fiscal_previsto, un)
        + (f12On || l.omitir_nao_fiscal
          ? ''
          : '<div class="mt-1">' + htmlSaldoSeta(l.saldo_nao_fiscal_esperado, l.saldo_nao_fiscal_previsto, un) + '</div>');
      const convertida = l.tipo_ajuste
        ? htmlMovimentoConvertido(l.tipo_ajuste, l.quantidade_fiscal_contada, un)
          + (f12On || l.omitir_nao_fiscal
            ? ''
            : '<div class="mt-1">' + htmlMovimentoConvertido(l.tipo_ajuste, l.quantidade_nao_fiscal_contada, un) + '</div>')
        : (formatarQtd(l.quantidade_fiscal_contada) + ' ' + un
          + (f12On || l.omitir_nao_fiscal
            ? ''
            : '<div class="small text-muted">NF ' + formatarQtd(l.quantidade_nao_fiscal_contada) + ' ' + escapeHtml(un) + '</div>'));
      const tipo = htmlTipoLinha(l.tipo_ajuste)
        + (editando && l.tipo_ajuste
          ? '<div class="mt-1"><button type="button" class="btn btn-sm btn-outline-danger" data-cef-tipo="BAIXA" data-cef-tipo-idx="'
            + idx + '">OFF Baixa</button> '
            + '<button type="button" class="btn btn-sm btn-outline-success" data-cef-tipo="ACRESCIMO" data-cef-tipo-idx="'
            + idx + '">ON Acréscimo</button></div>'
          : '');
      const diff = htmlBadgeDiferenca(l.diferenca_fiscal, un)
        + (f12On || l.omitir_nao_fiscal
          ? ''
          : '<div class="mt-1">' + htmlBadgeDiferenca(l.diferenca_nao_fiscal, un) + '</div>');
      return '<tr data-cef-linha="' + idx + '">'
        + '<td><div class="cef-prod-nome">' + escapeHtml(l.produto_nome || ('Produto #' + l.produto_id)) + '</div>'
        + '<div class="cef-prod-cod">' + escapeHtml(l.produto_codigo || '—') + '</div></td>'
        + '<td>' + comercial + '</td>'
        + '<td>' + convertida + '</td>'
        + '<td>' + tipo + '</td>'
        + '<td>' + saldo + '</td>'
        + '<td>' + previsto + '</td>'
        + '<td>' + diff + '</td>'
        + '<td class="text-nowrap"><button type="button" class="btn btn-sm btn-outline-primary" data-cef-edit="'
        + idx + '">Editar</button> '
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-cef-rm="' + idx + '">Remover</button></td>'
        + '</tr>';
    }).join('');
    tb.querySelectorAll('[data-cef-rm]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const indice = Number(btn.getAttribute('data-cef-rm'));
        linhas = removerDaLista(linhas, indice);
        if (editandoIndice === indice) editandoIndice = null;
        else if (editandoIndice != null && editandoIndice > indice) editandoIndice -= 1;
        pintarTabela();
      });
    });
    tb.querySelectorAll('[data-cef-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        iniciarEdicao(Number(btn.getAttribute('data-cef-edit')));
      });
    });
    tb.querySelectorAll('[data-cef-edit-qf], [data-cef-edit-qnf]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const indice = Number(inp.getAttribute('data-cef-edit-qf') || inp.getAttribute('data-cef-edit-qnf'));
        if (editTimer) clearTimeout(editTimer);
        editTimer = setTimeout(function () { salvarEdicao(indice); }, 280);
      });
    });
    tb.querySelectorAll('[data-cef-tipo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        salvarEdicao(Number(btn.getAttribute('data-cef-tipo-idx')), btn.getAttribute('data-cef-tipo'));
      });
    });
    if (editandoIndice != null) {
      const foco = tb.querySelector('[data-cef-edit-qf="' + editandoIndice + '"]');
      if (foco) foco.focus();
    }
  }

  function iniciarEdicao(indice) {
    if (!Number.isInteger(indice) || indice < 0 || indice >= linhas.length) return;
    editandoIndice = indice;
    pintarTabela();
  }

  async function salvarEdicao(indice, tipoOverride) {
    const atual = linhas[indice];
    if (!atual) return;
    if (modoFiscalMudou()) {
      mostrarErro('O estado F12 mudou. Atualize o contexto F12 antes de recalcular.');
      return;
    }
    const qfEl = document.querySelector('[data-cef-edit-qf="' + indice + '"]');
    const qnfEl = document.querySelector('[data-cef-edit-qnf="' + indice + '"]');
    const qfRaw = qfEl ? String(qfEl.value).trim() : '';
    const f12On = !!modoFiscalSessao || !!atual.omitir_nao_fiscal;
    const qnfRaw = qnfEl ? String(qnfEl.value).trim() : '';
    if (qfRaw === '' || (!f12On && qnfEl && qnfRaw === '')) return;
    const qfNum = Number(qfRaw);
    const qnfNum = Number(qnfRaw);
    if (!Number.isFinite(qfNum) || qfNum < 0 || (!f12On && qnfEl && (!Number.isFinite(qnfNum) || qnfNum < 0))) {
      mostrarErro('Informe uma quantidade física maior ou igual a zero.');
      return;
    }
    const seq = ++editSeq;
    const produtoId = atual.produto_id;
    const omitir = !!modoFiscalSessao || !!atual.omitir_nao_fiscal;
    const operacaoItem = contextoOperacaoDaLinha(atual, tipoOverride);
    try {
      const data = await postPreview(corpoPreview({
        id: atual.produto_id,
        unidade_comercial: atual.unidade_informada,
        unidade_informada: atual.unidade_informada,
        apresentacao_id: atual.apresentacao_id
      }, qfRaw, omitir ? undefined : qnfRaw, Object.assign({ omitirNaoFiscal: omitir }, operacaoItem)));
      if (seq !== editSeq) return;
      if (!linhas[indice] || Number(linhas[indice].produto_id) !== Number(produtoId)) return;
      const atualizado = atualizarLinhaPorPreview(linhas, indice, data, {
        nome: atual.produto_nome,
        codigo: atual.produto_codigo,
        apresentacao_id: atual.apresentacao_id,
        unidade_base: atual.unidade_base
      });
      if (!atualizado.ok) {
        mostrarErro('Não foi possível atualizar o item. A lista anterior foi preservada.');
        return;
      }
      linhas = atualizado.linhas;
      mostrarErro(data.saldo_insuficiente ? mensagemSaldoUi(data) : '');
      pintarTabela();
    } catch (err) {
      if (seq !== editSeq) return;
      mostrarErro(err.message || 'Falha ao recalcular o item. A quantidade anterior permanece na lista.');
    }
  }

  async function adicionarLinha() {
    if (!produtoSelecionado) {
      notify('Selecione um produto na pesquisa antes de incluir na lista.', 'warning');
      return;
    }
    let data = previewAtualCompativel() ? previewAtual.data : null;
    if (!data) data = await previewLinha();
    if (!data) return;
    if (Number(data.produto_id) !== Number(produtoSelecionado.id)) {
      notify('O cálculo não corresponde ao produto selecionado. Aguarde a consulta atual.', 'warning');
      return;
    }
    const resultado = incluirNaLista(linhas, data, produtoSelecionado);
    if (!resultado.ok && resultado.code === 'PRODUTO_JA_NA_LISTA') {
      notify('Produto já está na lista. Edite a quantidade do item existente.', 'warning');
      iniciarEdicao(resultado.indice);
      return;
    }
    if (!resultado.ok && resultado.code === 'SALDO_INSUFICIENTE') {
      notify(mensagemSaldoUi(data) || 'Saldo insuficiente para a baixa.', 'danger');
      return;
    }
    if (!resultado.ok) {
      notify('Preview sem snapshot de saldo. Atualize e tente novamente.', 'danger');
      return;
    }
    linhas = resultado.linhas;
    editandoIndice = null;
    definirProdutoSelecionado(null);
    const busca = document.getElementById('cef-produto-busca');
    if (busca) {
      busca.value = '';
      busca.focus();
    }
    pintarTabela();
    notify('Produto incluído. Diferenças calculadas. Aguardando confirmação.', 'info');
  }

  /**
   * Após CONTAGEM_DESATUALIZADA: novo preview por item, preservando quantidades contadas.
   * Não confirma automaticamente.
   */
  async function atualizarPreviewsDaLista() {
    if (!linhas.length) return;
    if (modoFiscalMudou()) {
      notify('O estado F12 mudou. Atualize o contexto F12 antes de recalcular.', 'warning');
      return;
    }
    const atualizadas = [];
    const f12On = !!modoFiscalSessao;
    for (let i = 0; i < linhas.length; i += 1) {
      const atual = linhas[i];
      try {
        const omitir = f12On || !!atual.omitir_nao_fiscal;
        const data = await postPreview(corpoPreview({
          id: atual.produto_id,
          unidade_comercial: atual.unidade_informada,
          unidade_informada: atual.unidade_informada,
          apresentacao_id: atual.apresentacao_id
        }, atual.quantidade_fiscal_informada != null
          ? atual.quantidade_fiscal_informada
          : atual.quantidade_fiscal_contada,
        omitir
          ? undefined
          : (atual.quantidade_nao_fiscal_informada != null
            ? atual.quantidade_nao_fiscal_informada
            : atual.quantidade_nao_fiscal_contada),
        Object.assign({ omitirNaoFiscal: omitir }, contextoOperacaoDaLinha(atual))));
        atualizadas.push(snapshotDaLinha(data, {
          nome: atual.produto_nome,
          codigo: atual.produto_codigo,
          apresentacao_id: atual.apresentacao_id,
          unidade_base: atual.unidade_base
        }));
      } catch (err) {
        notify(err.message, 'danger');
        return;
      }
    }
    linhas = atualizadas;
    aguardandoNovoPreview = false;
    const alerta = document.getElementById('cef-alerta-desatualizada');
    if (alerta) {
      alerta.textContent = '';
      alerta.classList.add('d-none');
    }
    pintarTabela();
    sincronizarEstadoConflito();
    notify('Pré-visualização atualizada. Revise as diferenças e confirme novamente.', 'info');
  }

  function marcarDesatualizada(data) {
    aguardandoNovoPreview = true;
    const alerta = document.getElementById('cef-alerta-desatualizada');
    if (alerta) {
      alerta.classList.remove('d-none');
      alerta.innerHTML = '<strong>Estoque alterado desde a pré-visualização.</strong> '
        + escapeHtml(data.error || 'A observação está desatualizada.')
        + ' Atualize a pré-visualização, revise as diferenças e confirme novamente. '
        + 'A confirmação automática com dados antigos foi bloqueada.';
    }
    sincronizarEstadoConflito();
  }

  async function confirmar() {
    if (confirmacaoEmAndamento) return;
    if (modoFiscalMudou()) {
      notify('O estado F12 mudou. Atualize o contexto e a pré-visualização antes de confirmar.', 'warning');
      aguardandoNovoPreview = true;
      sincronizarEstadoConflito();
      return;
    }
    if (aguardandoNovoPreview) {
      notify('Atualize a pré-visualização antes de confirmar.', 'warning');
      return;
    }
    if (!linhas.length) {
      notify('Inclua ao menos um produto.', 'warning');
      return;
    }
    for (let i = 0; i < linhas.length; i += 1) {
      const l = linhas[i];
      if (l.saldo_fiscal_esperado == null || l.saldo_nao_fiscal_esperado == null) {
        notify('Há itens sem snapshot. Remova-os e inclua novamente via preview.', 'danger');
        return;
      }
      if (l.saldo_insuficiente) {
        notify('Há baixa com saldo insuficiente. A confirmação foi bloqueada.', 'danger');
        return;
      }
    }
    const obsEl = document.getElementById('cef-obs');
    const obs = obsEl ? String(obsEl.value || '').trim() : '';
    const chave = 'contagem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const f12On = !!modoFiscalSessao;
    confirmacaoEmAndamento = true;
    try {
      const res = await fetch('/api/estoque/contagem-fisica', {
        method: 'POST',
        headers: Object.assign(authHeaders(), { 'Idempotency-Key': chave }),
        body: JSON.stringify({
          observacao: obs || undefined,
          chave_idempotencia: chave,
          modo_fiscal: f12On ? '1' : '0',
          omitir_nao_fiscal: f12On,
          itens: linhas.map(itemConfirmacaoApi)
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 409 && data.code === 'CONTAGEM_DESATUALIZADA') {
        // Não gera nova chave nem reenvia automaticamente os mesmos dados.
        marcarDesatualizada(data);
        notify(data.error || 'Contagem desatualizada. Atualize o preview.', 'warning');
        return;
      }
      if (res.status === 403) {
        throw new Error(data.error || 'Acesso não autorizado.');
      }
      if (!res.ok) throw new Error(data.error || 'Falha ao confirmar contagem');
      const box = document.getElementById('cef-resultado');
      if (box) {
        box.innerHTML = '<div class="alert alert-success">Contagem #' + escapeHtml(data.id)
          + ' confirmada em ' + escapeHtml(data.criado_em || '')
          + ' por ' + escapeHtml(data.usuario_nome || data.usuario_id || '—') + '.</div>';
      }
      linhas = [];
      editandoIndice = null;
      aguardandoNovoPreview = false;
      definirProdutoSelecionado(null);
      const busca = document.getElementById('cef-produto-busca');
      if (busca) busca.value = '';
      pintarTabela();
      sincronizarEstadoConflito();
      notify('Contagem confirmada.', 'success');
      resetarAjusteDirecionado();
      carregarStatusPeriodicidade();
      carregarHistorico();
    } catch (err) {
      notify(err.message, 'danger');
      mostrarErro(err.message || 'Falha ao confirmar contagem');
    } finally {
      confirmacaoEmAndamento = false;
    }
  }

  function loadContagemEstoque() {
    linhas = [];
    confirmacaoEmAndamento = false;
    aguardandoNovoPreview = false;
    produtoSelecionado = null;
    saldoConsulta = null;
    previewAtual = null;
    editandoIndice = null;
    operacaoForm = 'AJUSTE_DIRECIONADO';
    tipoAjusteForm = 'BAIXA';
    saldoSeq += 1;
    calcSeq += 1;
    sincronizarModoFiscalSessao();
    render();
  }

  root.loadContagemEstoque = loadContagemEstoque;
  root.__cdsContagemEstoqueTest = {
    snapshotDaLinha: snapshotDaLinha,
    itemConfirmacao: itemConfirmacao,
    itemConfirmacaoApi: itemConfirmacaoApi,
    classificarDiferenca: classificarDiferenca,
    rotuloDiferenca: rotuloDiferenca,
    resumoContagem: resumoContagem,
    incluirNaLista: incluirNaLista,
    atualizarLinhaPorPreview: atualizarLinhaPorPreview,
    removerDaLista: removerDaLista,
    formatarQtd: formatarQtd,
    textoConversao: textoConversao,
    calculoAindaValido: calculoAindaValido,
    rotuloTipoEmpresa: rotuloTipoEmpresa,
    estadoInicialAjusteDirecionado: estadoInicialAjusteDirecionado,
    rotuloTipoAjuste: rotuloTipoAjuste,
    calcularSaldoPrevisto: calcularSaldoPrevisto,
    resumoDirecionado: resumoDirecionado
  };
})(typeof window !== 'undefined' ? window : globalThis);
