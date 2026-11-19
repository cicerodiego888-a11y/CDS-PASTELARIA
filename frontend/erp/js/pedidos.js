/**
 * ERP — Módulo Pedidos (Sprint 3.5 + 3.6 UX; adaptado ao fluxo operacional da pastelaria)
 * Digitação fluida (teclado) sem alterar regras de negócio.
 * RC2.1 — layout de impressão exposto para reimpressão na Central (sem alterar modelo).
 * Interface operacional: Pedidos e Cancelados, cliente opcional. Orçamento e Expedição saíram
 * desta tela; as rotas legadas de conversão, envio à expedição e exclusão seguem no backend.
 */

function _pedFmtMoney(n) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function _pedCalcularTotaisPersonalizacao({
  precoBase,
  quantidade,
  ingredientes,
  ingredientesSelecionados,
  desconto
}) {
  const selecionados = new Set((ingredientesSelecionados || []).map(Number));
  const adicionais = Number((ingredientes || []).reduce((total, ingrediente) => (
    ingrediente.classificacao_comercial === 'OPCIONAL_COM_ADICIONAL'
      && selecionados.has(Number(ingrediente.insumo_id))
      ? total + Number(ingrediente.preco_adicional || 0)
      : total
  ), 0).toFixed(2));
  const precoUnitario = Number((Number(precoBase) + adicionais).toFixed(2));
  const subtotal = Number((
    Number(quantidade) * precoUnitario * (1 - Number(desconto || 0) / 100)
  ).toFixed(2));
  return { precoAdicionais: adicionais, precoUnitario, subtotal };
}

function _pedPersonalizacaoEquivalente(a, b) {
  if (!a || !b) return false;
  const componentes = (item) => (item.ingredientes_personalizados || [])
    .map((ingrediente) => [
      Number(ingrediente.insumo_id),
      String(ingrediente.insumo_nome_snapshot || ''),
      Number(ingrediente.quantidade_snapshot),
      String(ingrediente.unidade_snapshot || ''),
      String(ingrediente.classificacao_comercial_snapshot || ''),
      Number(ingrediente.selecionado),
      Number(ingrediente.preco_adicional_snapshot || 0)
    ])
    .sort((x, y) => x[0] - y[0]);
  const chave = (item) => JSON.stringify([
    Number(item.produto_id),
    String(item.produto_nome || ''),
    String(item.produto_codigo || ''),
    Number(item.preco_base_unitario_snapshot),
    Number(item.preco_adicionais_unitario_snapshot),
    Number(item.preco_unitario),
    Number(item.desconto_percentual || 0),
    String(item.tipo_venda || 'PESO'),
    item.preco_venda_snapshot == null ? null : Number(item.preco_venda_snapshot),
    item.preco_pedido_snapshot == null ? null : Number(item.preco_pedido_snapshot),
    item.preco_sugerido_snapshot == null ? null : Number(item.preco_sugerido_snapshot),
    item.origem_preco_sugerido || null,
    componentes(item)
  ]);
  return chave(a) === chave(b);
}

/** Cabeçalhos com token e X-Empresa-Id (o backend exige o contexto explícito da empresa). */
function _pedHeaders() {
  if (typeof CdsEmpresaContexto !== 'undefined' && typeof CdsEmpresaContexto.headersJson === 'function') {
    return CdsEmpresaContexto.headersJson();
  }
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
  };
}

let cdsAberturaMesaEmCurso = false;
let cdsConsultaPedidoSeq = 0;

function _pedEmpresaSelecionada() {
  return typeof CdsEmpresaContexto !== 'undefined'
    && typeof CdsEmpresaContexto.lerEmpresaId === 'function'
    && !!CdsEmpresaContexto.lerEmpresaId();
}

function _pedFmtData(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const p = s.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
}

