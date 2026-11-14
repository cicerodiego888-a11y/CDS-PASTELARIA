/**
 * Controle de Mesas no desktop. A ocupação, a preparação e a transferência
 * vêm das APIs já existentes. Este arquivo não recalcula essas regras.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CdsPainelMesasApi = api;
    root.loadControleMesas = function loadControleMesas() {
      if (root.CdsPainelMesas && typeof root.CdsPainelMesas.parar === 'function') {
        root.CdsPainelMesas.parar();
      }
      const painel = api.montarNoNavegador(root);
      root.CdsPainelMesas = painel;
      const host = root.document && root.document.getElementById('page-content');
      return painel.iniciar(host);
    };
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const INTERVALO_MS = 5000;
  const MENSAGENS = Object.freeze({
    MESA_OCUPADA: 'A mesa foi ocupada por outro atendimento. A situação foi atualizada.',
    MESA_LIVRE: 'A mesa de origem não está mais ocupada. A situação foi atualizada.',
    MESA_INATIVA: 'A mesa está desativada.',
    MESA_NAO_ENCONTRADA: 'A mesa não foi encontrada nesta empresa.',
    ATENDIMENTO_EM_FECHAMENTO: 'O atendimento está em fechamento.',
    MESA_DESTINO_IGUAL: 'Escolha uma mesa de destino diferente da origem.',
    CHAVE_IDEMPOTENCIA_DIVERGENTE: 'Esta operação já foi usada em outro contexto.'
  });

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function numeroMesa(numero) {
    const n = Number(numero);
    if (!Number.isInteger(n) || n < 0) return escapar(numero);
    return String(n).padStart(2, '0');
  }

  function parseServidor(valor) {
    if (!valor) return NaN;
    const texto = String(valor).trim().replace(' ', 'T');
    const iso = /Z|[+-]\d{2}:\d{2}$/.test(texto) ? texto : `${texto}Z`;
    return Date.parse(iso);
  }

  function formatarDuracao(segundos) {
    const total = Math.max(0, Math.floor(Number(segundos) || 0));
    const horas = Math.floor(total / 3600);
    const minutos = Math.floor((total % 3600) / 60);
    const resto = total % 60;
    if (horas > 0) return `${horas} h ${minutos} min`;
    return `${minutos} min ${resto} s`;
  }

  function permanencia(abertoEm, agora) {
    const inicio = parseServidor(abertoEm);
    const fim = agora instanceof Date ? agora.getTime() : Number(agora);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return '—';
    return formatarDuracao(Math.floor((fim - inicio) / 1000));
  }

  function contadores(itens) {
    const visiveis = itens || [];
    return {
      livres: visiveis.filter((item) => item.situacao === 'LIVRE' && item.ativo !== false).length,
      ocupadas: visiveis.filter((item) => item.situacao === 'OCUPADA').length,
      fechamento: visiveis.filter((item) => item.situacao === 'FECHAMENTO').length
    };
  }

  function classeSituacao(situacao) {
    if (situacao === 'OCUPADA') return 'mesas-card--ocupada';
    if (situacao === 'FECHAMENTO') return 'mesas-card--fechamento';
    return 'mesas-card--livre';
  }

  function rotuloPreparacao(classificacao) {
    if (classificacao === 'NAO_ENVIADO') return 'Não enviado';
    if (classificacao === 'NORMAL') return 'Normal';
    if (classificacao === 'ATRASADO') return 'Atrasado';
    if (classificacao === 'CRITICO') return 'Crítico';
    if (classificacao === 'CONCLUIDO') return 'Concluído';
    return 'Não enviado';
  }

  function acaoDoPedido(pedido) {
    const api = typeof globalThis !== 'undefined' ? globalThis.CdsMesasConferencia : null;
    if (api && typeof api.acaoDoPedido === 'function') return api.acaoDoPedido(pedido);
    const status = String(pedido && pedido.status || '').toUpperCase();
    const estado = (pedido && pedido.preparacao && pedido.preparacao.estado) || 'NAO_ENVIADO';
    if (status === 'FATURADO' || status === 'CANCELADO' || status === 'ORCAMENTO' || estado === 'EM_PREPARACAO' || estado === 'CONCLUIDO') {
      return { rotulo: 'Ver pedido', editar: false, enviar: false };
    }
    return { rotulo: 'Conferir pedido', editar: true, enviar: true };
  }

  function podeGerarVendaPdv(pedido) {
    const status = String(pedido && pedido.status || '').toUpperCase();
    return ['PEDIDO', 'ABERTO', 'EM_SEPARACAO'].includes(status);
  }

  function rotuloEstadoPreparacao(estado) {
    if (estado === 'EM_PREPARACAO') return 'Em preparação';
    if (estado === 'CONCLUIDO') return 'Concluído';
    return 'Não enviado';
  }

  function filtrarEmpresa(itens, empresaId) {
    return (itens || []).filter((item) => {
      if (empresaId == null || item.empresa_id == null) return true;
      return Number(item.empresa_id) === Number(empresaId);
    });
  }

  function mesasLivres(itens, origemId) {
    return (itens || []).filter((item) => item.ativo !== false
      && item.situacao === 'LIVRE'
      && Number(item.id) !== Number(origemId));
  }

  function criarControlador(deps) {
    const fetchJson = deps.fetchJson;
    const agora = deps.agora || (() => new Date());
    const intervaloMs = deps.intervaloMs || INTERVALO_MS;
    let seq = 0;
    let timer = null;
    let operacao = false;
    const estado = {
      ativo: false,
      emCurso: false,
      geracao: 0,
      empresaId: deps.empresaId != null ? deps.empresaId : null,
      empresaRotulo: deps.empresaRotulo || '',
      itens: [],
      mesaSelecionadaId: null,
      detalhe: null,
      pedidos: [],
      destinoId: '',
      clienteId: '',
      clienteNome: '',
      clientesSugestoes: [],
      clienteBuscaStatus: '',
      aviso: '',
      sucesso: ''
    };

    function mesaAtual() {
      return estado.itens.find((item) => Number(item.id) === Number(estado.mesaSelecionadaId)) || null;
    }

    function agendar() {
      if (!estado.ativo || !deps.agendar) return;
      timer = deps.agendar(async () => {
        timer = null;
        if (!estado.ativo) return;
        await atualizar();
        agendar();
      }, intervaloMs);
    }

    function parar() {
      estado.ativo = false;
      estado.geracao += 1;
      if (timer != null && deps.cancelar) deps.cancelar(timer);
      timer = null;
    }

    async function atualizar() {
      if (!estado.ativo) return { ignorada: true };
      if (estado.emCurso) return { ignorada: true };
      estado.emCurso = true;
      const ticket = ++seq;
      const geracao = estado.geracao;
      const mesaId = estado.mesaSelecionadaId;
      try {
        const data = await fetchJson('GET', '/mesas/situacao');
        if (!estado.ativo || ticket !== seq) return { obsoleta: true };
        estado.itens = filtrarEmpresa(data && data.itens, estado.empresaId);
        if (mesaId != null && geracao === estado.geracao) {
          await carregarDetalhe(mesaId, geracao);
        }
        if (deps.aoMudar && estado.ativo && geracao === estado.geracao) deps.aoMudar();
        return { ok: true };
      } catch (err) {
        estado.aviso = mensagemDe(err);
        return { erro: err };
      } finally {
        if (ticket === seq) estado.emCurso = false;
      }
    }

    async function carregarDetalhe(mesaId, geracao) {
      const detalhe = await fetchJson('GET', `/mesas/${mesaId}/atendimento`);
      if (!estado.ativo || geracao !== estado.geracao || Number(estado.mesaSelecionadaId) !== Number(mesaId)) {
        return { obsoleta: true };
      }
      const pedidos = await fetchJson('GET', `/mesas/${mesaId}/atendimento/pedidos`);
      if (!estado.ativo || geracao !== estado.geracao || Number(estado.mesaSelecionadaId) !== Number(mesaId)) {
        return { obsoleta: true };
      }
      estado.detalhe = detalhe;
      estado.pedidos = (pedidos && pedidos.pedidos) || [];
      const destinoAindaLivre = mesasLivres(estado.itens, mesaId)
        .some((item) => String(item.id) === String(estado.destinoId));
      if (estado.destinoId && !destinoAindaLivre) estado.destinoId = '';
      return { ok: true };
    }

    async function selecionar(mesaId) {
      estado.geracao += 1;
      const geracao = estado.geracao;
      estado.mesaSelecionadaId = Number(mesaId);
      estado.destinoId = '';
      estado.sucesso = '';
      estado.aviso = '';
      const ticket = ++seq;
      estado.emCurso = true;
      try {
        await carregarDetalhe(mesaId, geracao);
      } catch (err) {
        if (geracao === estado.geracao) estado.aviso = mensagemDe(err);
      } finally {
        if (ticket === seq) estado.emCurso = false;
      }
      if (deps.aoMudar && estado.ativo && geracao === estado.geracao) deps.aoMudar();
      return { geracao };
    }

    function fecharModal() {
      estado.geracao += 1;
      estado.mesaSelecionadaId = null;
      estado.detalhe = null;
      estado.pedidos = [];
      estado.destinoId = '';
      estado.clienteId = '';
      estado.clienteNome = '';
      estado.clientesSugestoes = [];
      estado.clienteBuscaStatus = '';
      estado.sucesso = '';
      estado.consultaPedidoId = null;
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
    }

    function abrirPedidoExistente(pedidoId) {
      const mesa = mesaAtual();
      const id = Number(pedidoId);
      if (!mesa || mesa.situacao !== 'OCUPADA' || !Number.isInteger(id) || id <= 0) return { ok: false };
      if (estado.consultaPedidoId === id) return { ok: false, ignorada: true };
      const pedido = (estado.pedidos || []).find((item) => Number(item.id) === id);
      if (!pedido) return { ok: false, codigo: 'PEDIDO_NAO_ENCONTRADO' };
      estado.consultaPedidoId = id;
      estado.geracao += 1;
      const atendimento = (estado.detalhe && estado.detalhe.atendimento) || mesa.atendimento || null;
      if (typeof deps.aoIrParaPedidos === 'function') {
        deps.aoIrParaPedidos({
          mesaId: mesa.id,
          numero: mesa.numero,
          atendimentoId: atendimento && atendimento.id,
          empresaId: estado.empresaId,
          pedidoId: id
        });
      }
      return { ok: true, pedidoId: id, redirecionado: true };
    }

    function atualizarPedidos(lista) {
      if (!estado.ativo) return { obsoleta: true };
      estado.pedidos = Array.isArray(lista) ? lista.slice() : [];
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
      return { ok: true, total: estado.pedidos.length };
    }

    function publicarLancamento(data, mesa) {
      if (typeof deps.aoIrParaPedidos !== 'function' || !mesa) return;
      const atendimento = data && data.atendimento ? data.atendimento : null;
      deps.aoIrParaPedidos({
        mesaId: mesa.id,
        numero: mesa.numero,
        atendimentoId: atendimento && atendimento.id,
        empresaId: estado.empresaId,
        abertoEm: atendimento && atendimento.aberto_em
      });
    }

    async function abrirAtendimento() {
      const mesa = mesaAtual();
      if (!mesa || mesa.situacao !== 'LIVRE' || mesa.ativo === false) return { ok: false };
      if (operacao) return { ok: false, ignorada: true };
      if (estado.clienteNome.trim() && !estado.clienteId) {
        estado.aviso = 'Selecione um cliente cadastrado na lista ou limpe o campo antes de abrir o atendimento.';
        if (deps.aoMudar && estado.ativo) deps.aoMudar();
        return { ok: false, codigo: 'CLIENTE_NAO_SELECIONADO' };
      }
      operacao = true;
      const corpo = {};
      if (String(estado.clienteId || '').trim() !== '') corpo.cliente_id = Number(estado.clienteId);
      try {
        const resultado = await executar('POST', `/mesas/${mesa.id}/atendimento`, corpo, mesa.id);
        if (resultado.ok) publicarLancamento(resultado.data, mesa);
        return resultado;
      } finally {
        operacao = false;
      }
    }

    function lancarPedido() {
      const mesa = mesaAtual();
      if (!mesa || mesa.ativo === false) return { ok: false };
      if (mesa.situacao === 'FECHAMENTO') {
        estado.aviso = 'O atendimento está em fechamento e não recebe pedido novo.';
        estado.sucesso = '';
        if (deps.aoMudar && estado.ativo) deps.aoMudar();
        return { ok: false, codigo: 'ATENDIMENTO_EM_FECHAMENTO' };
      }
      if (mesa.situacao !== 'OCUPADA') return { ok: false };
      const atendimento = (estado.detalhe && estado.detalhe.atendimento) || mesa.atendimento || null;
      publicarLancamento({ atendimento }, mesa);
      return { ok: true, redirecionado: true };
    }

    function verTodosPedidos() {
      const mesa = mesaAtual();
      if (!mesa || !['OCUPADA', 'FECHAMENTO'].includes(mesa.situacao)) return { ok: false };
      const atendimento = (estado.detalhe && estado.detalhe.atendimento) || mesa.atendimento || null;
      if (!atendimento || typeof deps.aoIrParaPedidos !== 'function') return { ok: false };
      deps.aoIrParaPedidos({
        mesaId: mesa.id,
        numero: mesa.numero,
        atendimentoId: atendimento.id,
        empresaId: estado.empresaId,
        visualizarPedidos: true
      });
      return { ok: true, redirecionado: true };
    }

    async function gerarVendaPdv(pedidoId) {
      const id = Number(pedidoId);
      const mesa = mesaAtual();
      const pedido = (estado.pedidos || []).find((item) => Number(item.id) === id);
      if (!mesa || !['OCUPADA', 'FECHAMENTO'].includes(mesa.situacao)) return { ok: false };
      if (!pedido || !podeGerarVendaPdv(pedido)) return { ok: false, codigo: 'PEDIDO_INELIGIVEL_PDV' };
      if (operacao) return { ok: false, ignorada: true };
      const confirmar = typeof deps.confirmar === 'function' ? deps.confirmar : () => true;
      if (!confirmar(`Pedido #${id}: deseja gerar a venda deste pedido no PDV?`)) {
        return { ok: false, cancelado: true };
      }
      operacao = true;
      estado.sucesso = '';
      estado.aviso = '';
      try {
        const preparacao = await fetchJson('POST', `/pedidos/${id}/preparar-venda-pdv`, {});
        if (preparacao && preparacao.venda_concluida) {
          estado.sucesso = `Este Pedido já possui a venda ${preparacao.venda_id || ''} concluída.`;
          if (deps.aoMudar && estado.ativo) deps.aoMudar();
          return { ok: true, venda_concluida: true };
        }
        const vendaId = Number(preparacao && preparacao.venda_id);
        if (Number.isInteger(vendaId) && vendaId > 0) {
          const resultado = await fetchJson('POST', `/pedidos/${id}/finalizar-venda-pdv`, {});
          const vendaFinal = Number(resultado && resultado.venda_id) || vendaId;
          estado.sucesso = `Venda #${vendaFinal} vinculada ao Pedido #${id}${resultado && resultado.idempotente ? ' (operação já concluída).' : '.'}`;
          estado.aviso = '';
          await atualizar();
          return { ok: true, vinculada: true, venda_id: vendaFinal };
        }
        if (typeof deps.aoIrParaPdv === 'function') {
          deps.aoIrParaPdv(preparacao);
        }
        return { ok: true, redirecionado: true, preparacao };
      } catch (err) {
        estado.sucesso = '';
        estado.aviso = `O Pedido foi preservado, mas a venda não pôde ser gerada: ${mensagemDe(err)}`;
        if (deps.aoMudar && estado.ativo) deps.aoMudar();
        return { ok: false, codigo: err && err.codigo };
      } finally {
        operacao = false;
      }
    }

    async function transferir() {
      const mesa = mesaAtual();
      const destino = estado.itens.find((item) => String(item.id) === String(estado.destinoId));
      if (!mesa || mesa.situacao !== 'OCUPADA' || !destino || destino.situacao !== 'LIVRE') {
        estado.aviso = 'Selecione uma mesa livre da empresa para transferir.';
        return { ok: false };
      }
      const resultado = await executar(
        'POST',
        `/mesas/${mesa.id}/atendimento/transferir`,
        { mesa_destino_id: destino.id },
        destino.id
      );
      return resultado;
    }

    async function executar(method, path, corpo, mesaDepois) {
      estado.sucesso = '';
      try {
        const data = await fetchJson(method, path, corpo, chaveNova());
        estado.sucesso = 'Operação concluída.';
        estado.aviso = '';
        estado.emCurso = false;
        if (mesaDepois != null) {
          estado.mesaSelecionadaId = Number(mesaDepois);
          estado.geracao += 1;
        }
        await atualizar();
        return { ok: true, data };
      } catch (err) {
        estado.sucesso = '';
        estado.aviso = mensagemDe(err);
        estado.emCurso = false;
        await atualizar();
        return { ok: false, codigo: err && err.codigo };
      }
    }

    function definirDestino(id) {
      estado.destinoId = id == null ? '' : String(id);
    }

    function definirCliente(valor) {
      estado.clienteId = '';
      estado.clienteNome = valor == null ? '' : String(valor);
      estado.clientesSugestoes = [];
      estado.clienteBuscaStatus = estado.clienteNome.trim().length >= 2
        ? 'Pesquisando clientes...'
        : (estado.clienteNome.trim() ? 'Digite ao menos 2 caracteres para pesquisar.' : 'Pesquise e selecione um cliente cadastrado para vinculá-lo à mesa.');
    }

    function selecionarCliente(id, nome) {
      const clienteId = Number(id);
      if (!Number.isInteger(clienteId) || clienteId <= 0) return false;
      estado.clienteId = String(clienteId);
      estado.clienteNome = String(nome == null ? '' : nome);
      estado.clientesSugestoes = [];
      estado.clienteBuscaStatus = `Cliente selecionado: ${estado.clienteNome || `Cliente nº ${clienteId}`}`;
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
      return true;
    }

    function definirSugestoesClientes(clientes) {
      estado.clientesSugestoes = Array.isArray(clientes) ? clientes : [];
      estado.clienteBuscaStatus = estado.clientesSugestoes.length ? '' : 'Nenhum cliente encontrado.';
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
    }

    function definirErroBuscaCliente(mensagem) {
      estado.clientesSugestoes = [];
      estado.clienteBuscaStatus = mensagem;
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
    }

    async function iniciar() {
      parar();
      estado.ativo = true;
      estado.geracao = 0;
      await atualizar();
      agendar();
      return estado;
    }

    function mensagemDe(err) {
      const codigo = err && (err.codigo || err.code);
      if (codigo && MENSAGENS[codigo]) return MENSAGENS[codigo];
      return (err && err.message) || 'Não foi possível atualizar as mesas.';
    }

    return {
      estado,
      iniciar,
      parar,
      atualizar,
      selecionar,
      fecharModal,
      abrirAtendimento,
      lancarPedido,
      verTodosPedidos,
      abrirPedidoExistente,
      gerarVendaPdv,
      atualizarPedidos,
      transferir,
      definirDestino,
      definirCliente,
      selecionarCliente,
      definirSugestoesClientes,
      definirErroBuscaCliente,
      mesaAtual,
      html: () => htmlPainel(estado, agora())
    };
  }

  function chaveNova() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `mesas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function htmlPainel(estado, instante) {
    const totais = contadores(estado.itens);
    const cards = estado.itens.map((item) => {
      const ocupada = item.situacao === 'OCUPADA' && item.atendimento;
      return `
        <button type="button" class="mesas-card ${classeSituacao(item.situacao)}${item.ativo === false ? ' mesas-card--inativa' : ''}" data-mesa-id="${escapar(item.id)}">
          <span class="mesas-card__numero">${numeroMesa(item.numero)}</span>
          <span class="mesas-card__estado">${escapar(item.situacao || 'LIVRE')}</span>
          ${ocupada ? `<small>Permanência ${escapar(permanencia(item.atendimento.aberto_em, instante))}</small>` : ''}
          ${item.ativo === false ? '<small>Desativada</small>' : ''}
        </button>`;
    }).join('');
    return `
      <section class="mesas-painel" data-painel-mesas="1">
        <header class="mesas-cabecalho">
          <h1>Controle de Mesas</h1>
          <div class="mesas-empresa">${escapar(estado.empresaRotulo || 'Empresa da sessão')}</div>
          <div class="mesas-contadores">
            <span class="mesas-contador" data-contador="livres">Livres ${totais.livres}</span>
            <span class="mesas-contador" data-contador="ocupadas">Ocupadas ${totais.ocupadas}</span>
            <span class="mesas-contador" data-contador="fechamento">Fechamento ${totais.fechamento}</span>
          </div>
        </header>
        ${estado.aviso ? `<div class="alert alert-warning mesas-aviso" role="status">${escapar(estado.aviso)}</div>` : ''}
        ${estado.sucesso ? `<div class="alert alert-success mesas-aviso" role="status">${escapar(estado.sucesso)}</div>` : ''}
        <div class="mesas-grade">${cards || '<p class="text-muted">Nenhuma mesa cadastrada nesta empresa.</p>'}</div>
        ${htmlModal(estado, instante)}
      </section>`;
  }

  function htmlModal(estado, instante) {
    if (estado.mesaSelecionadaId == null) {
      return '<div class="mesas-modal" id="mesasModal" hidden></div>';
    }
    const mesa = (estado.itens || []).find((item) => Number(item.id) === Number(estado.mesaSelecionadaId));
    const detalhe = estado.detalhe || {};
    const atendimento = (detalhe.atendimento) || (mesa && mesa.atendimento) || null;
    const situacao = (detalhe.situacao) || (mesa && mesa.situacao) || 'LIVRE';
    const numero = numeroMesa((detalhe.numero != null ? detalhe.numero : mesa && mesa.numero));
    const livres = mesasLivres(estado.itens, estado.mesaSelecionadaId);
    const sugestoesCliente = (estado.clientesSugestoes || []).map((cliente) => `
      <button type="button" class="list-group-item list-group-item-action py-2" data-acao="selecionar-cliente" data-cliente-id="${escapar(cliente.id)}" data-cliente-nome="${escapar(cliente.nome)}">${escapar(cliente.nome || `Cliente nº ${cliente.id}`)}</button>
    `).join('');
    let corpo = '';
    if (situacao === 'LIVRE') {
      corpo = `
        <p>Estado <strong>LIVRE</strong>.</p>
        ${mesa && mesa.ativo === false ? '<p>Mesa desativada. O atendimento não pode ser aberto.</p>' : `
          <p>Ao abrir, a tela de Pedidos será exibida com esta mesa.</p>
          <label for="mesasCliente">Cliente, se houver</label>
          <input id="mesasCliente" class="form-control form-control-sm" value="${escapar(estado.clienteNome)}" placeholder="Pesquisar por nome, CPF ou telefone" autocomplete="off" aria-describedby="mesasClienteAjuda">
          <input id="mesasClienteId" type="hidden" value="${escapar(estado.clienteId)}">
          <div id="mesasClienteSugestoes" class="list-group shadow-sm" style="${sugestoesCliente ? 'max-height:180px;overflow:auto;position:relative;z-index:2' : 'display:none'}">${sugestoesCliente}</div>
          <div class="form-text mb-2" id="mesasClienteAjuda" role="status">${escapar(estado.clienteBuscaStatus || (estado.clienteId ? `Cliente selecionado: ${estado.clienteNome}` : 'Pesquise e selecione um cliente cadastrado para vinculá-lo à mesa.'))}</div>
          <button type="button" class="btn btn-success" data-acao="abrir">Abrir atendimento</button>`}
      `;
    } else if (situacao === 'FECHAMENTO') {
      corpo = `
        <p>Estado <strong>FECHAMENTO</strong>.</p>
        <p>Esta mesa está em processo de fechamento.</p>
        ${blocoAtendimento(atendimento, instante)}
        ${blocoPedidos(estado.pedidos)}
        <button type="button" class="btn btn-outline-primary mb-3" data-acao="pedidos">Ver todos os pedidos</button>
      `;
    } else {
      const opcoes = livres.map((item) => `
        <option value="${escapar(item.id)}"${String(item.id) === String(estado.destinoId) ? ' selected' : ''}>${numeroMesa(item.numero)}</option>`).join('');
      const destino = livres.find((item) => String(item.id) === String(estado.destinoId));
      corpo = `
        <p>Estado <strong>OCUPADA</strong>.</p>
        ${blocoAtendimento(atendimento, instante)}
        ${blocoPedidos(estado.pedidos)}
        <div class="d-flex flex-wrap gap-2 mb-3">
          ${mesa && mesa.ativo === false ? '' : '<button type="button" class="btn btn-success" data-acao="lancar">Lançar pedido</button>'}
          <button type="button" class="btn btn-outline-primary" data-acao="pedidos">Ver todos os pedidos</button>
        </div>
        <label for="mesasDestino">Transferir para mesa livre</label>
        <select id="mesasDestino" class="form-select form-select-sm mb-2">
          <option value="">Selecione</option>
          ${opcoes}
        </select>
        ${destino ? `<p>Transferir da mesa ${numero} para a mesa ${numeroMesa(destino.numero)}.</p>
          <button type="button" class="btn btn-primary" data-acao="transferir">Confirmar transferência</button>` : (livres.length ? '' : '<p>Não há outra mesa livre nesta empresa.</p>')}
      `;
    }
    return `
      <div class="mesas-modal" id="mesasModal" role="dialog" aria-modal="true" aria-labelledby="mesasModalTitulo">
        <div class="mesas-modal__caixa">
          <div class="d-flex justify-content-between align-items-start">
            <h2 id="mesasModalTitulo" class="h4">Mesa ${numero}</h2>
            <button type="button" class="btn btn-outline-secondary btn-sm" data-acao="fechar">Fechar</button>
          </div>
          ${corpo}
        </div>
      </div>`;
  }

  function blocoAtendimento(atendimento, instante) {
    if (!atendimento) return '';
    const cliente = atendimento.cliente_nome
      ? `Cliente: ${escapar(atendimento.cliente_nome)}`
      : (atendimento.cliente_id != null ? `Cliente nº ${escapar(atendimento.cliente_id)}` : 'Cliente não identificado');
    return `
      <ul class="list-unstyled">
        <li>${cliente}</li>
        <li>Operador da abertura nº ${escapar(atendimento.operador_abertura_id)}</li>
        <li>Abertura ${escapar(atendimento.aberto_em || '—')}</li>
        <li>Permanência ${escapar(permanencia(atendimento.aberto_em, instante))}</li>
      </ul>`;
  }

  function blocoPedidos(pedidos) {
    if (!pedidos || !pedidos.length) return '<p>Nenhum pedido vinculado a este atendimento.</p>';
    return pedidos.map((pedido) => {
      const prep = pedido.preparacao || {};
      const classeVisual = {
        NAO_ENVIADO: 'mesas-prep--neutra',
        NORMAL: 'mesas-prep--normal',
        ATRASADO: 'mesas-prep--atrasado',
        CRITICO: 'mesas-prep--critico',
        CONCLUIDO: 'mesas-prep--concluido'
      }[prep.classificacao] || 'mesas-prep--neutra';
      const estado = prep.estado || (prep.classificacao === 'CONCLUIDO' ? 'CONCLUIDO' : 'NAO_ENVIADO');
      const emPreparacao = estado === 'EM_PREPARACAO';
      const tempo = prep.tempo_decorrido_segundos == null || (!emPreparacao && estado !== 'CONCLUIDO')
        ? 'Sem contagem'
        : formatarDuracao(prep.tempo_decorrido_segundos);
      const classificacao = emPreparacao
        ? `<span class="mesas-prep ${classeVisual}">${escapar(rotuloPreparacao(prep.classificacao))}</span>`
        : '';
      const classeEstado = emPreparacao
        ? 'mesas-prep--estado'
        : (estado === 'CONCLUIDO' ? 'mesas-prep--concluido' : 'mesas-prep--neutra');
      const total = pedido.total != null ? `<div>Total do pedido ${escapar(pedido.total)}</div>` : '';
      const acao = acaoDoPedido(pedido);
      const botaoPdv = podeGerarVendaPdv(pedido)
        ? `<button type="button" class="btn btn-outline-success btn-sm mt-2" data-acao="venda-pdv" data-pedido-id="${escapar(pedido.id)}" title="Preparar e abrir a venda deste pedido no PDV">Gerar venda no PDV</button>`
        : '';
      return `
        <article class="mesas-pedido">
          <strong>${escapar(pedido.codigo || ('Pedido ' + pedido.id))}</strong>
          <div>Estado comercial ${escapar(pedido.status || '—')}</div>
          <div>Preparação <span class="mesas-prep ${classeEstado}">${escapar(rotuloEstadoPreparacao(estado))}</span> ${classificacao}</div>
          <div>Envio ${escapar(prep.enviado_em || '—')}</div>
          <div>Tempo ${escapar(tempo)}</div>
          ${total}
          <div class="d-flex flex-wrap gap-2 mt-2">
            <button type="button" class="btn btn-outline-primary btn-sm" data-acao="pedido" data-pedido-id="${escapar(pedido.id)}">${escapar(acao.rotulo)}</button>
            ${botaoPdv}
          </div>
        </article>`;
    }).join('');
  }

  function montarNoNavegador(global) {
    const contexto = global.CdsEmpresaContexto;
    const empresa = contexto && contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    let timerBuscaCliente = null;
    let sequenciaBuscaCliente = 0;

    function buscarClientes(termo) {
      const pesquisa = String(termo || '').trim();
      const sequencia = ++sequenciaBuscaCliente;
      if (timerBuscaCliente != null) global.clearTimeout(timerBuscaCliente);
      if (pesquisa.length < 2) return;

      timerBuscaCliente = global.setTimeout(async () => {
        try {
          const clientes = await requisitar(global, 'GET', `/clientes/buscar?termo=${encodeURIComponent(pesquisa)}`);
          if (sequencia !== sequenciaBuscaCliente) return;
          const campo = global.document.getElementById('mesasCliente');
          if (!campo || campo.value.trim() !== pesquisa) return;
          control.definirSugestoesClientes(clientes);
        } catch (err) {
          if (sequencia !== sequenciaBuscaCliente) return;
          const campo = global.document.getElementById('mesasCliente');
          if (!campo || campo.value.trim() !== pesquisa) return;
          control.definirErroBuscaCliente(`Falha ao buscar clientes: ${err.message}`);
        }
      }, 250);
    }

    function cancelarBuscaCliente() {
      sequenciaBuscaCliente += 1;
      if (timerBuscaCliente != null) global.clearTimeout(timerBuscaCliente);
      timerBuscaCliente = null;
    }

    let control;
    control = criarControlador({
      empresaId: contexto && contexto.lerEmpresaId ? contexto.lerEmpresaId() : null,
      empresaRotulo: empresa ? (empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id)) : '',
      fetchJson: (method, path, corpo, chave) => requisitar(global, method, path, corpo, chave),
      agendar: (fn, ms) => global.setTimeout(fn, ms),
      cancelar: (id) => global.clearTimeout(id),
      aoMudar: () => desenhar(global, control, global.document && global.document.getElementById('page-content'), buscarClientes, cancelarBuscaCliente),
      confirmar: (mensagem) => (typeof global.confirm === 'function' ? global.confirm(mensagem) : true),
      aoIrParaPedidos(ctx) {
        const api = global.CdsMesasLancamento;
        try {
          if (api && global.sessionStorage) api.gravarLancamento(global.sessionStorage, ctx);
        } catch (_err) { /* a tela de Pedidos ainda assim será aberta */ }
        if (typeof global.loadPage === 'function') global.loadPage('pedidos');
      },
      aoIrParaPdv(preparacao) {
        if (typeof global.abrirPdvOficial === 'function') {
          Promise.resolve(global.abrirPdvOficial({ handoff: preparacao })).catch(() => {});
          return;
        }
        try {
          if (global.sessionStorage) {
            global.sessionStorage.setItem('pdvPedidoHandoff', JSON.stringify(preparacao));
          }
        } catch (_err) { /* o PDV ainda assim será aberto */ }
        if (global.location && typeof global.location.assign === 'function') {
          global.location.assign('/pdv');
        }
      }
    });
    const originalIniciar = control.iniciar;
    control.iniciar = async function iniciarNaTela(host) {
      if (contexto && contexto.temEmpresaSelecionada && !contexto.temEmpresaSelecionada()) {
        if (host) {
          host.innerHTML = `<div class="alert alert-warning">${escapar(contexto.mensagemEmpresaObrigatoria())}</div>`;
        }
        return control.estado;
      }
      await originalIniciar();
      desenhar(global, control, host, buscarClientes, cancelarBuscaCliente);
      return control.estado;
    };
    return control;
  }

  function desenhar(global, control, host, buscarClientes, cancelarBuscaCliente) {
    if (!host) return;
    const foco = global.document && global.document.activeElement;
    const editandoCliente = foco && foco.id === 'mesasCliente';
    const editandoDestino = foco && foco.id === 'mesasDestino';
    // Polling a cada 5s não pode destruir o DOM enquanto o operador digita
    // ou com modal Bootstrap aberto (perde caret/foco em qualquer campo).
    const digitandoNoPainel = !!(
      foco
      && host.contains(foco)
      && typeof foco.matches === 'function'
      && foco.matches('input, textarea, select, [contenteditable="true"]')
    );
    const modalAberto = !!(
      global.document.querySelector('.modal.show')
      || global.document.querySelector('.modal.showing')
    );
    if ((digitandoNoPainel && !editandoCliente && !editandoDestino) || (modalAberto && !editandoCliente && !editandoDestino)) {
      return;
    }
    const selecaoCliente = editandoCliente && Number.isInteger(foco.selectionStart)
      && Number.isInteger(foco.selectionEnd)
      ? {
        inicio: foco.selectionStart,
        fim: foco.selectionEnd,
        direcao: foco.selectionDirection
      }
      : null;
    if (editandoCliente && foco.value !== control.estado.clienteNome) control.definirCliente(foco.value);
    if (editandoDestino) control.definirDestino(foco.value);
    host.innerHTML = control.html();
    const raiz = host.querySelector('[data-painel-mesas]');
    if (!raiz) return;
    raiz.querySelectorAll('[data-mesa-id]').forEach((botao) => {
      botao.addEventListener('click', () => control.selecionar(botao.getAttribute('data-mesa-id')));
    });
    const fechar = raiz.querySelector('[data-acao="fechar"]');
    if (fechar) fechar.addEventListener('click', () => control.fecharModal());
    const abrir = raiz.querySelector('[data-acao="abrir"]');
    if (abrir) abrir.addEventListener('click', () => control.abrirAtendimento());
    const lancar = raiz.querySelector('[data-acao="lancar"]');
    if (lancar) lancar.addEventListener('click', () => control.lancarPedido());
    const verPedidos = raiz.querySelector('[data-acao="pedidos"]');
    if (verPedidos) verPedidos.addEventListener('click', () => control.verTodosPedidos());
    raiz.querySelectorAll('[data-acao="selecionar-cliente"]').forEach((botao) => {
      botao.addEventListener('click', () => {
        if (cancelarBuscaCliente) cancelarBuscaCliente();
        control.selecionarCliente(
          botao.getAttribute('data-cliente-id'),
          botao.getAttribute('data-cliente-nome')
        );
      });
    });
    raiz.querySelectorAll('[data-acao="pedido"]').forEach((botao) => {
      botao.addEventListener('click', () => control.abrirPedidoExistente(botao.getAttribute('data-pedido-id')));
    });
    raiz.querySelectorAll('[data-acao="venda-pdv"]').forEach((botao) => {
      botao.addEventListener('click', () => control.gerarVendaPdv(botao.getAttribute('data-pedido-id')));
    });
    const transferir = raiz.querySelector('[data-acao="transferir"]');
    if (transferir) transferir.addEventListener('click', () => control.transferir());
    const cliente = raiz.querySelector('#mesasCliente');
    if (cliente) cliente.addEventListener('input', () => {
      control.definirCliente(cliente.value);
      if (buscarClientes) buscarClientes(cliente.value);
    });
    const destino = raiz.querySelector('#mesasDestino');
    if (destino) destino.addEventListener('change', () => control.definirDestino(destino.value));
    const novoCliente = raiz.querySelector('#mesasCliente');
    if (editandoCliente && novoCliente) {
      novoCliente.focus();
      if (selecaoCliente && typeof novoCliente.setSelectionRange === 'function') {
        const tamanho = String(novoCliente.value || '').length;
        const inicio = Math.min(selecaoCliente.inicio, tamanho);
        const fim = Math.min(selecaoCliente.fim, tamanho);
        novoCliente.setSelectionRange(inicio, fim, selecaoCliente.direcao || 'none');
      }
    }
    if (editandoDestino && raiz.querySelector('#mesasDestino')) raiz.querySelector('#mesasDestino').focus();
  }

  async function requisitar(global, method, path, corpo, chave) {
    const contexto = global.CdsEmpresaContexto;
    const headers = contexto && contexto.headersJson ? contexto.headersJson() : { 'Content-Type': 'application/json' };
    if (chave) headers['Idempotency-Key'] = chave;
    const base = typeof global.API_URL === 'string' ? global.API_URL : '/api';
    const resp = await global.fetch(base + path, {
      method,
      headers,
      body: corpo && method !== 'GET' ? JSON.stringify(corpo) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error((data && (data.mensagem || data.error)) || 'Falha na operação.');
      err.codigo = data && data.codigo;
      throw err;
    }
    return data;
  }

  return {
    INTERVALO_MS,
    MENSAGENS,
    numeroMesa,
    permanencia,
    formatarDuracao,
    contadores,
    filtrarEmpresa,
    mesasLivres,
    podeGerarVendaPdv,
    criarControlador,
    htmlPainel,
    montarNoNavegador
  };
}));
