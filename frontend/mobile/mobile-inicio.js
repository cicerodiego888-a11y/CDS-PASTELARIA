/**
 * Entrada única da operação mobile.
 * Não grava pedido, não fecha venda e não substitui a sessão do backend.
 */
(function (root) {
  'use strict';

  function $(id) {
    return root.document.getElementById(id);
  }

  function usuario() {
    try {
      return JSON.parse(root.localStorage.getItem('user') || 'null');
    } catch (_erro) {
      return null;
    }
  }

  function exigirSessao() {
    let token = '';
    try { token = root.localStorage.getItem('token') || ''; } catch (_e) { token = ''; }
    if (token) return true;
    if (root.location && typeof root.location.replace === 'function') {
      root.location.replace('/login?next=/mobile/');
    }
    return false;
  }

  function mostrarAlerta(texto) {
    const el = $('mi-alerta');
    if (!el) return;
    el.hidden = !texto;
    el.textContent = texto || '';
  }

  function pintarIdentidade() {
    const contexto = root.CdsEmpresaContexto;
    const empresa = contexto && contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    $('mi-empresa').textContent = empresa
      ? (empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id))
      : 'Empresa não selecionada';
    const atual = usuario();
    const nome = atual && (atual.nome || atual.username);
    $('mi-operador').textContent = nome ? ('Operador: ' + nome) : 'Operador não identificado';
    $('mi-sessao').textContent = 'Sessão autenticada neste navegador.';
  }

  function pintarOperacao() {
    const operacao = root.CdsMobileOperacao;
    if (!operacao) return;
    const pedido = operacao.lerPedido();
    const pdv = operacao.lerPdv();
    $('mi-pedido-estado').textContent = pedido.ok && operacao.pedidoEmAndamento(pedido.registro)
      ? 'Pedido em andamento nesta sessão. Voltar ao início não o encerra.'
      : 'Nenhum pedido em andamento.';
    const parcelas = pdv.ok && pdv.registro.pagamento && pdv.registro.pagamento.parcelas;
    const pagamento = Array.isArray(parcelas) && parcelas.length;
    $('mi-pdv-estado').textContent = pdv.ok && operacao.pdvEmAndamento(pdv.registro)
      ? (pagamento
        ? 'PDV com pagamento pendente nesta sessão. Voltar ao início não o conclui.'
        : 'PDV com venda em andamento nesta sessão. Voltar ao início não a conclui.')
      : 'Nenhum pagamento pendente.';
    if ((pedido.codigo === 'OPERADOR_DIVERGENTE') || (pdv.codigo === 'OPERADOR_DIVERGENTE')) {
      mostrarAlerta('Há uma operação de outro operador nesta aba. Ela foi mantida e não foi aberta.');
    }
  }

  async function consultarLicenca() {
    const contexto = root.CdsEmpresaContexto;
    if (!contexto || typeof contexto.listarDisponiveis !== 'function') return;
    try {
      await contexto.listarDisponiveis();
    } catch (erro) {
      if (erro && erro.status === 401 && root.location) {
        root.location.replace('/login?next=/mobile/');
        return;
      }
      const texto = String((erro && erro.message) || '');
      if (texto.indexOf('LICENCA') >= 0 || texto.indexOf('não ativado') >= 0 || texto.indexOf('Assinatura') >= 0) {
        $('mi-licenca').textContent = 'Licença: ' + texto;
        $('mi-modulos').hidden = true;
        return;
      }
      $('mi-licenca').textContent = texto || 'A consulta da licença não retornou.';
      $('mi-modulos').hidden = true;
      return;
    }
    $('mi-licenca').textContent = 'Licença aceita para consultar as empresas.';
    try {
      if (typeof contexto.adotarEmpresaPadrao === 'function') {
        await contexto.adotarEmpresaPadrao();
        pintarIdentidade();
      }
      $('mi-modulos').hidden = false;
      atualizarAcessoContagem();
    } catch (erro) {
      if (erro && erro.status === 401 && root.location) {
        root.location.replace('/login?next=/mobile/');
        return;
      }
      $('mi-modulos').hidden = true;
      mostrarAlerta((erro && erro.message) || 'A empresa padrão da loja não pôde ser usada.');
    }
  }

  function podeAjustarEstoqueLocal() {
    if (typeof root.podeAjustarEstoque === 'function') return !!root.podeAjustarEstoque();
    const atual = usuario();
    if (!atual) return false;
    const perfil = String(atual.perfil || atual.nivel || '').trim().toUpperCase();
    return atual.role === 'admin' || perfil === 'SUPER_ADMIN' || perfil === 'ADMIN';
  }

  function atualizarAcessoContagem() {
    const link = $('mi-contagem');
    if (!link) return;
    link.hidden = !podeAjustarEstoqueLocal();
  }

  function sair() {
    try {
      root.localStorage.removeItem('token');
      root.localStorage.removeItem('user');
    } catch (_erro) { /* armazenamento indisponível */ }
    if (root.location) root.location.replace('/login?next=/mobile/');
  }

  async function iniciar() {
    if (!root.document || !$('mi-app')) return;
    if (!exigirSessao()) return;
    pintarIdentidade();
    pintarOperacao();
    atualizarAcessoContagem();
    const sairBtn = $('mi-sair');
    if (sairBtn) sairBtn.addEventListener('click', sair);
    await consultarLicenca();
  }

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => { iniciar().catch((erro) => mostrarAlerta(erro.message)); });
    } else {
      iniciar().catch((erro) => mostrarAlerta(erro.message));
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