function _pedEscapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/** Layout A4 legado do pedido; mantido para os consumidores que ainda o utilizam. */
function montarHtmlImpressaoPedido(p) {
  const escapeHtml = _pedEscapeHtml;
  const fmtMoney = _pedFmtMoney;
  const fmtData = _pedFmtData;
  const itens = Array.isArray(p.itens) ? p.itens : [];
  const linhas = itens.map((i) => {
    const personalizados = Number(i.personalizacao_ingredientes_snapshot) === 1;
    const selecionados = (i.ingredientes_personalizados || [])
      .filter((ingrediente) => Number(ingrediente.selecionado) === 1
        && ingrediente.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
      .map((ingrediente) => ingrediente.insumo_nome_snapshot || '')
      .filter(Boolean);
    const resumoPersonalizacao = personalizados
      ? `<small style="display:block;color:#555;">Opcionais: ${escapeHtml(selecionados.length ? selecionados.join(', ') : 'nenhum')}</small>
         <small style="display:block;color:#555;">Base ${fmtMoney(i.preco_base_unitario_snapshot)} + adicionais ${fmtMoney(i.preco_adicionais_unitario_snapshot)}</small>`
      : '';
    return `
      <tr>
        <td>${escapeHtml(i.produto_codigo || i.produto_id || '')}</td>
        <td>${escapeHtml(i.produto_nome || '')}${resumoPersonalizacao}</td>
        <td style="text-align:right;">${Number(i.quantidade || 0)}</td>
        <td style="text-align:right;">${fmtMoney(i.preco_unitario)}</td>
        <td style="text-align:right;">${Number(i.desconto_percentual || 0)}%</td>
        <td style="text-align:right;">${fmtMoney(i.subtotal)}</td>
      </tr>`;
  }).join('');

  const marca = (typeof BrandService !== 'undefined' && BrandService.meta)
    ? BrandService.meta().nome
    : 'CDS Sistemas';
  const titulo = escapeHtml(p.codigo || ('#' + p.id));
  const tipoDoc = String(p.status || '').toUpperCase() === 'ORCAMENTO' ? 'ORÇAMENTO' : 'PEDIDO';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${tipoDoc} ${titulo}</title>
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#e5e7eb}
    body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111}
    .toolbar{
      position:sticky;top:0;z-index:10;
      display:flex;gap:6px;align-items:center;justify-content:flex-end;
      padding:8px 10px;background:#1f2937;color:#fff
    }
    .toolbar .titulo{margin-right:auto;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .toolbar button{
      border:0;border-radius:4px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600
    }
    .btn-imprimir{background:#16a34a;color:#fff}
    .btn-imprimir:hover{background:#15803d}
    .btn-fechar{background:#e5e7eb;color:#111}
    .btn-fechar:hover{background:#d1d5db}
    .folha-wrap{display:flex;justify-content:center;padding:12px;background:#e5e7eb}
    .folha{
      width:210mm;
      min-height:297mm;
      background:#fff;
      padding:14mm 16mm;
      box-shadow:0 1px 8px rgba(0,0,0,.18);
    }
    h1{font-size:16px;margin:0 0 4px}
    .meta{color:#374151;margin-bottom:12px;line-height:1.45}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:1px solid #d1d5db;padding:5px 6px}
    th{background:#f3f4f6;text-align:left}
    .totais{margin-top:12px;width:220px;margin-left:auto}
    .totais td{border:none;padding:2px 0}
    .totais td:last-child{text-align:right;font-weight:600}
    .totais tr:last-child td{font-size:13px;padding-top:6px;border-top:1px solid #d1d5db}
    .rodape{margin-top:16px;color:#6b7280;font-size:10px}
    @page{size:A4;margin:0}
    @media print{
      html,body{background:#fff!important}
      .toolbar{display:none!important}
      .folha-wrap{padding:0!important;background:#fff!important;display:block!important}
      .folha{
        width:210mm!important;
        min-height:297mm!important;
        margin:0!important;
        padding:8mm!important;
        box-shadow:none!important
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="titulo">Visualização do ${tipoDoc.toLowerCase()} ${titulo}</div>
    <button type="button" class="btn-imprimir" onclick="window.print()">Imprimir</button>
    <button type="button" class="btn-fechar" onclick="window.close()">Fechar</button>
  </div>
  <div class="folha-wrap">
  <div class="folha">
    <h1>${escapeHtml(marca)} — ${tipoDoc}</h1>
    <div class="meta">
      <div><strong>Número:</strong> ${titulo}</div>
      <div><strong>Status:</strong> ${escapeHtml(p.status || '—')}</div>
      <div><strong>Data:</strong> ${fmtData(p.data_pedido)}</div>
      <div><strong>Cliente:</strong> ${escapeHtml(p.cliente_nome || 'Consumidor')}</div>
      <div><strong>Representante:</strong> ${escapeHtml(p.representante_nome || '—')}</div>
      <div><strong>Usuário:</strong> ${escapeHtml(p.usuario_nome || '—')}</div>
      ${p.observacao ? `<div><strong>Observação:</strong> ${escapeHtml(p.observacao)}</div>` : ''}
    </div>
    <table>
      <thead>
        <tr>
          <th>Código</th><th>Descrição</th><th>Qtd</th><th>Valor</th><th>Desc.%</th><th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${linhas || '<tr><td colspan="6">Sem itens</td></tr>'}
      </tbody>
    </table>
    <table class="totais">
      <tr><td>Subtotal</td><td>${fmtMoney((itens.reduce((s, i) => s + Number(i.subtotal || 0), 0)))}</td></tr>
      <tr><td>Desconto</td><td>${fmtMoney(p.desconto)}</td></tr>
      <tr><td>Frete</td><td>${fmtMoney(p.frete)}</td></tr>
      <tr><td>Total</td><td>${fmtMoney(p.total)}</td></tr>
    </table>
    <div class="rodape">Gerado em ${escapeHtml(new Date().toLocaleString('pt-BR'))}</div>
  </div>
  </div>
</body>
</html>`;
}

function formatarQuantidadeImpressaoPedido(valor) {
  const texto = String(valor == null ? 0 : valor);
  const partes = texto.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!partes) return _pedEscapeHtml(texto);
  const inteiro = partes[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return _pedEscapeHtml(`${inteiro}${partes[2] ? `,${partes[2]}` : ''}`);
}

function montarHtmlImpressaoPedidoTermico(p) {
  const escapeHtml = _pedEscapeHtml;
  const fmtMoney = _pedFmtMoney;
  const fmtData = _pedFmtData;
  const itens = Array.isArray(p.itens) ? p.itens : [];
  const linhas = itens.map((item) => `
    <div class="item-row">
      <span class="item-qtd">${formatarQuantidadeImpressaoPedido(item.quantidade)}</span>
      <span class="item-nome">${escapeHtml(item.produto_nome || '')}</span>
      <span class="item-valor">${fmtMoney(item.subtotal)}</span>
    </div>`).join('');
  const subtotal = itens.reduce((total, item) => total + Number(item.subtotal || 0), 0);
  const marca = (typeof BrandService !== 'undefined' && BrandService.meta)
    ? BrandService.meta().nome
    : 'CDS Sistemas';
  const titulo = escapeHtml(p.codigo || ('#' + p.id));
  const nomeCliente = p.cliente_nome || 'Consumidor';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Pedido ${titulo}</title>
  <style>
    *{box-sizing:border-box}
    @page{size:80mm auto;margin:0}
    html,body{width:76mm;max-width:76mm;margin:0 auto;padding:0;background:#fff;color:#111}
    body{font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.35}
    .toolbar{display:flex;justify-content:flex-end;gap:6px;padding:3mm 2.5mm;background:#f3f4f6}
    .toolbar button{border:0;border-radius:3px;padding:6px 10px;font-size:12px}
    .btn-imprimir{background:#15803d;color:#fff}
    .btn-fechar{background:#e5e7eb;color:#111}
    .cupom{width:76mm;padding:2.5mm}
    h1{margin:0 0 2mm;font-size:14px;line-height:1.25;overflow-wrap:anywhere}
    .identificacao{margin-bottom:3mm;overflow-wrap:anywhere}
    .item-list{border-top:1px dashed #555;border-bottom:1px dashed #555}
    .item-row{display:grid;grid-template-columns:8mm minmax(0,1fr) 20mm;gap:1mm;align-items:start;padding:2mm 0;border-bottom:1px dashed #bbb}
    .item-row:last-child{border-bottom:0}
    .item-qtd{white-space:nowrap}
    .item-nome{min-width:0;overflow-wrap:anywhere;word-break:normal}
    .item-valor{text-align:right;white-space:nowrap}
    .totais{margin-top:3mm}
    .total-row{display:flex;justify-content:space-between;gap:2mm;padding:1mm 0}
    .total-row span:last-child{text-align:right;white-space:nowrap}
    .total-final{margin-top:1mm;padding-top:2mm;border-top:1px solid #111;font-size:14px;font-weight:700}
    @media print{
      html,body{width:76mm!important;max-width:76mm!important;margin:0!important;background:#fff!important}
      .toolbar{display:none!important}
      .cupom{width:76mm!important;padding:2.5mm!important}
    }
  </style>
</head>
<body class="danfe danfe-80">
  <div class="toolbar">
    <button type="button" class="btn-imprimir" onclick="window.print()">Imprimir</button>
    <button type="button" class="btn-fechar" onclick="window.close()">Fechar</button>
  </div>
  <main class="cupom">
    <h1>${escapeHtml(marca)} — Pedido ${titulo}</h1>
    <div class="identificacao">
      <div><strong>Data:</strong> ${fmtData(p.data_pedido)}</div>
      <div><strong>Cliente:</strong> ${escapeHtml(nomeCliente)}</div>
    </div>
    <div class="item-list">
      ${linhas || '<div class="item-row">Sem itens</div>'}
    </div>
    <div class="totais">
      <div class="total-row"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="total-row"><span>Desconto</span><span>${fmtMoney(p.desconto)}</span></div>
      <div class="total-row"><span>Frete</span><span>${fmtMoney(p.frete)}</span></div>
      <div class="total-row total-final"><span>Total</span><span>${fmtMoney(p.total)}</span></div>
    </div>
  </main>
</body>
</html>`;
}

async function obterImpressoraCupomPedido(headers) {
  const resp = await fetch(`${API_URL}/configuracoes/impressora_cupom`, { headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.mensagem || data.error || 'Falha ao carregar a impressora de cupom configurada.');
  }
  return data.caminho || null;
}

/**
 * Reimpressão do pedido — mantém A4 para consumidores existentes e oferece layout térmico para Pedidos.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function imprimirPedidoPorId(pedidoId, formato = 'a4') {
  const id = Number(pedidoId);
  if (!id) return { ok: false, error: 'Pedido inválido.' };
  const headers = _pedHeaders();
  try {
    const resp = await fetch(`${API_URL}/pedidos/${id}`, { headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.mensagem || data.error || 'Falha ao carregar pedido');
    const p = data.pedido;
    if (!p) throw new Error('Pedido não encontrado.');

    const termico = formato === 'termico';
    const html = termico
      ? montarHtmlImpressaoPedidoTermico(p)
      : montarHtmlImpressaoPedido(p);
    if (termico && window.electronAPI?.abrirComprovante) {
      const deviceName = await obterImpressoraCupomPedido(headers);
      window.electronAPI.abrirComprovante(html, {
        silent: false,
        autoFecharMs: 5000,
        deviceName
      });
      return { ok: true };
    }
    if (termico && window.electronAPI?.imprimirDANFESilencioso) {
      const deviceName = await obterImpressoraCupomPedido(headers);
      await window.electronAPI.imprimirDANFESilencioso(html, deviceName);
      return { ok: true };
    }

    const w = termico ? 420 : 860;
    const h = termico ? 720 : 1200;
    const left = Math.max(0, Math.round((window.screen.availWidth - w) / 2));
    const top = Math.max(0, Math.round((window.screen.availHeight - h) / 2));
    const win = window.open(
      '',
      '_blank',
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
    if (!win) return { ok: false, error: 'Permita pop-ups para visualizar o pedido.' };
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Erro ao abrir visualização.' };
  }
}

function _pedResolverPrecoSugerido(produto = {}, precoComercial, origemPrecoComercial) {
  const precoVendaSnapshot = produto.preco_venda == null
    ? null
    : Number(produto.preco_venda);
  if (precoVendaSnapshot != null && (!Number.isFinite(precoVendaSnapshot) || precoVendaSnapshot < 0)) {
    throw new Error('O produto possui preço comercial inválido.');
  }

  const temPrecoPedido = produto.preco_pedido !== null && produto.preco_pedido !== undefined;
  const precoPedidoBruto = temPrecoPedido ? String(produto.preco_pedido).trim() : '';
  const precoPedido = temPrecoPedido ? Number(precoPedidoBruto) : null;
  if (temPrecoPedido && (!precoPedidoBruto || !Number.isFinite(precoPedido) || precoPedido < 0)) {
    throw new Error('O produto possui preço do Pedido inválido.');
  }

  const precoComercialInicial = Number(
    precoComercial != null
      ? precoComercial
      : (produto.preco_promocional != null ? produto.preco_promocional : produto.preco_venda || 0)
  );
  if (!Number.isFinite(precoComercialInicial) || precoComercialInicial < 0) {
    throw new Error('O produto possui preço comercial inválido.');
  }

  const origemComercial = origemPrecoComercial
    || (produto.preco_promocional != null ? 'PROMOCAO' : 'PRECO_VENDA');
  const precoInicial = temPrecoPedido ? precoPedido : precoComercialInicial;
  return {
    precoInicial,
    snapshot: {
      preco_venda_snapshot: precoVendaSnapshot,
      preco_pedido_snapshot: precoPedido,
      preco_sugerido_snapshot: precoInicial,
      origem_preco_sugerido: temPrecoPedido ? 'PRECO_PEDIDO' : origemComercial
    }
  };
}

window.montarHtmlImpressaoPedido = montarHtmlImpressaoPedido;
window.montarHtmlImpressaoPedidoTermico = montarHtmlImpressaoPedidoTermico;
window.imprimirPedidoPorId = imprimirPedidoPorId;
window.cdsPedidoResolverPrecoSugerido = _pedResolverPrecoSugerido;
window.cdsPedidoCalcularTotaisPersonalizacao = _pedCalcularTotaisPersonalizacao;
window.cdsPedidoPersonalizacaoEquivalente = _pedPersonalizacaoEquivalente;

function loadPedidos() {
  let headers = _pedHeaders();
  let chaveCriacaoPendente = null;
  let assinaturaCriacaoPendente = null;
  const chavesDuplicacaoPendentes = new Map();
  const chavesCancelamentoPendentes = new Map();
  const operacoesVendaPdvPendentes = new Set();

  function novaChaveIdempotencia() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    throw new Error('Este navegador não oferece suporte a chaves de idempotência.');
  }

  const fmtMoney = _pedFmtMoney;
  const fmtData = _pedFmtData;
  const escapeHtml = _pedEscapeHtml;

  const STATUS_LABEL = {
    ORCAMENTO: 'Orçamento',
    PEDIDO: 'Pedido',
    ABERTO: 'Pedido',
    EM_SEPARACAO: 'Em separação',
    AGUARDANDO_FATURAMENTO: 'Aguardando Expedição',
    FATURADO: 'Expedido',
    CANCELADO: 'Cancelado'
  };

  const ABAS = [
    { id: 'pedidos', label: 'Pedidos', status: 'PEDIDO,ABERTO,EM_SEPARACAO' },
    { id: 'concluidos', label: 'Concluídos', status: 'FATURADO' },
    { id: 'cancelados', label: 'Cancelados', status: 'CANCELADO' },
    { id: 'todos', label: 'Todos', status: null }
  ];

  function contextoInicialPedidosMesa() {
    const api = typeof window !== 'undefined' ? window.CdsMesasLancamento : null;
    if (!api || !window.sessionStorage || typeof api.lerLancamento !== 'function') return null;
    const empresaId = _pedEmpresaSelecionada()
      && window.CdsEmpresaContexto.lerEmpresaId
      ? window.CdsEmpresaContexto.lerEmpresaId()
      : null;
    const contexto = api.lerLancamento(window.sessionStorage, empresaId);
    return contexto && contexto.visualizar_pedidos ? contexto : null;
  }

  let filtroMesaPedidos = contextoInicialPedidosMesa();
  let abaAtual = 'pedidos';

  function badgeStatus(st) {
    const s = String(st || '');
    let cls = 'secondary';
    if (s === 'ORCAMENTO') cls = 'info';
    else if (s === 'PEDIDO' || s === 'ABERTO') cls = 'primary';
    else if (s === 'EM_SEPARACAO') cls = 'info';
    else if (s === 'AGUARDANDO_FATURAMENTO') cls = 'warning';
    else if (s === 'FATURADO') cls = 'success';
    else if (s === 'CANCELADO') cls = 'dark';
    return `<span class="badge bg-${cls}">${STATUS_LABEL[s] || s}</span>`;
  }

  let itensEditor = [];
  let sequenciaItemEditor = 0;
  let precoSugestaoSelecionada = null;
  let produtoSelecionadoParaPedido = null;
  let adicionarPersonalizacaoPendente = null;
  let pedidoEditandoId = null;
  let pedidoEditandoStatus = null;
  let pedidoEdicaoBloqueada = false;
  let pedidoSomenteConsulta = false;
  let representanteAtual = null;
  let freteAtual = 0;
  let clienteSelecionado = null;
  let timerCliente = null;
  let timerProduto = null;
  let sugClienteIdx = -1;
  let sugProdutoIdx = -1;
  let linhaGradeFoco = -1;
  let mesaFechamentoId = null;

  $('#page-content').html(`
    ${(typeof CdsPageShell !== 'undefined' && CdsPageShell.renderHeader)
      ? CdsPageShell.renderHeader({ page: 'pedidos', toolbarHtml: '' }) : ''}
    <div class="container-fluid py-3" id="pedidosRoot">
      <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div>
          <h4 class="mb-0"><i class="fas fa-clipboard-list me-2"></i>Pedidos</h4>
          <div class="text-muted small">
            F2 Novo · Ctrl+S Salvar · Ctrl+F Cliente · Enter adiciona · Esc fecha sugestões
          </div>
        </div>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-outline-secondary" id="btnPedMesas" title="Cadastrar e ativar/desativar mesas">
            <i class="fas fa-chair"></i> Mesas
          </button>
          <button type="button" class="btn btn-primary" id="btnPedNovo" title="F2">
            <i class="fas fa-plus"></i> Novo
          </button>
        </div>
      </div>
      <div id="pedAlert"></div>
      <div id="pedMesaLancamentoHost"></div>
      <div id="pedFiltroMesaContexto" class="alert alert-info py-2 mb-3" hidden></div>
      <div id="pedConferenciaHost"></div>

      <ul class="nav nav-tabs mb-3" id="pedAbas" role="tablist">
        ${ABAS.map((a) => `
          <li class="nav-item" role="presentation">
            <button type="button" class="nav-link ${a.id === abaAtual ? 'active' : ''}" data-aba="${a.id}">
              ${a.label}
            </button>
          </li>`).join('')}
      </ul>

      <div class="card shadow-sm mb-3">
        <div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-4">
              <label class="form-label small mb-0">Cliente</label>
              <input type="text" class="form-control form-control-sm" id="pedFiltroCliente" placeholder="Nome (opcional)">
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0">Data inicial</label>
              <input type="date" class="form-control form-control-sm" id="pedFiltroInicio">
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0">Data final</label>
              <input type="date" class="form-control form-control-sm" id="pedFiltroFim">
            </div>
            <div class="col-md-2">
              <button type="button" class="btn btn-sm btn-outline-primary w-100" id="btnPedPesquisar">
                <i class="fas fa-search"></i> Pesquisar
              </button>
            </div>
          </div>
        </div>
      </div>

      <div id="pedConsolidadaHost"></div>
      <div class="modal fade" id="pedConsolidadaModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Gerar venda consolidada da mesa</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
            </div>
            <div class="modal-body" id="pedConsolidadaCorpo"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-success" id="pedConsolidadaConfirmar">Confirmar e abrir no PDV</button>
            </div>
          </div>
        </div>
      </div>
      <div class="card shadow-sm">
        <div class="table-responsive">
          <table class="table table-hover mb-0 align-middle">
            <thead class="table-light">
              <tr>
                <th>Número</th>
                <th>Mesa</th>
                <th>Cliente</th>
                <th class="text-end">Valor</th>
                <th>Status</th>
                <th>Data</th>
                <th>Usuário</th>
                <th class="text-end">Ações</th>
              </tr>
            </thead>
            <tbody id="pedListaBody">
              <tr><td colspan="8" class="text-center text-muted py-4">Carregando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="modal fade" id="modalPedMesas" tabindex="-1">
      <div class="modal-dialog modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="fas fa-chair me-2"></i>Mesas</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <div class="modal-body">
            <div id="pedMesasAlert"></div>
            <div class="input-group mb-3">
              <span class="input-group-text">Mesa</span>
              <input type="number" min="1" step="1" class="form-control" id="pedMesaNovoNumero" placeholder="Número (ex.: 1)">
              <button type="button" class="btn btn-primary" id="btnPedMesaAdd"><i class="fas fa-plus"></i> Cadastrar</button>
            </div>
            <table class="table table-sm align-middle mb-0">
              <thead class="table-light">
                <tr><th>Identificação</th><th>Situação</th><th class="text-end">Ações</th></tr>
              </thead>
              <tbody id="pedMesasBody">
                <tr><td colspan="3" class="text-center text-muted py-3">Carregando…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="modalPedidoEditor" tabindex="-1">
      <div class="modal-dialog modal-xl modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="pedEditorTitulo">Novo pedido</h5>
            <div class="d-flex align-items-center gap-1">
              <button type="button" class="btn btn-sm btn-light" title="Minimizar"
                onclick="minimizarModal('modalPedidoEditor', document.getElementById('pedEditorTitulo')?.textContent || 'Pedido')">
                <i class="fas fa-window-minimize"></i>
              </button>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
            </div>
          </div>
          <div class="modal-body">
            <div id="pedEditorBloqueioAviso" class="alert alert-warning d-none" role="alert"></div>
            <div class="row g-2 mb-3">
              <div class="col-md-3">
                <label class="form-label">Mesa</label>
                <select class="form-select" id="pedMesaId">
                  <option value="">— Sem mesa —</option>
                </select>
                <div class="form-text" id="pedMesaAviso"></div>
              </div>
              <div class="col-md-5 position-relative">
                <label class="form-label">Cliente <small class="text-muted">(opcional · digite o nome)</small></label>
                <input type="text" class="form-control" id="pedClienteBusca" placeholder="Digite o nome (cadastro opcional)" autocomplete="off">
                <input type="hidden" id="pedClienteId">
                <div id="pedClienteSugestoes" class="list-group position-absolute w-100 shadow" style="z-index:1050;display:none;max-height:220px;overflow:auto;"></div>
                <div class="form-text" id="pedClienteSelecionadoLabel">Sem cliente — digite um nome se desejar</div>
              </div>
              <div class="col-md-3">
                <label class="form-label">Desconto (R$)</label>
                <input type="number" step="0.01" min="0" class="form-control" id="pedDesconto" value="0">
              </div>
              <div class="col-md-12">
                <label class="form-label">Observação</label>
                <input type="text" class="form-control" id="pedObservacao">
              </div>
            </div>

            <div class="border rounded p-2 mb-2 bg-light">
              <div class="row g-2 align-items-end">
                <div class="col-md-5 position-relative">
                  <label class="form-label small mb-0">Pesquisar produto</label>
                  <input type="text" class="form-control form-control-sm" id="pedProdutoBusca" placeholder="Código ou descrição" autocomplete="off">
                  <div id="pedProdutoSugestoes" class="list-group position-absolute w-100 shadow" style="z-index:1050;display:none;max-height:220px;overflow:auto;"></div>
                </div>
                <div class="col-md-2">
                  <label class="form-label small mb-0">Qtd</label>
                  <input type="number" class="form-control form-control-sm" id="pedItemQtd" min="0.001" step="0.001" value="1">
                </div>
                <div class="col-md-2">
                  <label class="form-label small mb-0">Valor</label>
                  <input type="number" class="form-control form-control-sm" id="pedItemPreco" min="0" step="0.01">
                </div>
                <div class="col-md-1">
                  <label class="form-label small mb-0">Desc.%</label>
                  <input type="number" class="form-control form-control-sm" id="pedItemDesc" min="0" max="100" step="0.01" value="0">
                </div>
                <div class="col-md-2">
                  <button type="button" class="btn btn-sm btn-success w-100" id="btnPedAddItem" title="Enter na quantidade">
                    <i class="fas fa-plus"></i> Adicionar
                  </button>
                </div>
              </div>
              <input type="hidden" id="pedProdutoId">
              <input type="hidden" id="pedProdutoNome">
              <input type="hidden" id="pedProdutoCodigo">
            </div>

            <div class="table-responsive">
              <table class="table table-sm align-middle" id="pedItensTable">
                <thead>
                  <tr>
                    <th>Código</th><th>Descrição</th><th>Qtd</th><th>Valor</th>
                    <th>Desc.%</th><th class="text-end">Total</th><th></th>
                  </tr>
                </thead>
                <tbody id="pedItensBody"></tbody>
              </table>
            </div>

            <div class="border-top pt-2 mt-2" id="pedTotaisBar">
              <div class="row text-end small g-2">
                <div class="col-md-2"><span class="text-muted">Itens</span><br><strong id="pedTotItens">0</strong></div>
                <div class="col-md-2"><span class="text-muted">Quantidade</span><br><strong id="pedTotQtd">0</strong></div>
                <div class="col-md-2"><span class="text-muted">Subtotal</span><br><strong id="pedTotSub">R$ 0,00</strong></div>
                <div class="col-md-2"><span class="text-muted">Desconto</span><br><strong id="pedTotDesc">R$ 0,00</strong></div>
                <div class="col-md-2"><span class="text-muted">Frete</span><br><strong id="pedTotFrete">R$ 0,00</strong></div>
                <div class="col-md-2"><span class="text-muted">Total</span><br><strong class="fs-5" id="pedTotalLabel">R$ 0,00</strong></div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-dark" id="btnPedImprimir" title="Imprimir pedido" disabled>
              <i class="fas fa-print"></i> Imprimir
            </button>
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Fechar</button>
            <button type="button" class="btn btn-outline-primary" id="btnPedFinalizar" hidden>
              Finalizar lançamento
            </button>
            <button type="button" class="btn btn-primary" id="btnPedSalvar" title="Ctrl+S">
              <i class="fas fa-save"></i> Salvar
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="pedPersonalizacaoModal" tabindex="-1" aria-labelledby="pedPersonalizacaoTitulo" aria-hidden="true">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <div>
              <h5 class="modal-title" id="pedPersonalizacaoTitulo">Personalizar ingredientes</h5>
              <div class="small text-muted" id="pedPersonalizacaoProduto"></div>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <div class="modal-body">
            <div id="pedPersonalizacaoErro" class="alert alert-warning py-2 d-none" role="alert"></div>
            <div class="row g-2 mb-3">
              <div class="col-sm-6">
                <label class="form-label" for="pedPersonalizacaoQtd">Quantidade</label>
                <input type="number" min="0.001" step="0.001" class="form-control" id="pedPersonalizacaoQtd">
              </div>
              <div class="col-sm-6">
                <label class="form-label" for="pedPersonalizacaoPrecoBase">Preço-base por unidade (R$)</label>
                <input type="text" inputmode="decimal" class="form-control" id="pedPersonalizacaoPrecoBase" readonly aria-readonly="true">
              </div>
            </div>
            <div class="row g-3">
              <section class="col-md-6" aria-labelledby="pedIngredientesSemAdicionalTitulo">
                <h6 id="pedIngredientesSemAdicionalTitulo">Opcionais sem adicional</h6>
                <div id="pedIngredientesSemAdicional" class="small"></div>
              </section>
              <section class="col-md-6" aria-labelledby="pedIngredientesComAdicionalTitulo">
                <h6 id="pedIngredientesComAdicionalTitulo">Opcionais com adicional</h6>
                <div id="pedIngredientesComAdicional" class="small"></div>
              </section>
            </div>
            <div class="border-top mt-3 pt-3 d-flex justify-content-between">
              <span>Adicionais por unidade</span>
              <strong id="pedPersonalizacaoAdicionais">R$ 0,00</strong>
            </div>
            <div class="d-flex justify-content-between mt-2" aria-live="polite">
              <span>Preço unitário</span>
              <strong id="pedPersonalizacaoPrecoUnitario">R$ 0,00</strong>
            </div>
            <div class="d-flex justify-content-between">
              <span>Total do item</span>
              <strong id="pedPersonalizacaoTotalItem">R$ 0,00</strong>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnPedConfirmarPersonalizacao">Confirmar ingredientes</button>
          </div>
        </div>
      </div>
    </div>
  `);

  function alertar(msg, tipo, htmlExtra) {
    $('#pedAlert').html(`<div class="alert alert-${tipo || 'info'} alert-dismissible fade show">
      ${htmlExtra ? msg : escapeHtml(msg)}
      ${htmlExtra || ''}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>`);
  }

  function calcTotaisDetalhe() {
    const subtotal = itensEditor.reduce((s, i) => s + Number(i.subtotal || 0), 0);
    const qtd = itensEditor.reduce((s, i) => s + Number(i.quantidade || 0), 0);
    const desconto = Number($('#pedDesconto').val() || 0);
    const frete = freteAtual;
    const total = Number((subtotal - desconto + frete).toFixed(2));
    return {
      itens: itensEditor.length,
      quantidade: Number(qtd.toFixed(3)),
      subtotal: Number(subtotal.toFixed(2)),
      desconto,
      frete,
      total
    };
  }

  function atualizarTotaisBar() {
    const t = calcTotaisDetalhe();
    $('#pedTotItens').text(t.itens);
    $('#pedTotQtd').text(t.quantidade);
    $('#pedTotSub').text(fmtMoney(t.subtotal));
    $('#pedTotDesc').text(fmtMoney(t.desconto));
    $('#pedTotFrete').text(fmtMoney(t.frete));
    $('#pedTotalLabel').text(fmtMoney(t.total));
  }

  function destacarSugestoes($box, idx) {
    const $btns = $box.find('.list-group-item-action');
    $btns.removeClass('active');
    if (idx >= 0 && idx < $btns.length) {
      $btns.eq(idx).addClass('active');
      const el = $btns.get(idx);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function fecharSugestoes(tipo) {
    if (!tipo || tipo === 'cliente') {
      $('#pedClienteSugestoes').hide().empty();
      sugClienteIdx = -1;
    }
    if (!tipo || tipo === 'produto') {
      $('#pedProdutoSugestoes').hide().empty();
      sugProdutoIdx = -1;
    }
  }

  function selecionarClientePorIdx(idx) {
    const $btn = $('#pedClienteSugestoes .list-group-item-action').eq(idx);
    if (!$btn.length) return false;
    $btn.trigger('click');
    return true;
  }

  function selecionarProdutoPorIdx(idx) {
    const $btn = $('#pedProdutoSugestoes .list-group-item-action').eq(idx);
    if (!$btn.length) return false;
    $btn.trigger('click');
    return true;
  }

  async function aplicarProdutoSelecionado(
    id,
    nome,
    codigo,
    precoComercial,
    origemPrecoComercial,
    itemEditorId = null
  ) {
    precoSugestaoSelecionada = null;
    produtoSelecionadoParaPedido = null;
    try {
      const resp = await fetch(`${API_URL}/produtos/${id}`, { headers });
      const produto = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(produto.error || 'Falha ao carregar o produto selecionado.');
      const nomePedidoAtual = String(produto.nome_comercial || '').trim() || produto.nome || nome || '';
      let fichaPersonalizacao = null;
      if (Number(produto.permite_personalizacao_ingredientes) === 1) {
        const fichaResp = await fetch(`${API_URL}/produtos/${id}/ficha-tecnica`, { headers });
        const ficha = await fichaResp.json().catch(() => ({}));
        if (!fichaResp.ok) {
          throw new Error(ficha.error || 'Falha ao carregar as opções de ingredientes.');
        }
        if (!ficha || Number(ficha.ativo) !== 1 || !Array.isArray(ficha.itens) || !ficha.itens.length) {
          throw new Error('O produto permite personalização, mas não possui ficha técnica ativa e válida.');
        }
        if (!ficha.itens.some((item) => item.classificacao_comercial !== 'OBRIGATORIO_OCULTO')) {
          throw new Error('A ficha técnica não possui ingredientes opcionais para selecionar.');
        }
        fichaPersonalizacao = ficha;
      }
      if (itemEditorId && !fichaPersonalizacao) {
        throw new Error('A configuração atual do produto não permite editar esta personalização.');
      }
      const sugestao = _pedResolverPrecoSugerido(produto, precoComercial, origemPrecoComercial);
      const existente = itemEditorId
        ? itensEditor.find((item) => item.editor_id === itemEditorId)
        : null;
      if (itemEditorId && !existente) {
        throw new Error('O item que seria editado não está mais no Pedido.');
      }
      const nomePedido = existente?.produto_nome || nomePedidoAtual;
      const codigoPedido = existente?.produto_codigo || codigo || '';
      const precoInicial = fichaPersonalizacao && existente
        ? Number(existente.preco_base_unitario_snapshot ?? sugestao.precoInicial)
        : sugestao.precoInicial;
      precoSugestaoSelecionada = fichaPersonalizacao && existente
        ? {
          preco_venda_snapshot: existente.preco_venda_snapshot ?? null,
          preco_pedido_snapshot: existente.preco_pedido_snapshot ?? null,
          preco_sugerido_snapshot: existente.preco_sugerido_snapshot ?? null,
          origem_preco_sugerido: existente.origem_preco_sugerido ?? null
        }
        : sugestao.snapshot;
      produtoSelecionadoParaPedido = fichaPersonalizacao
        ? { id: Number(id), ficha: fichaPersonalizacao }
        : null;
      $('#pedProdutoId').val(id);
      $('#pedProdutoNome').val(nomePedido);
      $('#pedProdutoCodigo').val(codigoPedido);
      $('#pedItemPreco').val(precoInicial);
      $('#pedProdutoBusca').val((codigoPedido || '') + (codigoPedido ? ' — ' : '') + nomePedido);
      fecharSugestoes('produto');
      $('#pedItemQtd').val($('#pedItemQtd').val() || '1');
      if (fichaPersonalizacao) {
        abrirModalPersonalizacao(produtoSelecionadoParaPedido, {
          itemEditorId: existente?.editor_id || null,
          produtoId: Number(id),
          quantidade: Number(existente?.quantidade ?? $('#pedItemQtd').val()),
          precoBase: Number(precoInicial),
          precoAdicionais: Number(existente?.preco_adicionais_unitario_snapshot || 0),
          desconto: Number(existente?.desconto_percentual ?? $('#pedItemDesc').val() ?? 0),
          nome: nomePedido,
          codigo: codigoPedido,
          snapshotPreco: precoSugestaoSelecionada
        });
        return;
      }
      setTimeout(() => {
        $('#pedItemQtd').trigger('focus').select();
      }, 0);
    } catch (err) {
      alertar(err.message || 'Falha ao carregar o produto selecionado.', 'danger');
    }
  }

  function aplicarClienteSelecionado(id, nome) {
    clienteSelecionado = { id, nome };
    $('#pedClienteId').val(id);
    $('#pedClienteBusca').val(nome);
    $('#pedClienteSelecionadoLabel').text(nome);
    fecharSugestoes('cliente');
    setTimeout(() => $('#pedProdutoBusca').trigger('focus'), 0);
  }

  function renderItens() {
    if (!itensEditor.length) {
      $('#pedItensBody').html(`<tr><td colspan="7" class="text-muted text-center">${pedidoEdicaoBloqueada ? 'Nenhum item registrado.' : 'Nenhum item. Pesquise e adicione produtos.'}</td></tr>`);
      linhaGradeFoco = -1;
    } else {
      $('#pedItensBody').html(itensEditor.map((it, idx) => {
        const selecionados = (it.ingredientes_personalizados || [])
          .filter((ingrediente) => Number(ingrediente.selecionado) === 1
            && ingrediente.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
          .map((ingrediente) => ingrediente.insumo_nome_snapshot || ingrediente.nome || '')
          .filter(Boolean);
        const resumo = Number(it.personalizacao_ingredientes_snapshot) === 1
          ? `<small class="d-block text-muted">Personalizado${selecionados.length ? `: ${escapeHtml(selecionados.join(', '))}` : ': sem opcionais selecionados'}</small>`
          : '';
        return `
        <tr class="ped-item-row ${linhaGradeFoco === idx ? 'table-active' : ''}" data-idx="${idx}" tabindex="0">
          <td>${escapeHtml(it.produto_codigo || it.produto_id)}</td>
          <td>${escapeHtml(it.produto_nome || ('#' + it.produto_id))}${resumo}</td>
          <td style="width:90px"><input type="number" class="form-control form-control-sm ped-edit-qtd" data-idx="${idx}" value="${it.quantidade}" min="0.001" step="0.001" ${pedidoEdicaoBloqueada ? 'disabled aria-disabled="true"' : ''}></td>
          <td style="width:100px"><input type="${Number(it.personalizacao_ingredientes_snapshot) === 1 ? 'text' : 'number'}" class="form-control form-control-sm ped-edit-preco" data-idx="${idx}" value="${it.preco_unitario}" min="0" step="0.01" ${Number(it.personalizacao_ingredientes_snapshot) === 1 ? 'readonly aria-readonly="true"' : ''} ${pedidoEdicaoBloqueada ? 'disabled aria-disabled="true"' : ''} title="${Number(it.personalizacao_ingredientes_snapshot) === 1 ? 'Preço oficial + adicionais (somente leitura)' : 'Preço unitário'}"></td>
          <td style="width:80px"><input type="number" class="form-control form-control-sm ped-edit-desc" data-idx="${idx}" value="${it.desconto_percentual || 0}" min="0" max="100" step="0.01" ${pedidoEdicaoBloqueada ? 'disabled aria-disabled="true"' : ''}></td>
          <td class="text-end">${fmtMoney(it.subtotal)}</td>
          <td class="text-end">
            ${!pedidoEdicaoBloqueada && Number(it.personalizacao_ingredientes_snapshot) === 1
              ? `<button type="button" class="btn btn-sm btn-outline-secondary ped-edit-personalizacao me-1" data-idx="${idx}" title="Editar personalização" aria-label="Editar personalização de ${escapeHtml(it.produto_nome || ('#' + it.produto_id))}">
                   <i class="fas fa-edit"></i>
                 </button>`
              : ''}
            ${!pedidoEdicaoBloqueada ? `<button type="button" class="btn btn-sm btn-outline-danger ped-del-item" data-idx="${idx}" title="Excluir (Del)">
              <i class="fas fa-trash"></i>
            </button>` : ''}
          </td>
        </tr>`;
      }).join(''));
    }
    atualizarTotaisBar();

    $('#pedItensBody').off('click', '.ped-del-item').on('click', '.ped-del-item', function (e) {
      if (pedidoEdicaoBloqueada) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = Number($(this).closest('.ped-item-row').data('idx'));
      if (!Number.isInteger(idx) || idx < 0 || idx >= itensEditor.length) return;
      itensEditor.splice(idx, 1);
      linhaGradeFoco = -1;
      renderItens();
      $('#pedProdutoBusca').trigger('focus');
    });

    $('#pedItensBody').off('click', '.ped-edit-personalizacao')
      .on('click', '.ped-edit-personalizacao', function (e) {
        if (pedidoEdicaoBloqueada) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = Number($(this).closest('.ped-item-row').data('idx'));
        const item = itensEditor[idx];
        if (!item || !item.editor_id) {
          alertar('Não foi possível identificar a linha personalizada do Pedido.', 'danger');
          return;
        }
        aplicarProdutoSelecionado(
          item.produto_id,
          item.produto_nome,
          item.produto_codigo,
          item.preco_base_unitario_snapshot,
          item.origem_preco_sugerido,
          item.editor_id
        );
      });

    $('.ped-edit-qtd, .ped-edit-preco, .ped-edit-desc').off('change input').on('change input', function () {
      if (pedidoEdicaoBloqueada) return;
      const idx = Number($(this).data('idx'));
      const row = itensEditor[idx];
      if (!row) return;
      const qtd = Number($('.ped-edit-qtd[data-idx="' + idx + '"]').val());
      const $preco = $('.ped-edit-preco[data-idx="' + idx + '"]');
      let preco = Number($preco.val());
      const desc = Number($('.ped-edit-desc[data-idx="' + idx + '"]').val());
      row.quantidade = qtd;
      if (Number(row.personalizacao_ingredientes_snapshot) === 1) {
        const adicionais = Number(row.preco_adicionais_unitario_snapshot || 0);
        preco = Number((Number(row.preco_base_unitario_snapshot || 0) + adicionais).toFixed(2));
        row.preco_unitario = preco;
        $preco.val(preco.toFixed(2));
      } else {
        row.preco_unitario = preco;
      }
      row.desconto_percentual = desc;
      row.subtotal = Number((qtd * row.preco_unitario * (1 - desc / 100)).toFixed(2));
      atualizarTotaisBar();
      $(this).closest('tr').find('td').eq(5).text(fmtMoney(row.subtotal));
    });

    $('.ped-item-row').off('dblclick').on('dblclick', function () {
      if (pedidoEdicaoBloqueada) return;
      const idx = Number($(this).data('idx'));
      linhaGradeFoco = idx;
      $(this).find('.ped-edit-qtd').trigger('focus').select();
    });

    $('.ped-item-row').off('click').on('click', function () {
      linhaGradeFoco = Number($(this).data('idx'));
      $('.ped-item-row').removeClass('table-active');
      $(this).addClass('table-active');
    });

    $('.ped-item-row').off('keydown').on('keydown', function (e) {
      if (pedidoEdicaoBloqueada) return;
      const idx = Number($(this).data('idx'));
      if (e.key === 'Delete' && !$(e.target).is('input')) {
        e.preventDefault();
        itensEditor.splice(idx, 1);
        linhaGradeFoco = -1;
        renderItens();
        $('#pedProdutoBusca').trigger('focus');
      }
    });
  }

  let consolidadaAtual = null;

  function chaveIdempotenciaConsolidada(mesaId, atendimentoId, pedidoIds) {
    const contexto = window.CdsEmpresaContexto;
    const empresaId = contexto && typeof contexto.lerEmpresaId === 'function'
      ? Number(contexto.lerEmpresaId())
      : 0;
    const api = window.CdsVendaConsolidada;
    if (!api || typeof api.chaveIdempotencia !== 'function') {
      throw new Error('O módulo de idempotência da venda consolidada não está disponível.');
    }
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      throw new Error('Selecione uma empresa antes de reservar a venda consolidada.');
    }
    return api.chaveIdempotencia({
      storage: sessionStorage,
      empresaId,
      mesaId,
      atendimentoId,
      pedidoIds,
      criarChave: () => (window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    });
  }

  function pintarConsolidada(itens) {
    const api = window.CdsVendaConsolidada;
    const grupos = api ? api.grupos(itens) : [];
    if (!grupos.length) {
      $('#pedConsolidadaHost').empty();
      return;
    }
    $('#pedConsolidadaHost').html(grupos.map((grupo) => `
      <div class="alert alert-light border d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span>Mesa ${escapeHtml(grupo.mesa_numero == null ? grupo.mesa_id : grupo.mesa_numero)} · ${grupo.pedidos.length} pedidos elegíveis · ${fmtMoney(grupo.total)}</span>
        <button type="button" class="btn btn-sm btn-success ped-venda-consolidada" data-mesa="${grupo.mesa_id}">Gerar venda consolidada da mesa</button>
      </div>
    `).join(''));
    $('.ped-venda-consolidada').off('click').on('click', function () {
      const mesaId = Number($(this).data('mesa'));
      const grupo = grupos.find((item) => item.mesa_id === mesaId);
      if (grupo) abrirConsolidada(grupo);
    });
  }

  async function abrirConsolidada(grupo) {
    consolidadaAtual = {
      mesaId: grupo.mesa_id,
      pedidos: grupo.pedidos.map((pedido) => ({ ...pedido, incluir: true, itens: [] })),
      enviando: false
    };
    $('#pedConsolidadaCorpo').html('<p class="text-muted mb-0">Carregando os pedidos gravados…</p>');
    const el = document.getElementById('pedConsolidadaModal');
    if (window.bootstrap && el) window.bootstrap.Modal.getOrCreateInstance(el).show();
    try {
      for (const pedido of consolidadaAtual.pedidos) {
        const resp = await fetch(`${API_URL}/pedidos/${pedido.id}`, { headers: _pedHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.mensagem || data.error || 'Não foi possível ler o pedido.');
        pedido.itens = (data.pedido && data.pedido.itens) || data.itens || [];
        pedido.observacao = (data.pedido && data.pedido.observacao) || pedido.observacao || '';
        pedido.total = data.pedido && data.pedido.total != null ? data.pedido.total : pedido.total;
      }
      desenharConsolidada();
    } catch (err) {
      $('#pedConsolidadaCorpo').html(`<div class="alert alert-danger mb-0">${escapeHtml(err.message)}</div>`);
    }
  }

  function desenharConsolidada() {
    const pedidos = consolidadaAtual.pedidos.filter((pedido) => pedido.incluir);
    const total = pedidos.reduce((soma, pedido) => soma + Number(pedido.total || 0), 0);
    $('#pedConsolidadaCorpo').html(`
      ${consolidadaAtual.pedidos.map((pedido) => `
        <section class="border rounded p-2 mb-2">
          <label class="d-flex justify-content-between gap-2">
            <span><input type="checkbox" class="form-check-input me-2 ped-consolidada-item" data-id="${pedido.id}" ${pedido.incluir ? 'checked' : ''}>${escapeHtml(pedido.codigo || ('Pedido ' + pedido.id))}</span>
            <strong>${fmtMoney(pedido.total)}</strong>
          </label>
          <div class="small text-muted">Observação ${escapeHtml(pedido.observacao || '—')}</div>
          <ul class="mb-0">${(pedido.itens || []).map((item) => `<li>${escapeHtml(item.produto_nome || item.produto_id)} · quantidade ${escapeHtml(item.quantidade)} · ${fmtMoney(item.subtotal)}</li>`).join('')}</ul>
        </section>
      `).join('')}
      <p class="mb-0"><strong>Total consolidado ${fmtMoney(total)}</strong></p>
    `);
    $('#pedConsolidadaConfirmar').prop('disabled', pedidos.length < 2);
    $('.ped-consolidada-item').on('change', function () {
      const id = Number($(this).data('id'));
      const pedido = consolidadaAtual.pedidos.find((item) => Number(item.id) === id);
      if (pedido) pedido.incluir = this.checked;
      desenharConsolidada();
    });
  }

  function fecharModalConsolidada() {
    const el = document.getElementById('pedConsolidadaModal');
    if (window.bootstrap && el) {
      window.bootstrap.Modal.getOrCreateInstance(el).hide();
    }
    consolidadaAtual = null;
  }

  async function confirmarConsolidada() {
    if (
      !consolidadaAtual
      || consolidadaAtual.enviando
      || $('#pedConsolidadaConfirmar').prop('disabled')
    ) return;
    const api = window.CdsVendaConsolidada;
    const decisao = api.confirmarSelecao(
      consolidadaAtual.pedidos,
      consolidadaAtual.pedidos.filter((pedido) => !pedido.incluir).map((pedido) => pedido.id)
    );
    if (!decisao.ok || decisao.criarVenda) return;
    consolidadaAtual.enviando = true;
    $('#pedConsolidadaConfirmar').prop('disabled', true);
    $('.ped-consolidada-item').prop('disabled', true);
    try {
      const atendimentoId = consolidadaAtual.pedidos[0].mesa_atendimento_id;
      const chave = chaveIdempotenciaConsolidada(
        consolidadaAtual.mesaId,
        atendimentoId,
        decisao.pedidoIds
      );
      const resp = await fetch(`${API_URL}/pedidos/venda-consolidada-mesa`, {
        method: 'POST',
        headers: Object.assign(_pedHeaders(), { 'Idempotency-Key': chave }),
        body: JSON.stringify({ mesa_id: consolidadaAtual.mesaId, pedido_ids: decisao.pedidoIds })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const erro = new Error(
          (data && (data.mensagem || data.error)) || `A mesa não pôde ser preparada (HTTP ${resp.status}).`
        );
        erro.codigo = data && (data.codigo || data.code);
        throw erro;
      }
      if (!data || !Number.isInteger(Number(data.consolidacao_id)) || Number(data.consolidacao_id) <= 0) {
        throw new Error('O servidor não confirmou a reserva da consolidação; o PDV não será aberto.');
      }
      const handoffConsolidado = {
        consolidacao_id: data.consolidacao_id,
        venda_id: data.venda_id || null,
        idempotency_key: chave,
        mesa_id: data.mesa_id || consolidadaAtual.mesaId,
        total: data.total,
        desconto: data.desconto || 0,
        itens: data.itens,
        cliente_id: data.cliente_id || null
      };
      try {
        sessionStorage.removeItem('pdvPedidoHandoff');
        localStorage.removeItem('pdvPedidoHandoff');
      } catch (_e) { /* ignore */ }
      // Fecha na hora do encaminhamento: a reserva já está confirmada.
      fecharModalConsolidada();
      try {
        await carregarLista();
      } catch (_e) { /* lista atualiza no próximo tick do PDV */ }
      if (typeof window.abrirPdvOficial === 'function') {
        const resultado = await window.abrirPdvOficial({ handoff: handoffConsolidado });
        if (resultado && resultado.ok === false) {
          throw new Error(resultado.mensagem || 'Não foi possível abrir o PDV.');
        }
      } else {
        sessionStorage.setItem('pdvPedidoHandoff', JSON.stringify(handoffConsolidado));
        window.location.assign('/pdv');
      }
    } catch (err) {
      const codigo = err.codigo ? ` [${err.codigo}]` : '';
      alertar(`${err.message || 'Falha ao reservar a venda consolidada.'}${codigo}`, 'danger');
      if (consolidadaAtual) {
        consolidadaAtual.enviando = false;
        $('.ped-consolidada-item').prop('disabled', false);
        $('#pedConsolidadaConfirmar').prop(
          'disabled',
          consolidadaAtual.pedidos.filter((pedido) => pedido.incluir).length < 2
        );
      }
    }
  }

  let ultimoTickListaPedidos = 0;
  let timerRecargaListaPedidos = null;

  function tickListaPedidosAtual() {
    if (typeof window.lerTickListaPedidos === 'function') {
      return window.lerTickListaPedidos();
    }
    try {
      const raw = window.localStorage && window.localStorage.getItem('cds_pedidos_lista_tick');
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && Number(o.ts) > 0 ? o : null;
    } catch (_e) {
      return null;
    }
  }

  /** Recarrega a lista quando o PDV (outra janela) finaliza o pedido. */
  function agendarRecarregarListaAposPdv(forcar) {
    if (!$('#pedidosRoot').length) return;
    const tick = tickListaPedidosAtual();
    const ts = tick ? Number(tick.ts) : 0;
    if (!forcar) {
      if (!ts || ts <= ultimoTickListaPedidos) return;
    }
    if (ts > ultimoTickListaPedidos) ultimoTickListaPedidos = ts;
    if (timerRecargaListaPedidos) clearTimeout(timerRecargaListaPedidos);
    timerRecargaListaPedidos = setTimeout(() => {
      timerRecargaListaPedidos = null;
      if (!$('#pedidosRoot').length) return;
      // Venda já finalizada no PDV: não manter a consolidada aberta sobre a lista.
      const modalEl = document.getElementById('pedConsolidadaModal');
      if (modalEl && modalEl.classList.contains('show')) {
        fecharModalConsolidada();
      }
      carregarLista();
    }, 120);
  }

  function ligarSincronizacaoListaPdv() {
    $(window)
      .off('storage.pedListaPdv')
      .on('storage.pedListaPdv', (ev) => {
        const key = ev.originalEvent && ev.originalEvent.key;
        const chave = (window.PdvAcessoOficial && window.PdvAcessoOficial.CHAVE_LISTA_PEDIDOS_TICK)
          || 'cds_pedidos_lista_tick';
        if (key === chave) agendarRecarregarListaAposPdv(false);
      });
    $(window)
      .off('focus.pedListaPdv')
      .on('focus.pedListaPdv', () => agendarRecarregarListaAposPdv(false));
    $(document)
      .off('visibilitychange.pedListaPdv')
      .on('visibilitychange.pedListaPdv', () => {
        if (!document.hidden) agendarRecarregarListaAposPdv(false);
      });
  }

  async function carregarLista() {
    const qs = new URLSearchParams();
    const cliente = $('#pedFiltroCliente').val();
    const inicio = $('#pedFiltroInicio').val();
    const fim = $('#pedFiltroFim').val();
    const aba = ABAS.find((a) => a.id === abaAtual) || ABAS[0];
    if (aba.status) qs.set('status', aba.status);
    if (cliente) qs.set('cliente', cliente);
    if (inicio) qs.set('dataInicio', inicio);
    if (fim) qs.set('dataFim', fim);
    if (filtroMesaPedidos) {
      qs.set('mesa_id', filtroMesaPedidos.mesa_id);
      qs.set('mesa_atendimento_id', filtroMesaPedidos.atendimento_id);
      $('#pedFiltroMesaContexto')
        .prop('hidden', false)
      .text(`Exibindo somente pedidos abertos vigentes da mesa ${
        filtroMesaPedidos.numero || filtroMesaPedidos.mesa_id
      }.`);
    }

    if (!_pedEmpresaSelecionada()) {
      $('#pedListaBody').html('<tr><td colspan="8" class="text-center text-warning py-4">Selecione a empresa para consultar os pedidos.</td></tr>');
      return;
    }
    headers = _pedHeaders();
    $('#pedListaBody').html('<tr><td colspan="8" class="text-center text-muted py-4">Carregando…</td></tr>');
    try {
      const resp = await fetch(`${API_URL}/pedidos?${qs}`, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.mensagem || data.error || ('HTTP ' + resp.status));
      let itens = data.itens || [];
      if (filtroMesaPedidos) {
        const api = window.CdsMesasLancamento;
        if (!api || typeof api.filtrarPedidosAbertosDaMesa !== 'function') {
          throw new Error('Não foi possível aplicar o filtro dos pedidos abertos desta mesa.');
        }
        itens = api.filtrarPedidosAbertosDaMesa(itens, filtroMesaPedidos);
        if (typeof api.consumirVisualizacaoPedidos === 'function') {
          api.consumirVisualizacaoPedidos(window.sessionStorage);
        }
      }
      if (!itens.length) {
        $('#pedConsolidadaHost').empty();
        $('#pedListaBody').html(`<tr><td colspan="8" class="text-center text-muted py-4">${
          filtroMesaPedidos
            ? 'Nenhum pedido aberto vigente encontrado para esta mesa.'
            : 'Nenhum registro encontrado.'
        }</td></tr>`);
        return;
      }
      $('#pedListaBody').html(itens.map((p) => {
        const status = String(p.status || '').toUpperCase();
        const editavel = !(p.edicao_bloqueada === true || Number(p.edicao_bloqueada) === 1
          || ['FATURADO', 'CANCELADO'].includes(status)
          || (p.venda_id != null && Number(p.venda_id) > 0));
        const somenteConsulta = p.somente_consulta === true || Number(p.somente_consulta) === 1
          || Number(p.finalizacao_confirmada) === 1
          || String(p.venda_pdv_status || '').toUpperCase() === 'FINALIZADA'
          || ['FATURADO', 'CANCELADO'].includes(status);
        const vendaPdvId = Number(p.venda_pdv_id || p.venda_id) || null;
        const vendaPdvStatus = String(p.venda_pdv_status || '').toUpperCase();
        const vendaPdvFinalizada = vendaPdvStatus === 'FINALIZADA'
          || (status === 'FATURADO' && vendaPdvId);
        const vendaPdvGerada = vendaPdvStatus === 'VENDA_CRIADA' && vendaPdvId;
        const vendaPdvIniciada = vendaPdvStatus === 'INICIADA' && !vendaPdvId;
        const podeGerarVendaPdv = ['PEDIDO', 'ABERTO', 'EM_SEPARACAO'].includes(p.status)
          && !vendaPdvId
          && !somenteConsulta;
        const estadoVendaPdv = vendaPdvFinalizada
          ? `<span class="badge bg-success me-1">Venda ${vendaPdvId ? `#${vendaPdvId} ` : ''}finalizada</span>`
          : vendaPdvGerada
            ? `<span class="badge bg-warning text-dark me-1">Venda #${vendaPdvId} gerada; vínculo pendente</span>`
            : vendaPdvIniciada
              ? '<span class="badge bg-info text-dark me-1">Preparação da venda pendente</span>'
              : (vendaPdvId ? `<span class="badge bg-secondary me-1">Venda #${vendaPdvId} vinculada</span>` : '');
        return `
        <tr class="ped-linha" data-id="${p.id}" style="cursor:pointer;" title="Clique para visualizar">
          <td><strong>${escapeHtml(p.codigo || ('#' + p.id))}</strong></td>
          <td>${p.mesa_numero != null ? 'Mesa ' + escapeHtml(p.mesa_numero) : '—'}</td>
          <td>${escapeHtml(p.cliente_nome || '—')}</td>
          <td class="text-end">${fmtMoney(p.total)}</td>
          <td>${badgeStatus(p.status)}</td>
          <td>${fmtData(p.data_pedido)}</td>
          <td>${escapeHtml(p.usuario_nome || '—')}</td>
          <td class="text-end text-nowrap ped-acoes">
            ${estadoVendaPdv}
            ${vendaPdvGerada && !somenteConsulta ? `<button class="btn btn-sm btn-outline-success ped-recuperar-venda-pdv" data-id="${p.id}" data-venda-id="${vendaPdvId}" title="Concluir o vínculo da venda existente">Concluir vínculo</button>` : ''}
            ${podeGerarVendaPdv ? `<button class="btn btn-sm btn-outline-success ped-gerar-venda-pdv" data-id="${p.id}" title="${vendaPdvIniciada ? 'Retomar a preparação da venda' : 'Gerar venda no PDV'}">${vendaPdvIniciada ? 'Retomar no PDV' : 'Gerar venda no PDV'}</button>` : ''}
            ${editavel ? `<button class="btn btn-sm btn-outline-primary ped-editar" data-id="${p.id}" title="Editar"><i class="fas fa-edit"></i></button>` : ''}
            <button class="btn btn-sm btn-outline-dark ped-imprimir" data-id="${p.id}" title="Imprimir"><i class="fas fa-print"></i></button>
            ${!somenteConsulta ? `<button class="btn btn-sm btn-outline-secondary ped-duplicar" data-id="${p.id}" title="Duplicar"><i class="fas fa-copy"></i></button>` : ''}
            ${editavel ? `<button class="btn btn-sm btn-outline-danger ped-cancelar" data-id="${p.id}" title="Cancelar"><i class="fas fa-ban"></i></button>` : ''}
          </td>
        </tr>`;
      }).join(''));

      $('#pedListaBody .ped-linha').off('click').on('click', function (e) {
        if ($(e.target).closest('.ped-acoes, button, a, input').length) return;
        const id = Number($(this).data('id'));
        if (id) abrirEditor(id);
      });
      $('.ped-editar').off('click').on('click', function (e) {
        e.stopPropagation();
        abrirEditor(Number($(this).data('id')));
      });
      $('.ped-imprimir').off('click').on('click', function (e) {
        e.stopPropagation();
        imprimirPedido(Number($(this).data('id')));
      });
      $('.ped-duplicar').off('click').on('click', function (e) {
        e.stopPropagation();
        duplicarPedido(Number($(this).data('id')));
      });
      $('.ped-cancelar').off('click').on('click', function (e) {
        e.stopPropagation();
        cancelarPedido(Number($(this).data('id')));
      });
      $('.ped-gerar-venda-pdv').off('click').on('click', function (e) {
        e.stopPropagation();
        iniciarVendaPdv(Number($(this).data('id')));
      });
      $('.ped-recuperar-venda-pdv').off('click').on('click', function (e) {
        e.stopPropagation();
        concluirVinculoVendaPdv(
          Number($(this).data('id')),
          Number($(this).data('venda-id'))
        );
      });
      pintarConsolidada(itens);
    } catch (err) {
      $('#pedListaBody').html(`<tr><td colspan="8" class="text-danger text-center py-4">${escapeHtml(err.message)}</td></tr>`);
    }
  }

  function montarDiagnosticoPreparacao(preparacao) {
    const detalhes = preparacao.detalhes || {};
    const parcial = Array.isArray(detalhes.composicao_parcial)
      ? detalhes.composicao_parcial
        .map((item) => `${item.nome} × ${item.quantidade}`)
        .join(', ')
      : '';
    const valorParcial = Number(detalhes.melhor_valor_disponivel_centavos);
    const complemento = Number.isFinite(valorParcial) && valorParcial >= 0
      ? ` Melhor composição disponível: R$ ${(valorParcial / 100).toFixed(2).replace('.', ',')}${parcial ? ` (${parcial})` : ''}; diferença de R$ ${(Number(detalhes.diferenca_centavos || 0) / 100).toFixed(2).replace('.', ',')}.`
      : '';
    return `${preparacao.mensagem || preparacao.error || 'Não foi possível preparar a venda no PDV.'}${complemento}`;
  }

  async function requisitarPreparacaoVendaPdv(id) {
    const resp = await fetch(
      `${API_URL}/pedidos/${id}/preparar-venda-pdv`,
      { method: 'POST', headers: _pedHeaders(), body: '{}' }
    );
    const preparacao = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const erro = new Error(montarDiagnosticoPreparacao(preparacao));
      erro.codigo = preparacao.codigo || preparacao.code || null;
      erro.consolidacao_id = preparacao.consolidacao_id || null;
      throw erro;
    }
    return preparacao;
  }

  async function liberarConsolidacaoPedido(consolidacaoId) {
    const id = Number(consolidacaoId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const resp = await fetch(
      `${API_URL}/pedidos/venda-consolidada-mesa/${id}/liberar`,
      { method: 'POST', headers: _pedHeaders(), body: '{}' }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const erro = new Error(data.mensagem || data.error || 'Não foi possível liberar a consolidação da mesa.');
      erro.codigo = data.codigo || null;
      throw erro;
    }
    return true;
  }

  async function requisitarFinalizacaoVendaPdv(id) {
    const resp = await fetch(
      `${API_URL}/pedidos/${id}/finalizar-venda-pdv`,
      { method: 'POST', headers: _pedHeaders(), body: '{}' }
    );
    const resultado = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(resultado.mensagem || resultado.error || `Falha ao concluir o vínculo da venda (HTTP ${resp.status}).`);
    }
    return resultado;
  }

  function limparHandoffPedido(id) {
    try {
      const handoff = sessionStorage.getItem('pdvPedidoHandoff');
      if (handoff && Number(JSON.parse(handoff).pedido_id) === id) {
        sessionStorage.removeItem('pdvPedidoHandoff');
      }
    } catch (erroHandoff) {
      console.error('Falha ao validar o handoff do Pedido no PDV.', erroHandoff);
    }
  }

  async function concluirVinculoVendaPdv(id, vendaId, confirmar = true) {
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(vendaId) || vendaId <= 0) {
      alertar('Não foi possível identificar o Pedido e a venda para concluir o vínculo.', 'danger');
      return;
    }
    if (operacoesVendaPdvPendentes.has(id)) return;
    if (confirmar && !window.confirm(
      `A venda #${vendaId} do Pedido #${id} já foi criada. Deseja concluir o vínculo do Pedido?`
    )) return;

    operacoesVendaPdvPendentes.add(id);
    try {
      const resultado = await requisitarFinalizacaoVendaPdv(id);
      const vendaConcluidaId = Number(resultado.venda_id) || vendaId;
      limparHandoffPedido(id);
      alertar(
        `Venda #${vendaConcluidaId} vinculada ao Pedido #${id}${resultado.idempotente ? ' (operação já concluída).' : '.'}`,
        'success'
      );
      await carregarLista();
    } catch (erro) {
      alertar(`A venda foi preservada, mas o vínculo não foi concluído: ${erro.message}`, 'danger');
    } finally {
      operacoesVendaPdvPendentes.delete(id);
    }
  }

  async function iniciarVendaPdv(id, confirmar = true, mensagemConfirmacao) {
    if (!Number.isInteger(id) || id <= 0) {
      alertar('Pedido inválido para gerar venda no PDV.', 'danger');
      return;
    }
    if (operacoesVendaPdvPendentes.has(id)) return;
    if (confirmar && !window.confirm(
      mensagemConfirmacao || `Pedido #${id}: deseja gerar a venda deste pedido no PDV?`
    )) return;

    operacoesVendaPdvPendentes.add(id);
    try {
      let preparacao;
      try {
        preparacao = await requisitarPreparacaoVendaPdv(id);
      } catch (erroPrep) {
        if (
          erroPrep.codigo === 'PEDIDO_EM_CONSOLIDACAO'
          && Number(erroPrep.consolidacao_id) > 0
        ) {
          await liberarConsolidacaoPedido(erroPrep.consolidacao_id);
          preparacao = await requisitarPreparacaoVendaPdv(id);
        } else {
          throw erroPrep;
        }
      }
      if (preparacao.venda_concluida) {
        alertar(`Este Pedido já possui a venda ${preparacao.venda_id || ''} concluída.`, 'info');
        await carregarLista();
        return;
      }
      const vendaId = Number(preparacao.venda_id);
      if (Number.isInteger(vendaId) && vendaId > 0) {
        const resultado = await requisitarFinalizacaoVendaPdv(id);
        limparHandoffPedido(id);
        alertar(
          `Venda #${Number(resultado.venda_id) || vendaId} vinculada ao Pedido #${id}${resultado.idempotente ? ' (operação já concluída).' : '.'}`,
          'success'
        );
        await carregarLista();
        return;
      }
      if (typeof window.abrirPdvOficial === 'function') {
        const resultado = await window.abrirPdvOficial({ handoff: preparacao });
        if (resultado && resultado.ok === false) {
          throw new Error(resultado.mensagem || 'Não foi possível abrir o PDV.');
        }
        return;
      }
      sessionStorage.setItem('pdvPedidoHandoff', JSON.stringify(preparacao));
      window.location.assign('/pdv');
    } catch (erro) {
      alertar(
        `O Pedido foi preservado, mas a venda não pôde ser gerada ou recuperada: ${erro.message}`,
        'danger'
      );
    } finally {
      operacoesVendaPdvPendentes.delete(id);
    }
  }

  /* ---- Mesas: apenas cadastro por empresa e seleção no pedido ---- */
  function alertarMesas(msg, tipo) {
    $('#pedMesasAlert').html(`<div class="alert alert-${tipo || 'info'} py-2 mb-2">${escapeHtml(msg)}</div>`);
  }

  async function requisitarMesas(url, method, corpo, opcoes = {}) {
    headers = _pedHeaders();
    const headersReq = { ...headers };
    if (opcoes.idempotencyKey) headersReq['Idempotency-Key'] = opcoes.idempotencyKey;
    const resp = await fetch(`${API_URL}/mesas${url || ''}`, {
      method: method || 'GET',
      headers: headersReq,
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.mensagem || data.error || ('HTTP ' + resp.status));
      err.codigo = data.codigo || null;
      throw err;
    }
    return data;
  }

  /** Mesa livre/encerrada: abre atendimento antes do POST do pedido. FECHAMENTO continua bloqueado. */
  async function garantirAtendimentoAbertoParaNovoPedido(mesaId) {
    const id = Number(mesaId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const consulta = await requisitarMesas(`/${id}/atendimento`);
    const situacao = String(consulta.situacao || '').toUpperCase();
    if (situacao === 'OCUPADA' && consulta.atendimento && consulta.atendimento.id) {
      return consulta;
    }
    if (situacao === 'FECHAMENTO') {
      const err = new Error('O atendimento está em fechamento e não recebe pedido novo.');
      err.codigo = 'ATENDIMENTO_EM_FECHAMENTO';
      throw err;
    }
    const aberto = await requisitarMesas(
      `/${id}/atendimento`,
      'POST',
      {
        cliente_id: $('#pedClienteId').val() ? Number($('#pedClienteId').val()) : null
      },
      { idempotencyKey: novaChaveIdempotencia() }
    );
    return {
      mesa_id: id,
      numero: consulta.numero,
      situacao: 'OCUPADA',
      atendimento: aberto && aberto.atendimento
    };
  }

  async function preencherSelectMesa(mesaIdPedido, mesaNumeroPedido) {
    const $sel = $('#pedMesaId');
    $sel.html('<option value="">— Sem mesa —</option>');
    $('#pedMesaAviso').removeClass('text-danger').text('Carregando mesas…');
    try {
      const data = await requisitarMesas('?ativas=1');
      const mesas = data.itens || [];
      mesas.forEach((m) => {
        $sel.append(`<option value="${m.id}">Mesa ${escapeHtml(m.numero)}</option>`);
      });
      if (mesaIdPedido && !mesas.some((m) => Number(m.id) === Number(mesaIdPedido))) {
        $sel.append(`<option value="${mesaIdPedido}">Mesa ${escapeHtml(mesaNumeroPedido != null ? mesaNumeroPedido : mesaIdPedido)} (desativada)</option>`);
      }
      $sel.val(mesaIdPedido ? String(mesaIdPedido) : '');
      $('#pedMesaAviso').text(mesas.length ? '' : 'Nenhuma mesa ativa. Cadastre em "Mesas".');
    } catch (err) {
      if (mesaIdPedido) {
        $sel.append(`<option value="${mesaIdPedido}">Mesa ${escapeHtml(mesaNumeroPedido != null ? mesaNumeroPedido : mesaIdPedido)}</option>`);
        $sel.val(String(mesaIdPedido));
      }
      $('#pedMesaAviso').addClass('text-danger').text('Falha ao carregar mesas: ' + err.message);
    }
    atualizarAcaoMesa();
  }

  async function renderMesas() {
    $('#pedMesasBody').html('<tr><td colspan="3" class="text-center text-muted py-3">Carregando…</td></tr>');
    try {
      const data = await requisitarMesas();
      const mesas = data.itens || [];
      if (!mesas.length) {
        $('#pedMesasBody').html('<tr><td colspan="3" class="text-center text-muted py-3">Nenhuma mesa cadastrada.</td></tr>');
        return;
      }
      $('#pedMesasBody').html(mesas.map((m) => `
        <tr data-id="${m.id}" data-numero="${escapeHtml(m.numero)}">
          <td class="ped-mesa-nome">Mesa ${escapeHtml(m.numero)}</td>
          <td>${m.ativo ? '<span class="badge bg-success">Ativa</span>' : '<span class="badge bg-secondary">Desativada</span>'}</td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-primary ped-mesa-editar" title="Editar número"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn btn-sm ${m.ativo ? 'btn-outline-danger' : 'btn-outline-success'} ped-mesa-toggle" data-ativo="${m.ativo ? 1 : 0}" title="${m.ativo ? 'Desativar' : 'Ativar'}">
              <i class="fas ${m.ativo ? 'fa-ban' : 'fa-check'}"></i>
            </button>
          </td>
        </tr>`).join(''));
    } catch (err) {
      $('#pedMesasBody').html(`<tr><td colspan="3" class="text-danger text-center py-3">${escapeHtml(err.message)}</td></tr>`);
    }
  }

  async function abrirMesas() {
    if (!_pedEmpresaSelecionada()) {
      alertar('Selecione a empresa antes de gerenciar as mesas.', 'warning');
      return;
    }
    $('#pedMesasAlert').empty();
    $('#pedMesaNovoNumero').val('');
    new bootstrap.Modal(document.getElementById('modalPedMesas')).show();
    await renderMesas();
  }

  async function cadastrarMesa() {
    const numero = $('#pedMesaNovoNumero').val();
    try {
      const data = await requisitarMesas('', 'POST', { numero });
      $('#pedMesaNovoNumero').val('');
      alertarMesas(`Mesa ${data.mesa.numero} cadastrada.`, 'success');
      await renderMesas();
    } catch (err) {
      alertarMesas(err.message, 'danger');
    }
  }

  async function salvarEdicaoMesa(id, numero) {
    try {
      const data = await requisitarMesas(`/${id}`, 'PUT', { numero });
      alertarMesas(`Mesa ${data.mesa.numero} atualizada.`, 'success');
    } catch (err) {
      alertarMesas(err.message, 'danger');
    }
    await renderMesas();
  }

  async function alternarMesa(id, ativoAtual) {
    try {
      const data = await requisitarMesas(`/${id}`, 'PUT', { ativo: !ativoAtual });
      alertarMesas(`Mesa ${data.mesa.numero} ${data.mesa.ativo ? 'ativada' : 'desativada'}.`, 'success');
    } catch (err) {
      alertarMesas(err.message, 'danger');
    }
    await renderMesas();
  }

  function limparEditor() {
    pedidoEditandoId = null;
    pedidoEditandoStatus = null;
    pedidoEdicaoBloqueada = false;
    pedidoSomenteConsulta = false;
    representanteAtual = null;
    freteAtual = 0;
    itensEditor = [];
    precoSugestaoSelecionada = null;
    produtoSelecionadoParaPedido = null;
    adicionarPersonalizacaoPendente = null;
    clienteSelecionado = null;
    linhaGradeFoco = -1;
    fecharSugestoes();
    $('#pedEditorTitulo').text('Novo pedido');
    $('#btnPedImprimir').prop('disabled', true);
    $('#pedClienteId').val('');
    $('#pedClienteBusca').val('');
    $('#pedClienteSelecionadoLabel').text('Sem cliente — digite um nome se desejar');
    $('#pedDesconto').val('0');
    $('#pedObservacao').val('');
    $('#pedMesaId').val('');
    $('#pedProdutoBusca').val('');
    $('#pedProdutoId').val('');
    $('#pedProdutoNome').val('');
    $('#pedProdutoCodigo').val('');
    $('#pedItemQtd').val('1');
    $('#pedItemPreco').val('');
    $('#pedItemDesc').val('0');
    configurarModoLeituraPedido(null);
    renderItens();
  }

  function configurarModoLeituraPedido(pedido) {
    const status = String(pedido?.status || '').toUpperCase();
    const vendaVinculada = pedido?.venda_vinculada === true
      || Number(pedido?.venda_id) > 0
      || Number(pedido?.venda_pdv_id) > 0;
    const finalizacaoConfirmada = pedido?.finalizacao_confirmada === true
      || Number(pedido?.finalizacao_confirmada) === 1
      || status === 'FATURADO'
      || String(pedido?.venda_pdv_status || '').toUpperCase() === 'FINALIZADA';
    pedidoEditandoStatus = status || null;
    pedidoEdicaoBloqueada = pedido?.edicao_bloqueada === true
      || Number(pedido?.edicao_bloqueada) === 1
      || ['FATURADO', 'CANCELADO'].includes(status)
      || vendaVinculada
      || finalizacaoConfirmada;
    pedidoSomenteConsulta = pedido?.somente_consulta === true
      || Number(pedido?.somente_consulta) === 1
      || ['FATURADO', 'CANCELADO'].includes(status)
      || finalizacaoConfirmada;

    let aviso = '';
    if (pedidoEdicaoBloqueada) {
      aviso = status === 'CANCELADO'
        ? 'Este pedido está cancelado. A edição está bloqueada.'
        : finalizacaoConfirmada || pedidoSomenteConsulta
          ? 'Este pedido já foi finalizado e faturado. A edição está bloqueada.'
          : 'Este pedido possui uma venda vinculada. A edição está bloqueada.';
    }
    $('#pedEditorBloqueioAviso').text(aviso).toggleClass('d-none', !aviso);
    $('#pedMesaId, #pedClienteBusca, #pedClienteId, #pedDesconto, #pedObservacao, #pedProdutoBusca, #pedProdutoId, #pedProdutoNome, #pedProdutoCodigo, #pedItemQtd, #pedItemPreco, #pedItemDesc, #btnPedAddItem')
      .prop('disabled', pedidoEdicaoBloqueada);
    $('#pedClienteSugestoes, #pedProdutoSugestoes').hide().empty();
    $('#pedPersonalizacaoModal input, #btnPedConfirmarPersonalizacao')
      .prop('disabled', pedidoEdicaoBloqueada);
    $('#btnPedSalvar, #btnPedFinalizar')
      .prop('hidden', pedidoEdicaoBloqueada)
      .prop('disabled', pedidoEdicaoBloqueada);
    atualizarAcaoMesa();
  }

  function atualizarAcaoMesa() {
    const temMesa = !!$('#pedMesaId').val();
    $('#btnPedFinalizar').prop('hidden', pedidoEdicaoBloqueada || !temMesa);
  }

  function focarAoAbrirModal() {
    const el = document.getElementById('modalPedidoEditor');
    if (!el) return;
    const handler = () => {
      if (!pedidoEdicaoBloqueada) {
        setTimeout(() => {
          if (document.getElementById('modalPedidoEditor') !== el || !el.classList.contains('show')) return;
          const ativo = document.activeElement;
          const dialogo = el.querySelector('.modal-dialog');
          if (ativo !== document.body && ativo !== el && ativo !== dialogo) return;
          const campoProduto = document.getElementById('pedProdutoBusca');
          if (campoProduto && !campoProduto.disabled) campoProduto.focus();
        }, 50);
      }
      el.removeEventListener('shown.bs.modal', handler);
    };
    el.addEventListener('shown.bs.modal', handler);
  }

  function pintarFaixaMesa(decisao) {
    const api = window.CdsMesasLancamento;
    const host = document.getElementById('pedMesaLancamentoHost');
    if (!host) return;
    host.innerHTML = api && decisao ? api.htmlFaixa(decisao) : '';
    mesaFechamentoId = decisao && decisao.bloqueado && decisao.situacao === 'FECHAMENTO'
      ? decisao.mesa_id
      : null;
  }

  async function consultarPedidoDaMesa(ctx) {
    const api = window.CdsMesasConferencia;
    const seq = ++cdsConsultaPedidoSeq;
    if (conferencia) {
      conferencia.dispensar();
      pintarConferencia();
    }
    try {
      const consulta = await requisitarMesas(`/${ctx.mesa_id}/atendimento`);
      if (seq !== cdsConsultaPedidoSeq) return;
      const resp = await fetch(`${API_URL}/pedidos/${ctx.pedido_id}`, { headers: _pedHeaders() });
      const data = await resp.json().catch(() => null);
      if (seq !== cdsConsultaPedidoSeq) return;
      if (!resp.ok || !data || !data.pedido) {
        const err = new Error((data && (data.mensagem || data.error)) || 'O pedido não foi encontrado.');
        err.codigo = (data && data.codigo) || 'PEDIDO_NAO_ENCONTRADO';
        throw err;
      }
      const lista = await requisitarMesas(`/${ctx.mesa_id}/atendimento/pedidos`);
      if (seq !== cdsConsultaPedidoSeq) return;
      const item = (lista.pedidos || []).find((row) => Number(row.id) === Number(data.pedido.id));
      const pedido = {
        ...data.pedido,
        preparacao: item && item.preparacao,
        despacho: item && item.despacho
      };
      pedido.mesa_atendimento_id = item ? item.mesa_atendimento_id : null;
      const decisao = api.decidirConsultaPedido(consulta, pedido, { geracao: seq, geracaoAtual: cdsConsultaPedidoSeq });
      if (!decisao.abrir) {
        pintarFaixaMesa({
          bloqueado: true,
          numero: consulta.numero,
          situacao: consulta.situacao,
          titulo: window.CdsMesasLancamento.tituloMesa(consulta.numero),
          mensagem: decisao.mensagem || 'O pedido não pôde ser aberto.'
        });
        return;
      }
      conferencia.finalizar(pedido, { numero: consulta.numero });
      pintarConferencia();
      window.CdsMesasLancamento.consumirConsultaPedido(window.sessionStorage);
    } catch (err) {
      if (seq !== cdsConsultaPedidoSeq) return;
      if (!err.codigo) err.rede = true;
      if (conferencia) {
        conferencia.dispensar();
        pintarConferencia();
      }
      pintarFaixaMesa({
        bloqueado: true,
        numero: ctx.mesa_id,
        situacao: '',
        titulo: 'Mesa do Controle de Mesas',
        mensagem: err.rede ? 'Não foi possível consultar o pedido. Os dados anteriores não foram mantidos.' : (err.message || 'Não foi possível consultar o pedido.')
      });
    }
  }

  async function aplicarLancamentoDaMesa() {
    const api = window.CdsMesasLancamento;
    if (!api || !window.sessionStorage) return;
    const empresaId = _pedEmpresaSelecionada() && window.CdsEmpresaContexto.lerEmpresaId
      ? window.CdsEmpresaContexto.lerEmpresaId()
      : null;
    const ctx = api.lerLancamento(window.sessionStorage, empresaId);
    if (!ctx) return;
    if (ctx.pedido_id && window.CdsMesasConferencia) {
      await consultarPedidoDaMesa(ctx);
      return;
    }
    const intencao = api.temIntencaoModal(window.sessionStorage, empresaId);
    if (intencao) {
      if (cdsAberturaMesaEmCurso) return;
      cdsAberturaMesaEmCurso = true;
    }
    try {
      const data = await requisitarMesas(`/${ctx.mesa_id}/atendimento`);
      const decisao = api.decidirAberturaModal(data, {
        modalAberto: modalAberto(),
        intencao
      });
      pintarFaixaMesa(decisao);
      if (decisao.abrirModal) {
        await abrirEditor(null, decisao);
        api.consumirIntencaoModal(window.sessionStorage);
      }
    } catch (err) {
      pintarFaixaMesa({
        bloqueado: true,
        numero: ctx.mesa_id,
        situacao: '',
        titulo: 'Mesa do Controle de Mesas',
        mensagem: err && err.rede
          ? 'Não foi possível confirmar o atendimento da mesa.'
          : (err.message || 'Não foi possível confirmar o atendimento da mesa.')
      });
    } finally {
      if (intencao) cdsAberturaMesaEmCurso = false;
    }
  }

  async function abrirEditor(id, decisao) {
    $('#btn-restaurar-modalPedidoEditor').remove();
    if (!_pedEmpresaSelecionada()) {
      alertar('Selecione a empresa antes de abrir um pedido.', 'warning');
      return;
    }
    headers = _pedHeaders();
    limparEditor();
    if (!id) {
      if (modalAberto()) return;
      $('#btnPedImprimir').prop('disabled', true);
      if (decisao && decisao.titulo) $('#pedEditorTitulo').text(decisao.titulo);
      if (decisao && decisao.mesa_id) {
        const $sel = $('#pedMesaId');
        if (!$sel.find(`option[value="${decisao.mesa_id}"]`).length) {
          $sel.append(`<option value="${decisao.mesa_id}">Mesa ${escapeHtml(decisao.numero)}</option>`);
        }
        $sel.val(String(decisao.mesa_id));
        atualizarAcaoMesa();
      }
      if (decisao && Number(decisao.cliente_id) > 0) {
        const clienteId = Number(decisao.cliente_id);
        const clienteNome = decisao.cliente_nome || '';
        clienteSelecionado = { id: clienteId, nome: clienteNome };
        $('#pedClienteId').val(clienteId);
        $('#pedClienteBusca').val(clienteNome);
        $('#pedClienteSelecionadoLabel').text(clienteNome || `Cliente nº ${clienteId}`);
      }
      const editor = document.getElementById('modalPedidoEditor');
      if (editor) {
        focarAoAbrirModal();
        bootstrap.Modal.getOrCreateInstance(editor).show();
      }
      await preencherSelectMesa(
        decisao && decisao.mesa_id ? decisao.mesa_id : null,
        decisao ? decisao.numero : null
      );
      return;
    }
    try {
      const resp = await fetch(`${API_URL}/pedidos/${id}`, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.mensagem || data.error || 'Falha ao carregar');
      const p = data.pedido;
      pedidoEditandoId = p.id;
      configurarModoLeituraPedido(p);
      representanteAtual = p.representante_nome || null;
      freteAtual = Number(p.frete || 0);
      $('#btnPedImprimir').prop('disabled', false);
      $('#pedEditorTitulo').text('Editar pedido ' + (p.codigo || ('#' + p.id)));
      clienteSelecionado = (p.cliente_id || p.cliente_nome)
        ? { id: p.cliente_id || null, nome: p.cliente_nome || '' }
        : null;
      $('#pedClienteId').val(p.cliente_id || '');
      $('#pedClienteBusca').val(p.cliente_nome || '');
      $('#pedClienteSelecionadoLabel').text(
        p.cliente_nome
          ? (p.cliente_id ? p.cliente_nome : `Nome no pedido: ${p.cliente_nome}`)
          : 'Sem cliente — digite um nome se desejar'
      );
      $('#pedDesconto').val(p.desconto || 0);
      $('#pedObservacao').val(p.observacao || '');
      itensEditor = (p.itens || []).map((i) => ({
        id: i.id,
        editor_id: `pedido-${i.id}`,
        produto_id: i.produto_id,
        produto_nome: i.produto_nome,
        produto_codigo: i.produto_codigo,
        quantidade: Number(i.quantidade),
        preco_unitario: Number(i.preco_unitario),
        desconto_percentual: Number(i.desconto_percentual || 0),
        subtotal: Number(i.subtotal),
        tipo_venda: i.tipo_venda || 'PESO',
        preco_venda_snapshot: i.preco_venda_snapshot ?? null,
        preco_pedido_snapshot: i.preco_pedido_snapshot ?? null,
        preco_sugerido_snapshot: i.preco_sugerido_snapshot ?? null,
        origem_preco_sugerido: i.origem_preco_sugerido ?? null,
        personalizacao_ingredientes_snapshot: Number(i.personalizacao_ingredientes_snapshot) === 1 ? 1 : 0,
        preco_base_unitario_snapshot: i.preco_base_unitario_snapshot ?? null,
        preco_adicionais_unitario_snapshot: i.preco_adicionais_unitario_snapshot ?? null,
        ingredientes_personalizados: Array.isArray(i.ingredientes_personalizados)
          ? i.ingredientes_personalizados
          : []
      }));
      renderItens();
      await preencherSelectMesa(p.mesa_id, p.mesa_numero);
      await bloquearSeJaEnviado(p);
      focarAoAbrirModal();
      new bootstrap.Modal(document.getElementById('modalPedidoEditor')).show();
    } catch (err) {
      alertar(err.message, 'danger');
    }
  }

  /** RC3.16.1 — autorização supervisor para transferência NF→F via Motor Comercial. */
  function solicitarAutorizacaoSupervisor(mensagem) {
    return new Promise((resolve) => {
      const existente = document.getElementById('pedSupervisorAuthModal');
      if (existente) existente.remove();

      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="modal fade" id="pedSupervisorAuthModal" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Autorização de Supervisor</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
              </div>
              <div class="modal-body">
                <p class="mb-3">${escapeHtml(mensagem || 'É necessária autorização do supervisor.')}</p>
                <div class="mb-2">
                  <label for="pedSupervisorUser" class="form-label">Usuário</label>
                  <input type="text" class="form-control" id="pedSupervisorUser" autocomplete="username">
                </div>
                <div class="mb-2">
                  <label for="pedSupervisorPass" class="form-label">Senha</label>
                  <input type="password" class="form-control" id="pedSupervisorPass" autocomplete="current-password">
                </div>
                <div id="pedSupervisorAuthError" class="text-danger small" style="display:none;"></div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="pedSupervisorCancel">Cancelar</button>
                <button type="button" class="btn btn-primary" id="pedSupervisorOk">Autorizar</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(wrap.firstElementChild);
      const modalEl = document.getElementById('pedSupervisorAuthModal');
      const modal = new bootstrap.Modal(modalEl);
      let resolvido = false;

      const finalizar = (token) => {
        if (resolvido) return;
        resolvido = true;
        modal.hide();
        setTimeout(() => modalEl.remove(), 300);
        resolve(token);
      };

      modalEl.addEventListener('hidden.bs.modal', () => {
        if (!resolvido) finalizar(null);
      }, { once: true });

      $('#pedSupervisorOk').off('click').on('click', async () => {
        const username = $('#pedSupervisorUser').val().trim();
        const password = $('#pedSupervisorPass').val();
        const errorEl = $('#pedSupervisorAuthError');
        errorEl.hide();
        if (!username || !password) {
          errorEl.text('Informe usuário e senha.').show();
          return;
        }
        try {
          const resp = await fetch(`${API_URL}/auth/supervisor/authorize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ username, password })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error || data.mensagem || 'Falha na autorização');
          finalizar(data.token || null);
        } catch (err) {
          errorEl.text(err.message || 'Falha na autorização').show();
        }
      });

      modal.show();
    });
  }

  async function fetchPedidoComSupervisor(url, method, payloadBase) {
    let payload = { ...payloadBase };
    const criandoPedido = method === 'POST' && url === `${API_URL}/pedidos`;
    if (criandoPedido) {
      const assinatura = JSON.stringify(payloadBase);
      if (!chaveCriacaoPendente || assinaturaCriacaoPendente !== assinatura) {
        chaveCriacaoPendente = novaChaveIdempotencia();
        assinaturaCriacaoPendente = assinatura;
      }
    }
    const headersOperacao = criandoPedido
      ? { ...headers, 'Idempotency-Key': chaveCriacaoPendente }
      : headers;
    let resp = await fetch(url, { method, headers: headersOperacao, body: JSON.stringify(payload) });
    let data = await resp.json().catch(() => ({}));
    if (
      resp.status === 409
      && (data.codigo === 'REQUER_AUTORIZACAO_SUPERVISOR' || data.requer_autorizacao)
    ) {
      const token = await solicitarAutorizacaoSupervisor(data.mensagem || data.error);
      if (!token) {
        const err = new Error('Autorização de supervisor cancelada.');
        err.codigo = 'AUTORIZACAO_REJEITADA';
        throw err;
      }
      payload = { ...payloadBase, supervisor_token: token };
      resp = await fetch(url, { method, headers: headersOperacao, body: JSON.stringify(payload) });
      data = await resp.json().catch(() => ({}));
    }
    if (!resp.ok) {
      const err = new Error(data.mensagem || data.error || 'Falha na operação');
      err.codigo = data.codigo;
      throw err;
    }
    return data;
  }

  const conferencia = window.CdsMesasConferencia
    ? window.CdsMesasConferencia.criarConferencia({
      novaChave: novaChaveIdempotencia,
      fetchJson: (method, path, chave) => enviarPreparacao(method, path, chave),
      listarPedidos: (mesaId) => requisitarMesas(`/${mesaId}/atendimento/pedidos`)
    })
    : null;

  function pintarConferencia() {
    const host = document.getElementById('pedConferenciaHost');
    if (!host || !conferencia) return;
    host.innerHTML = conferencia.html();
  }

  async function enviarPreparacao(method, path, chave) {
    try {
      const resp = await fetch(`${API_URL}${path}`, {
        method,
        headers: { ..._pedHeaders(), 'Idempotency-Key': chave },
        body: '{}'
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const err = new Error((data && (data.mensagem || data.error)) || 'Falha na operação');
        err.codigo = data && data.codigo;
        throw err;
      }
      if (!data || typeof data !== 'object') {
        const err = new Error('Resposta inválida do servidor.');
        err.codigo = 'RESPOSTA_INVALIDA';
        throw err;
      }
      return data;
    } catch (err) {
      if (!err.codigo) err.rede = true;
      throw err;
    }
  }

  async function bloquearSeJaEnviado(pedido) {
    if (!pedido || pedido.mesa_id == null || pedido.mesa_atendimento_id == null) return;
    try {
      const data = await requisitarMesas(`/${pedido.mesa_id}/atendimento/pedidos`);
      const item = (data.pedidos || []).find((row) => Number(row.id) === Number(pedido.id));
      const estadoPrep = item && item.preparacao && item.preparacao.estado;
      if (estadoPrep && estadoPrep !== 'NAO_ENVIADO') {
        pedidoEdicaoBloqueada = true;
        $('#pedEditorBloqueioAviso')
          .text('Este pedido já foi enviado para preparação. Os itens encaminhados não são alterados por esta tela.')
          .removeClass('d-none');
        $('#btnPedSalvar, #btnPedFinalizar').prop('hidden', true).prop('disabled', true);
        $('#pedMesaId, #pedClienteBusca, #pedClienteId, #pedDesconto, #pedObservacao, #pedProdutoBusca, #pedProdutoId, #pedProdutoNome, #pedProdutoCodigo, #pedItemQtd, #pedItemPreco, #pedItemDesc, #btnPedAddItem')
          .prop('disabled', true);
      }
    } catch (_err) {
      $('#pedMesaAviso')
        .addClass('text-danger')
        .text('Não foi possível consultar a preparação. O envio fica indisponível até a consulta.');
    }
  }

  async function salvarPedido() {
    if (pedidoEdicaoBloqueada) {
      alertar($('#pedEditorBloqueioAviso').text() || 'A edição deste pedido está bloqueada.', 'warning');
      return;
    }
    if (!_pedEmpresaSelecionada()) {
      alertar('Selecione a empresa antes de salvar o pedido.', 'warning');
      return;
    }
    if (!itensEditor.length) {
      alertar('Adicione ao menos um item.', 'warning');
      return;
    }
    if (mesaFechamentoId && Number($('#pedMesaId').val()) === Number(mesaFechamentoId)) {
      alertar('O atendimento está em fechamento e não recebe pedido novo.', 'warning');
      return;
    }
    headers = _pedHeaders();
    const t = calcTotaisDetalhe();
    const clienteNomeDigitado = String($('#pedClienteBusca').val() || '').trim();
    const clienteIdSelecionado = $('#pedClienteId').val() ? Number($('#pedClienteId').val()) : null;
    const payload = {
      cliente_id: clienteIdSelecionado,
      cliente_nome: clienteNomeDigitado || null,
      mesa_id: $('#pedMesaId').val() ? Number($('#pedMesaId').val()) : null,
      representante_nome: representanteAtual,
      observacao: $('#pedObservacao').val() || null,
      frete: t.frete,
      desconto: t.desconto,
      total: t.total,
      itens: itensEditor.map((i) => ({
        id: i.id,
        produto_id: i.produto_id,
        quantidade: i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto_percentual: i.desconto_percentual || 0,
        subtotal: i.subtotal,
        tipo_venda: i.tipo_venda || 'PESO',
        preco_venda_snapshot: i.preco_venda_snapshot ?? null,
        preco_pedido_snapshot: i.preco_pedido_snapshot ?? null,
        preco_sugerido_snapshot: i.preco_sugerido_snapshot ?? null,
        origem_preco_sugerido: i.origem_preco_sugerido ?? null,
        ...(Number(i.personalizacao_ingredientes_snapshot) === 1 ? {
          preco_base_unitario: i.preco_base_unitario_snapshot,
          ingredientes_selecionados: (i.ingredientes_personalizados || [])
            .filter((ingrediente) => Number(ingrediente.selecionado) === 1
              && ingrediente.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
            .map((ingrediente) => Number(ingrediente.insumo_id))
        } : {})
      }))
    };
    if (!pedidoEditandoId) {
      payload.tipo = 'pedido';
      payload.status = 'PEDIDO';
    }
    try {
      // Criação ou edição: atribuir mesa exige atendimento aberto (senão a mesa fica LIVRE).
      if (payload.mesa_id) {
        await garantirAtendimentoAbertoParaNovoPedido(payload.mesa_id);
      }
      const url = pedidoEditandoId ? `${API_URL}/pedidos/${pedidoEditandoId}` : `${API_URL}/pedidos`;
      const method = pedidoEditandoId ? 'PUT' : 'POST';
      const data = await fetchPedidoComSupervisor(url, method, payload);
      const pedido = data && data.pedido;
      if (!pedido || !pedido.id) {
        alertar('O pedido não foi confirmado pelo servidor.', 'danger');
        return;
      }
      pedidoEditandoId = pedido.id;
      pedidoEditandoStatus = pedido.status || pedidoEditandoStatus;
      $('#btnPedImprimir').prop('disabled', false);
      abaAtual = 'pedidos';
      sincronizarAbas();
      await carregarLista();
      if (method === 'POST') {
        chaveCriacaoPendente = null;
        assinaturaCriacaoPendente = null;
      }
      const salao = window.CdsMesasConferencia && window.CdsMesasConferencia.fluxoDoPedido(pedido) === 'salao';
      if (salao && conferencia) {
        conferencia.finalizar(pedido, { numero: pedido.mesa_numero });
        pintarConferencia();
        bootstrap.Modal.getInstance(document.getElementById('modalPedidoEditor'))?.hide();
        return;
      }
      bootstrap.Modal.getInstance(document.getElementById('modalPedidoEditor'))?.hide();
      if (salao) {
        alertar(`Pedido ${pedido.codigo || ''} salvo. A preparação ainda não foi acionada.`, 'success');
        return;
      }
      alertar(`Pedido ${pedido.codigo || ''} salvo.`, 'success');
      if (method === 'POST' && !data.idempotente) {
        await iniciarVendaPdv(
          Number(pedido.id),
          true,
          'Pedido salvo com sucesso. Deseja gerar a venda deste pedido no PDV?'
        );
      }
    } catch (err) {
      alertar(err.message, 'danger');
    }
  }

  async function cancelarPedido(id) {
    if (!confirm('Cancelar este pedido?')) return;
    try {
      let chave = chavesCancelamentoPendentes.get(Number(id));
      if (!chave) {
        chave = novaChaveIdempotencia();
        chavesCancelamentoPendentes.set(Number(id), chave);
      }
      const resp = await fetch(`${API_URL}/pedidos/${id}/cancelar`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': chave },
        body: '{}'
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.mensagem || data.error || 'Falha ao cancelar');
      alertar('Pedido cancelado.', 'success');
      await carregarLista();
      chavesCancelamentoPendentes.delete(Number(id));
    } catch (err) {
      alertar(err.message, 'danger');
    }
  }

  async function duplicarPedido(id) {
    try {
      let chave = chavesDuplicacaoPendentes.get(Number(id));
      if (!chave) {
        chave = novaChaveIdempotencia();
        chavesDuplicacaoPendentes.set(Number(id), chave);
      }
      const resp = await fetch(`${API_URL}/pedidos/${id}/duplicar`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': chave },
        body: '{}'
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.mensagem || data.error || 'Falha ao duplicar');
      alertar(`Pedido duplicado: ${data.pedido?.codigo || ''}`, 'success');
      await carregarLista();
      chavesDuplicacaoPendentes.delete(Number(id));
    } catch (err) {
      alertar(err.message, 'danger');
    }
  }

  async function imprimirPedido(id) {
    const pedidoId = Number(id || pedidoEditandoId);
    if (!pedidoId) {
      alertar('Salve o pedido antes de imprimir.', 'warning');
      return;
    }
    const out = await imprimirPedidoPorId(pedidoId, 'termico');
    if (!out.ok) alertar(out.error || 'Erro ao abrir visualização.', 'danger');
  }

  function buscarClientes(termo) {
    clearTimeout(timerCliente);
    if (!termo || termo.length < 2) {
      fecharSugestoes('cliente');
      return;
    }
    timerCliente = setTimeout(async () => {
      try {
        const resp = await fetch(`${API_URL}/clientes/buscar?termo=${encodeURIComponent(termo)}`, { headers });
        const rows = await resp.json().catch(() => []);
        if (!Array.isArray(rows) || !rows.length) {
          $('#pedClienteSugestoes').html('<div class="list-group-item text-muted">Nenhum cliente</div>').show();
          sugClienteIdx = -1;
          return;
        }
        $('#pedClienteSugestoes').html(rows.slice(0, 15).map((c, i) => `
          <button type="button" class="list-group-item list-group-item-action ped-pick-cliente ${i === 0 ? 'active' : ''}"
            data-id="${c.id}" data-nome="${escapeHtml(c.nome)}">
            <strong>${escapeHtml(c.nome)}</strong>
            <small class="ped-sugestao-meta d-block">${escapeHtml(c.cpf_cnpj || '')} ${escapeHtml(c.telefone || '')}</small>
          </button>`).join('')).show();
        sugClienteIdx = 0;
        $('.ped-pick-cliente').off('click').on('click', function () {
          aplicarClienteSelecionado(Number($(this).data('id')), $(this).data('nome'));
        });
      } catch (_) {
        fecharSugestoes('cliente');
      }
    }, 250);
  }

  function buscarProdutos(termo) {
    clearTimeout(timerProduto);
    if (!termo || termo.length < 1) {
      fecharSugestoes('produto');
      return;
    }
    timerProduto = setTimeout(async () => {
      try {
        const resp = await fetch(`${API_URL}/produtos/consulta-pedido/buscar?q=${encodeURIComponent(termo)}&limite=15`, { headers });
        const rows = await resp.json().catch(() => []);
        if (!Array.isArray(rows) || !rows.length) {
          $('#pedProdutoSugestoes').html('<div class="list-group-item text-muted">Nenhum produto</div>').show();
          sugProdutoIdx = -1;
          return;
        }
        $('#pedProdutoSugestoes').html(rows.map((p, i) => {
          const precoComercial = Number(p.preco_promocional != null ? p.preco_promocional : p.preco_venda || 0);
          const origemPreco = p.preco_promocional != null ? 'PROMOCAO' : 'PRECO_VENDA';
          const preco = _pedResolverPrecoSugerido(p, precoComercial, origemPreco).precoInicial;
          return `
          <button type="button" class="list-group-item list-group-item-action ped-pick-produto ${i === 0 ? 'active' : ''}"
            data-id="${p.id}" data-nome="${escapeHtml(p.nome)}" data-codigo="${escapeHtml(p.codigo || '')}"
            data-preco="${preco}" data-origem-preco="${origemPreco}">
            <strong>${escapeHtml(p.codigo || p.id)}</strong> — ${escapeHtml(String(p.nome_comercial || '').trim() || p.nome)}
            <span class="float-end">${fmtMoney(preco)}</span>
          </button>`;
        }).join('')).show();
        sugProdutoIdx = 0;
        $('.ped-pick-produto').off('click').on('click', function () {
          aplicarProdutoSelecionado(
            $(this).data('id'),
            $(this).data('nome'),
            $(this).data('codigo'),
            $(this).data('preco'),
            $(this).data('origem-preco')
          );
        });
      } catch (_) {
        fecharSugestoes('produto');
      }
    }, 250);
  }

  function adicionarItemConfirmado({
    itemEditorId,
    produtoId,
    quantidade,
    precoBase,
    precoAdicionais,
    desconto,
    ingredientes,
    selecao,
    personalizado,
    snapshotPreco
  }) {
    if (pedidoEdicaoBloqueada) return;
    const preco = Number((precoBase + (personalizado ? precoAdicionais : 0)).toFixed(2));
    const subtotal = Number((quantidade * preco * (1 - desconto / 100)).toFixed(2));
    const candidato = {
      produto_id: produtoId,
      produto_nome: $('#pedProdutoNome').val(),
      produto_codigo: $('#pedProdutoCodigo').val(),
      preco_base_unitario_snapshot: personalizado ? precoBase : null,
      preco_adicionais_unitario_snapshot: personalizado ? precoAdicionais : null,
      preco_unitario: preco,
      desconto_percentual: desconto,
      tipo_venda: 'PESO',
      personalizacao_ingredientes_snapshot: personalizado ? 1 : 0,
      ingredientes_personalizados: personalizado ? ingredientes : [],
      ...(snapshotPreco || {})
    };
    let existente = -1;
    if (itemEditorId) {
      existente = itensEditor.findIndex((item) => item.editor_id === itemEditorId);
      if (existente < 0) {
        alertar('O item que seria editado não está mais no Pedido.', 'warning');
        return;
      }
    } else if (personalizado) {
      existente = itensEditor.findIndex((item) => (
        Number(item.personalizacao_ingredientes_snapshot) === 1
        && _pedPersonalizacaoEquivalente(item, candidato)
      ));
    } else {
      existente = itensEditor.findIndex((item) => (
        Number(item.produto_id) === Number(produtoId)
        && Number(item.personalizacao_ingredientes_snapshot) !== 1
      ));
    }
    const itemExistente = existente >= 0 ? itensEditor[existente] : null;
    const row = {
      id: itemExistente?.id,
      editor_id: itemExistente?.editor_id || `novo-${++sequenciaItemEditor}`,
      ...candidato,
      quantidade,
      subtotal,
    };
    if (personalizado) row.ingredientes_selecionados = selecao;
    if (existente >= 0) {
      itensEditor[existente] = row;
    } else {
      itensEditor.push(row);
    }
    precoSugestaoSelecionada = null;
    produtoSelecionadoParaPedido = null;
    $('#pedProdutoId, #pedProdutoNome, #pedProdutoCodigo, #pedProdutoBusca').val('');
    $('#pedItemQtd').val('1');
    $('#pedItemPreco').val('');
    $('#pedItemDesc').val('0');
    renderItens();
    setTimeout(() => $('#pedProdutoBusca').trigger('focus'), 0);
  }

  function atualizarResumoAdicionaisPersonalizacao() {
    const pendente = adicionarPersonalizacaoPendente;
    if (!pendente) return;
    const selecao = $('#pedPersonalizacaoModal input[type="checkbox"]:checked')
      .toArray()
      .map((input) => Number(input.value));
    const totais = _pedCalcularTotaisPersonalizacao({
      precoBase: Number($('#pedPersonalizacaoPrecoBase').val()),
      quantidade: Number($('#pedPersonalizacaoQtd').val()),
      ingredientes: pendente.produto.ficha.itens,
      ingredientesSelecionados: selecao,
      desconto: pendente.desconto
    });
    $('#pedPersonalizacaoAdicionais').text(fmtMoney(totais.precoAdicionais));
    $('#pedPersonalizacaoPrecoUnitario').text(fmtMoney(totais.precoUnitario));
    $('#pedPersonalizacaoTotalItem').text(fmtMoney(totais.subtotal));
  }

  function abrirModalPersonalizacao(produto, valores) {
    if (pedidoEdicaoBloqueada) return;
    const ficha = produto.ficha;
    const existente = valores.itemEditorId
      ? itensEditor.find((item) => item.editor_id === valores.itemEditorId)
      : null;
    const selecionadosExistentes = new Set(
      (existente?.ingredientes_personalizados || [])
        .filter((item) => Number(item.selecionado) === 1
          && item.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
        .map((item) => Number(item.insumo_id))
    );
    adicionarPersonalizacaoPendente = { ...valores, produto };
    $('#pedPersonalizacaoErro').addClass('d-none').text('');
    $('#pedPersonalizacaoQtd').val(valores.quantidade);
    $('#pedPersonalizacaoPrecoBase').val(Number(valores.precoBase).toFixed(2));
    $('#pedPersonalizacaoProduto').text(valores.nome);
    const opcionaisSemAdicional = ficha.itens.filter((item) => item.classificacao_comercial === 'OPCIONAL');
    const opcionaisComAdicional = ficha.itens.filter((item) => item.classificacao_comercial === 'OPCIONAL_COM_ADICIONAL');
    const renderOpcionais = (opcionais) => opcionais.length
      ? opcionais.map((item) => `
      <label class="form-check border-bottom py-2">
        <input class="form-check-input" type="checkbox" value="${Number(item.insumo_id)}"
          data-preco-adicional="${Number(item.preco_adicional || 0)}"
          ${selecionadosExistentes.has(Number(item.insumo_id)) ? 'checked' : ''}>
        <span class="form-check-label">
          <strong>${escapeHtml(item.insumo_nome || ('#' + item.insumo_id))}</strong>
          <span class="text-muted">${escapeHtml(item.quantidade)} ${escapeHtml(item.unidade)}</span>
          ${Number(item.preco_adicional || 0) > 0 ? `<span class="d-block">+ ${fmtMoney(item.preco_adicional)} por unidade</span>` : ''}
        </span>
      </label>`).join('')
      : '<div class="text-muted py-2">Nenhuma opção nesta categoria.</div>';
    $('#pedIngredientesSemAdicional').html(renderOpcionais(opcionaisSemAdicional));
    $('#pedIngredientesComAdicional').html(renderOpcionais(opcionaisComAdicional));
    atualizarResumoAdicionaisPersonalizacao();
    $('#pedIngredientesSemAdicional, #pedIngredientesComAdicional')
      .off('change.pedpersonalizacao', 'input[type="checkbox"]')
      .on('change.pedpersonalizacao', 'input[type="checkbox"]', atualizarResumoAdicionaisPersonalizacao);
    $('#pedPersonalizacaoModal')
      .off('input.pedpersonalizacao change.pedpersonalizacao', '#pedPersonalizacaoQtd')
      .on(
        'input.pedpersonalizacao change.pedpersonalizacao',
        '#pedPersonalizacaoQtd',
        atualizarResumoAdicionaisPersonalizacao
      );

    const editorEl = document.getElementById('modalPedidoEditor');
    const personalizacaoEl = document.getElementById('pedPersonalizacaoModal');
    const modalPersonalizacao = bootstrap.Modal.getOrCreateInstance(personalizacaoEl);
    if ($(editorEl).hasClass('show')) {
      $('#modalPedidoEditor').one('hidden.bs.modal.pedpersonalizacao', () => modalPersonalizacao.show());
      bootstrap.Modal.getInstance(editorEl)?.hide();
    } else {
      modalPersonalizacao.show();
    }
  }

  function confirmarPersonalizacaoPendente() {
    if (pedidoEdicaoBloqueada) return;
    const pendente = adicionarPersonalizacaoPendente;
    if (!pendente) return;
    const quantidade = Number($('#pedPersonalizacaoQtd').val());
    const precoBase = Number($('#pedPersonalizacaoPrecoBase').val());
    if (!(quantidade > 0) || !(precoBase >= 0) || !Number.isFinite(precoBase)) {
      $('#pedPersonalizacaoErro').removeClass('d-none')
        .text('Informe uma quantidade positiva e um preço-base válido.');
      return;
    }
    const selecao = $('#pedPersonalizacaoModal input[type="checkbox"]:checked')
      .toArray()
      .map((input) => Number(input.value));
    const componentes = pendente.produto.ficha.itens.map((item) => {
      const obrigatorio = item.classificacao_comercial === 'OBRIGATORIO_OCULTO';
      const selecionado = obrigatorio || selecao.includes(Number(item.insumo_id));
      return {
        insumo_id: Number(item.insumo_id),
        insumo_nome_snapshot: String(item.insumo_nome || `#${item.insumo_id}`),
        quantidade_snapshot: Number(item.quantidade),
        unidade_snapshot: String(item.unidade),
        classificacao_comercial_snapshot: item.classificacao_comercial,
        selecionado: selecionado ? 1 : 0,
        preco_adicional_snapshot: Number(item.preco_adicional || 0)
      };
    });
    const totais = _pedCalcularTotaisPersonalizacao({
      precoBase,
      quantidade,
      ingredientes: pendente.produto.ficha.itens,
      ingredientesSelecionados: selecao,
      desconto: pendente.desconto
    });
    adicionarItemConfirmado({
      ...pendente,
      quantidade,
      precoBase: Number(precoBase.toFixed(2)),
      precoAdicionais: totais.precoAdicionais,
      ingredientes: componentes,
      selecao,
      personalizado: true
    });
    adicionarPersonalizacaoPendente = null;
    bootstrap.Modal.getInstance(document.getElementById('pedPersonalizacaoModal'))?.hide();
  }

  function adicionarItem() {
    if (pedidoEdicaoBloqueada) return;
    const produtoId = Number($('#pedProdutoId').val());
    const quantidade = Number($('#pedItemQtd').val());
    const precoBase = Number($('#pedItemPreco').val());
    const desconto = Number($('#pedItemDesc').val() || 0);
    if (!(produtoId > 0) || !(quantidade > 0) || !(precoBase >= 0)) {
      alertar('Selecione um produto e informe quantidade/preço.', 'warning');
      $('#pedProdutoBusca').trigger('focus');
      return;
    }
    const personalizado = produtoSelecionadoParaPedido
      && Number(produtoSelecionadoParaPedido.id) === produtoId;
    if (personalizado) {
      abrirModalPersonalizacao(produtoSelecionadoParaPedido, {
        produtoId,
        quantidade,
        precoBase: Number(precoBase.toFixed(2)),
        precoAdicionais: 0,
        desconto,
        nome: $('#pedProdutoNome').val(),
        codigo: $('#pedProdutoCodigo').val(),
        snapshotPreco: precoSugestaoSelecionada
      });
      return;
    }
    adicionarItemConfirmado({
      produtoId,
      quantidade,
      precoBase,
      precoAdicionais: 0,
      desconto,
      personalizado: false,
      snapshotPreco: precoSugestaoSelecionada
    });
  }

  $('#pedPersonalizacaoModal').off('hidden.bs.modal.pedpersonalizacao')
    .on('hidden.bs.modal.pedpersonalizacao', function () {
      if (adicionarPersonalizacaoPendente) adicionarPersonalizacaoPendente = null;
      if ($('#modalPedidoEditor').length && !$('#modalPedidoEditor').hasClass('show')) {
        bootstrap.Modal.getOrCreateInstance(document.getElementById('modalPedidoEditor')).show();
      }
    });

  function modalAberto() {
    return $('#modalPedidoEditor').hasClass('show');
  }

  // —— Teclado / atalhos ——
  $('#pedClienteBusca').on('keydown', function (e) {
    const $box = $('#pedClienteSugestoes');
    const visivel = $box.is(':visible') && $box.find('.list-group-item-action').length;
    if (e.key === 'Escape') {
      e.preventDefault();
      fecharSugestoes('cliente');
      return;
    }
    if (e.key === 'ArrowDown' && visivel) {
      e.preventDefault();
      const max = $box.find('.list-group-item-action').length - 1;
      sugClienteIdx = Math.min(max, sugClienteIdx + 1);
      destacarSugestoes($box, sugClienteIdx);
      return;
    }
    if (e.key === 'ArrowUp' && visivel) {
      e.preventDefault();
      sugClienteIdx = Math.max(0, sugClienteIdx - 1);
      destacarSugestoes($box, sugClienteIdx);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visivel && sugClienteIdx >= 0) {
        selecionarClientePorIdx(sugClienteIdx);
      } else {
        $('#pedProdutoBusca').trigger('focus');
      }
    }
  });

  $('#pedProdutoBusca').on('keydown', function (e) {
    const $box = $('#pedProdutoSugestoes');
    const visivel = $box.is(':visible') && $box.find('.list-group-item-action').length;
    if (e.key === 'Escape') {
      e.preventDefault();
      fecharSugestoes('produto');
      return;
    }
    if (e.key === 'ArrowDown' && visivel) {
      e.preventDefault();
      const max = $box.find('.list-group-item-action').length - 1;
      sugProdutoIdx = Math.min(max, sugProdutoIdx + 1);
      destacarSugestoes($box, sugProdutoIdx);
      return;
    }
    if (e.key === 'ArrowUp' && visivel) {
      e.preventDefault();
      sugProdutoIdx = Math.max(0, sugProdutoIdx - 1);
      destacarSugestoes($box, sugProdutoIdx);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visivel && sugProdutoIdx >= 0) {
        selecionarProdutoPorIdx(sugProdutoIdx);
      } else if ($('#pedProdutoId').val()) {
        $('#pedItemQtd').trigger('focus').select();
      }
    }
  });

  $('#pedItemQtd, #pedItemPreco, #pedItemDesc').on('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      adicionarItem();
    }
    if (e.key === 'Escape') {
      fecharSugestoes();
      $('#pedProdutoBusca').trigger('focus');
    }
  });

  $(document).off('keydown.pedidosUx').on('keydown.pedidosUx', function (e) {
    if (!$('#pedidosRoot').length) return;

    // F2 — Novo Pedido (sempre na tela)
    if (e.key === 'F2') {
      e.preventDefault();
      abrirEditor(null);
      return;
    }

    // Ctrl+F — cliente (modal aberto) ou filtro
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (modalAberto()) {
        if (pedidoEdicaoBloqueada) return;
        $('#pedClienteBusca').trigger('focus').select();
      } else {
        $('#pedFiltroCliente').trigger('focus').select();
      }
      return;
    }

    // Ctrl+S — salvar
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
      if (modalAberto()) {
        e.preventDefault();
        salvarPedido();
      }
      return;
    }

    // Del na grade (quando foco não é input)
    if (modalAberto() && !pedidoEdicaoBloqueada && e.key === 'Delete' && linhaGradeFoco >= 0 && !$(e.target).is('input, textarea, select')) {
      e.preventDefault();
      itensEditor.splice(linhaGradeFoco, 1);
      linhaGradeFoco = -1;
      renderItens();
      $('#pedProdutoBusca').trigger('focus');
    }
  });

  function sincronizarAbas() {
    $('#pedAbas .nav-link').removeClass('active');
    $(`#pedAbas .nav-link[data-aba="${abaAtual}"]`).addClass('active');
  }

  $('#pedAbas').on('click', '.nav-link', function () {
    const aba = String($(this).data('aba') || '');
    if (!aba || aba === abaAtual) return;
    abaAtual = aba;
    sincronizarAbas();
    carregarLista();
  });

  $('#pedidosRoot').on('click', '#btnPedVoltarMesas', () => {
    if (conferencia) conferencia.parar();
    if (typeof loadPage === 'function') loadPage('mesas');
  });
  $('#pedConferenciaHost').on('click', '[data-acao="enviar"]', async () => {
    if (!conferencia) return;
    const geracao = conferencia.estado.geracao;
    const resultado = await conferencia.enviar();
    if (resultado && resultado.obsoleta) return;
    if (geracao !== conferencia.estado.geracao) return;
    pintarConferencia();
  });
  $('#pedConferenciaHost').on('click', '[data-acao="corrigir"]', async () => {
    if (!conferencia) return;
    const resultado = conferencia.corrigir();
    pintarConferencia();
    if (resultado && resultado.ok) await abrirEditor(resultado.pedidoId);
  });
  $('#pedConferenciaHost').on('click', '[data-acao="outro"]', async () => {
    if (!conferencia) return;
    const pedido = conferencia.estado.pedido;
    const numero = conferencia.estado.numero;
    conferencia.dispensar();
    pintarConferencia();
    if (pedido && pedido.mesa_id) {
      await abrirEditor(null, {
        mesa_id: pedido.mesa_id,
        numero,
        titulo: window.CdsMesasLancamento ? window.CdsMesasLancamento.tituloMesa(numero) : 'Novo pedido',
        bloqueado: false
      });
    }
  });
  $('#pedMesaId').on('change', atualizarAcaoMesa);
  $('#btnPedNovo').on('click', () => abrirEditor(null));
  $('#pedConsolidadaConfirmar').on('click', confirmarConsolidada);
  $('#btnPedMesas').on('click', abrirMesas);
  $('#btnPedMesaAdd').on('click', cadastrarMesa);
  $('#pedMesaNovoNumero').on('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); cadastrarMesa(); }
  });
  $('#pedMesasBody').on('click', '.ped-mesa-toggle', function () {
    const $tr = $(this).closest('tr');
    alternarMesa(Number($tr.data('id')), Number($(this).data('ativo')) === 1);
  });
  $('#pedMesasBody').on('click', '.ped-mesa-editar', function () {
    const $tr = $(this).closest('tr');
    $tr.find('.ped-mesa-nome').html(
      `<input type="number" min="1" step="1" class="form-control form-control-sm ped-mesa-edit-num" value="${escapeHtml($tr.data('numero'))}" style="max-width:110px;">`
    );
    $(this).removeClass('ped-mesa-editar btn-outline-primary').addClass('ped-mesa-salvar btn-primary').attr('title', 'Salvar').html('<i class="fas fa-save"></i>');
    $tr.find('.ped-mesa-edit-num').trigger('focus');
  });
  $('#pedMesasBody').on('click', '.ped-mesa-salvar', function () {
    const $tr = $(this).closest('tr');
    salvarEdicaoMesa(Number($tr.data('id')), $tr.find('.ped-mesa-edit-num').val());
  });
  $('#btnPedPesquisar').on('click', carregarLista);
  $('#btnPedSalvar').on('click', salvarPedido);
  $('#btnPedFinalizar').on('click', salvarPedido);
  $('#btnPedImprimir').on('click', () => imprimirPedido(pedidoEditandoId));
  $('#btnPedAddItem').on('click', adicionarItem);
  $('#btnPedConfirmarPersonalizacao').on('click', confirmarPersonalizacaoPendente);
  $('#pedDesconto').on('change input', atualizarTotaisBar);
  $(document).off('cds-empresa-contexto-alterado.ped').on('cds-empresa-contexto-alterado.ped', () => {
    if (!$('#pedidosRoot').length) return;
    headers = _pedHeaders();
    carregarLista();
  });
  $('#pedClienteBusca').on('input', function () {
    $('#pedClienteId').val('');
    const nome = String($(this).val() || '').trim();
    clienteSelecionado = nome ? { id: null, nome } : null;
    $('#pedClienteSelecionadoLabel').text(
      nome ? `Nome no pedido: ${nome}` : 'Sem cliente — digite um nome se desejar'
    );
    buscarClientes($(this).val());
  });
  $('#pedClienteBusca').on('blur', function () {
    const nome = String($(this).val() || '').trim();
    if (!nome) {
      clienteSelecionado = null;
      $('#pedClienteId').val('');
      $('#pedClienteSelecionadoLabel').text('Sem cliente — digite um nome se desejar');
      return;
    }
    if (!$('#pedClienteId').val()) {
      clienteSelecionado = { id: null, nome };
      $('#pedClienteSelecionadoLabel').text(`Nome no pedido: ${nome}`);
    }
  });
  $('#pedProdutoBusca').on('input', function () {
    $('#pedProdutoId').val('');
    buscarProdutos($(this).val());
  });
  $(document).off('click.pedSug').on('click.pedSug', (e) => {
    if (!$(e.target).closest('#pedClienteBusca, #pedClienteSugestoes').length) {
      fecharSugestoes('cliente');
    }
    if (!$(e.target).closest('#pedProdutoBusca, #pedProdutoSugestoes').length) {
      fecharSugestoes('produto');
    }
  });

  ligarSincronizacaoListaPdv();
  carregarLista();
  aplicarLancamentoDaMesa();
}

window.loadPedidos = loadPedidos;
