/**
 * Sprint 07 · S07-1 — Painel KDS.
 * Sprint 07 · S07-2 — Seleção segura de unidade operacional (JWT).
 * Consome GET /api/cozinha/preparacao/painel (contrato S07-0).
 * Ações de preparação usam as rotas autenticadas existentes; não alteram o pedido comercial nem imprimem.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CdsCozinhaKdsApi = api;
    root.loadCozinhaKds = function loadCozinhaKds() {
      if (root.CdsCozinhaKds && typeof root.CdsCozinhaKds.parar === 'function') {
        root.CdsCozinhaKds.parar();
      }
      const painel = api.montarNoNavegador(root);
      root.CdsCozinhaKds = painel;
      const host = root.document && root.document.getElementById('page-content');
      return painel.iniciar(host);
    };
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const INTERVALO_MS = 5000;
  const LIMITE_PAINEL = 100;
  const ESTADOS_COLUNA = Object.freeze(['AGUARDANDO', 'EM_PREPARACAO', 'PRONTO', 'RETIRADO']);
  const ROTULOS_COLUNA = Object.freeze({
    AGUARDANDO: 'Aguardando',
    EM_PREPARACAO: 'Em preparação',
    PRONTO: 'Prontos',
    RETIRADO: 'Retirados'
  });
  const CLASSES_COLUNA = Object.freeze({
    AGUARDANDO: 'kds-coluna--aguardando',
    EM_PREPARACAO: 'kds-coluna--preparacao',
    PRONTO: 'kds-coluna--prontos',
    RETIRADO: 'kds-coluna--retirados'
  });

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseServidor(valor) {
    if (!valor) return NaN;
    const texto = String(valor).trim().replace(' ', 'T');
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(texto) ? texto : `${texto}Z`;
    return Date.parse(iso);
  }

  function formatarHora(valor) {
    const ms = parseServidor(valor);
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function formatarDataHoraUtc(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return `${dd}/${mo}/${yyyy} ${hh}:${mm}:${ss}`;
  }

  function segundosEntre(inicio, fim, agoraMs) {
    const inicioMs = parseServidor(inicio);
    const fimMs = fim == null || fim === '' ? Number(agoraMs) : parseServidor(fim);
    if (!Number.isFinite(inicioMs) || !Number.isFinite(fimMs) || fimMs < inicioMs) return null;
    return Math.floor((fimMs - inicioMs) / 1000);
  }

  function formatarDuracao(segundos) {
    if (segundos == null || !Number.isFinite(Number(segundos))) return '—';
    const total = Math.max(0, Math.floor(Number(segundos)));
    const horas = String(Math.floor(total / 3600)).padStart(2, '0');
    const minutos = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const segundosRestantes = String(total % 60).padStart(2, '0');
    return `${horas}:${minutos}:${segundosRestantes}`;
  }

  function calcularTemposItem(card, item, agora) {
    const agoraMs = agora instanceof Date && Number.isFinite(agora.getTime())
      ? agora.getTime()
      : Date.now();
    const chegadaEm = card.enviada_em;
    const retiradaConfirmada = card.retirada_estado === 'RETIRADA';
    const chegadaFim = retiradaConfirmada ? card.retirada_em : null;
    const chegouSegundos = retiradaConfirmada && !chegadaFim
      ? null
      : segundosEntre(chegadaEm, chegadaFim, agoraMs);
    const estado = String(item.estado_preparacao || '').toUpperCase();
    const esperaAtiva = !item.iniciado_em && estado === 'AGUARDANDO';
    const esperaSegundos = item.iniciado_em || esperaAtiva
      ? segundosEntre(chegadaEm, item.iniciado_em || null, agoraMs)
      : null;
    const preparoAtivo = !item.pronto_em && estado === 'EM_PREPARACAO';
    const preparoSegundos = item.iniciado_em && (item.pronto_em || preparoAtivo)
      ? segundosEntre(item.iniciado_em, item.pronto_em || null, agoraMs)
      : null;
    const esperaGarcomAtiva = !!card.rodada_pronta_em && !retiradaConfirmada;
    const esperaGarcomSegundos = card.rodada_pronta_em
      && (!retiradaConfirmada || card.retirada_em)
      ? segundosEntre(
        card.rodada_pronta_em,
        retiradaConfirmada ? card.retirada_em : null,
        agoraMs
      )
      : null;
    return {
      chegada: chegouSegundos,
      espera: esperaSegundos,
      preparo: preparoSegundos,
      esperaGarcom: esperaGarcomSegundos,
      chegadaEm,
      chegadaFim,
      chegadaAtiva: !retiradaConfirmada,
      esperaInicio: chegadaEm,
      esperaFim: item.iniciado_em || null,
      esperaAtiva,
      preparoInicio: item.iniciado_em || null,
      preparoFim: item.pronto_em || null,
      preparoAtivo,
      esperaGarcomInicio: card.rodada_pronta_em || null,
      esperaGarcomFim: retiradaConfirmada ? card.retirada_em || null : null,
      esperaGarcomAtiva
    };
  }

  function htmlCronometro(rotulo, inicio, fim, ativo, agora) {
    const segundos = inicio && (fim || ativo)
      ? segundosEntre(inicio, fim || null, agora instanceof Date ? agora.getTime() : Date.now())
      : null;
    const atributos = segundos == null
      ? ''
      : ` data-kds-cronometro data-inicio="${escapar(inicio)}" data-fim="${escapar(fim || '')}"`;
    return `<span class="kds-tempo"><span class="kds-tempo__rotulo">${escapar(rotulo)}</span>` +
      `<time class="kds-tempo__valor"${atributos}>${escapar(formatarDuracao(segundos))}</time></span>`;
  }

  function atualizarCronometros(host, agoraMs = Date.now()) {
    if (!host || typeof host.querySelectorAll !== 'function') return;
    host.querySelectorAll('[data-kds-cronometro]').forEach((el) => {
      el.textContent = formatarDuracao(segundosEntre(
        el.getAttribute('data-inicio'),
        el.getAttribute('data-fim') || null,
        agoraMs
      ));
    });
  }

  function formatarQtd(valor) {
    const n = Number(String(valor == null ? '' : valor).replace(',', '.'));
    if (!Number.isFinite(n)) return String(valor == null ? '' : valor);
    if (Number.isInteger(n)) return String(n);
    return String(n).replace(/\.?0+$/, '');
  }

  function rotuloMesa(rodada) {
    if (rodada && rodada.mesa_numero != null && String(rodada.mesa_numero).trim() !== '') {
      return `Mesa ${String(rodada.mesa_numero).padStart(2, '0')}`;
    }
    if (rodada && rodada.mesa_id != null) return `Mesa #${rodada.mesa_id}`;
    return 'Sem mesa';
  }

  function numeroComanda(itens) {
    for (let i = 0; i < (itens || []).length; i += 1) {
      const n = itens[i] && itens[i].numero_comanda;
      if (n != null) return Number(n);
    }
    return null;
  }

  function compararFifo(a, b) {
    const sa = Number(a && a.sequencia_global);
    const sb = Number(b && b.sequencia_global);
    if (sa !== sb) return (sa || 0) - (sb || 0);
    const ta = parseServidor(a && a.enviada_em) || 0;
    const tb = parseServidor(b && b.enviada_em) || 0;
    if (ta !== tb) return ta - tb;
    return Number(a && a.id || 0) - Number(b && b.id || 0);
  }

  function compararItensFifo(a, b) {
    const sa = Number(a && a.sequencia_global);
    const sb = Number(b && b.sequencia_global);
    if (sa !== sb) return (sa || 0) - (sb || 0);
    return Number(a && a.id || 0) - Number(b && b.id || 0);
  }

  /**
   * Distribui cartões por estado do item (contrato S07-0).
   * Cada cartão = rodada com apenas os itens daquele estado, FIFO.
   */
  function distribuirPorEstado(rodadas) {
    const out = {
      AGUARDANDO: [],
      EM_PREPARACAO: [],
      PRONTO: [],
      RETIRADO: []
    };
    (rodadas || []).forEach((rodada) => {
      if (!rodada) return;
      const itensPorEstado = {};
      ESTADOS_COLUNA.forEach((estado) => {
        itensPorEstado[estado] = (rodada.itens || [])
          .filter((it) => String(it.estado_preparacao || '').toUpperCase() === estado)
          .slice()
          .sort(compararItensFifo);
      });
      
      const retiradaConfirmada = rodada.retirada_estado === 'RETIRADA';
      const retiradaDisponivel = rodada.estado_preparacao === 'PRONTA'
        && rodada.retirada_estado === 'PENDENTE';
      const estadoAcaoRetirada = retiradaDisponivel
        ? ['PRONTO', 'EM_PREPARACAO', 'AGUARDANDO']
          .find((estado) => itensPorEstado[estado].length)
        : null;

      if (retiradaConfirmada) {
        // Rodada já retirada — aparece em RETIRADO com todos os itens
        const todoItens = rodada.itens || [];
        if (todoItens.length) {
          out.RETIRADO.push({
            id: rodada.id,
            empresa_id: rodada.empresa_id,
            unidade_id: rodada.unidade_id,
            mesa_id: rodada.mesa_id,
            mesa_numero: rodada.mesa_numero,
            atendimento_id: rodada.atendimento_id,
            numero_rodada: rodada.numero_rodada,
            sequencia_global: rodada.sequencia_global,
            estado_preparacao: rodada.estado_preparacao,
            operador_envio_id: rodada.operador_envio_id,
            enviada_em: rodada.enviada_em,
            rodada_pronta_em: rodada.rodada_pronta_em,
            retirada_estado: rodada.retirada_estado,
            retirada_em: rodada.retirada_em,
            retirada_por: rodada.retirada_por,
            pode_confirmar_retirada: false,
            created_at: rodada.created_at,
            itens: todoItens
          });
        }
      } else {
        // Rodada ativa — distribuir por estado de item
        ESTADOS_COLUNA.slice(0, -1).forEach((estado) => { // exclui RETIRADO
          const itens = itensPorEstado[estado];
          if (!itens.length) return;
          out[estado].push({
            id: rodada.id,
            empresa_id: rodada.empresa_id,
            unidade_id: rodada.unidade_id,
            mesa_id: rodada.mesa_id,
            mesa_numero: rodada.mesa_numero,
            atendimento_id: rodada.atendimento_id,
            numero_rodada: rodada.numero_rodada,
            sequencia_global: rodada.sequencia_global,
            estado_preparacao: rodada.estado_preparacao,
            operador_envio_id: rodada.operador_envio_id,
            enviada_em: rodada.enviada_em,
            rodada_pronta_em: rodada.rodada_pronta_em,
            retirada_estado: rodada.retirada_estado,
            retirada_em: rodada.retirada_em,
            retirada_por: rodada.retirada_por,
            pode_confirmar_retirada: estado === estadoAcaoRetirada,
            cancelamento_motivo: rodada.cancelamento_motivo,
            cancelamento_por: rodada.cancelamento_por,
            cancelamento_em: rodada.cancelamento_em,
            created_at: rodada.created_at,
            itens
          });
        });
      }
    });
    ESTADOS_COLUNA.forEach((estado) => {
      out[estado].sort(compararFifo);
    });
    return out;
  }

  function contadores(distribuicao) {
    return {
      AGUARDANDO: (distribuicao.AGUARDANDO || []).length,
      EM_PREPARACAO: (distribuicao.EM_PREPARACAO || []).length,
      PRONTO: (distribuicao.PRONTO || []).length
    };
  }

  function mensagemDe(err) {
    if (!err) return 'Falha de comunicação com o painel.';
    const codigo = err.codigo || err.code;
    const msg = err.mensagem || err.message || 'Falha de comunicação com o painel.';
    return codigo ? `${msg} (${codigo})` : msg;
  }

  /** Lê unidade_cozinha_id do JWT armazenado (somente UI; autoridade é o backend). */
  function lerUnidadeCozinhaDoToken(token) {
    if (!token || typeof token !== 'string') return null;
    const partes = token.split('.');
    if (partes.length < 2) return null;
    try {
      const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
      const payload = JSON.parse(json);
      const id = Number(payload && payload.unidade_cozinha_id);
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Exige claim unidade_cozinha_id no JWT exatamente igual à unidade selecionada.
   * Não aceita corpo HTTP (data.unidade_cozinha_id) como substituto.
   */
  function exigirUnidadeNoJwt(token, unidadeSelecionadaId) {
    const esperada = Number(unidadeSelecionadaId);
    const claim = lerUnidadeCozinhaDoToken(token);
    if (claim == null) {
      throw Object.assign(new Error('Token recebido sem unidade_cozinha_id.'), {
        codigo: 'TOKEN_UNIDADE_AUSENTE'
      });
    }
    if (!Number.isInteger(esperada) || esperada <= 0 || claim !== esperada) {
      throw Object.assign(new Error('Token recebido com unidade divergente da selecionada.'), {
        codigo: 'TOKEN_UNIDADE_DIVERGENTE'
      });
    }
    return claim;
  }

  function htmlSelecaoUnidade(estado) {
    const empresa = estado.empresaRotulo
      || (estado.empresaId != null ? `Empresa #${estado.empresaId}` : 'Empresa');
    const aviso = estado.selecaoErro
      ? `<div class="kds-aviso" role="alert">${escapar(estado.selecaoErro)}</div>`
      : '';
    let corpo = '';
    if (estado.selecaoCarregando) {
      corpo = '<div class="kds-selecao__msg">Carregando unidades autorizadas…</div>';
    } else if (!(estado.unidadesDisponiveis || []).length) {
      const codigoVazio = estado.selecaoCodigo || '';
      let textoVazio = 'Nenhuma unidade de cozinha autorizada para este usuário nesta empresa. '
        + 'Solicite o cadastro/vínculo ao administrador.';
      if (codigoVazio === 'SEM_UNIDADES_CADASTRADAS') {
        textoVazio = 'Não há unidades de cozinha cadastradas e ativas nesta empresa. '
          + 'Cadastre uma unidade operacional antes de usar o KDS.';
      } else if (codigoVazio === 'SEM_VINCULO_OPERADOR') {
        textoVazio = 'Nenhuma unidade vinculada a este operador nesta empresa. '
          + 'Solicite o vínculo ativo ao administrador.';
      } else if (estado.selecaoMensagemServidor) {
        textoVazio = estado.selecaoMensagemServidor;
      }
      corpo = `<div class="kds-selecao__msg" data-kds-sem-unidades="1"
        data-kds-codigo="${escapar(codigoVazio || 'SEM_UNIDADES_DISPONIVEIS')}">
        ${escapar(textoVazio)}
      </div>`;
    } else {
      const opcoes = (estado.unidadesDisponiveis || []).map((u) => {
        const sel = Number(estado.unidadeSelecionadaId) === Number(u.id) ? ' checked' : '';
        const codigo = u.codigo ? String(u.codigo) : `Unidade #${u.id}`;
        return `<label class="kds-selecao__opcao${sel ? ' kds-selecao__opcao--ativa' : ''}">
          <input type="radio" name="kds-unidade" value="${escapar(u.id)}"${sel}>
          <span class="kds-selecao__opcao-texto">
            <span class="kds-selecao__codigo">${escapar(codigo)}</span>
            <span class="kds-selecao__id">ID ${escapar(u.id)}</span>
          </span>
        </label>`;
      }).join('');
      corpo = `<div class="kds-selecao__lista" role="radiogroup" aria-label="Unidades de cozinha">${opcoes}</div>`;
    }
    const podeConfirmar = !estado.selecaoCarregando
      && !estado.selecaoConfirmando
      && Number.isInteger(Number(estado.unidadeSelecionadaId))
      && Number(estado.unidadeSelecionadaId) > 0
      && (estado.unidadesDisponiveis || []).some((u) => Number(u.id) === Number(estado.unidadeSelecionadaId));
    return `
      <div class="kds-painel kds-selecao" data-painel-kds-selecao="1">
        <div class="kds-selecao__palco">
          <div class="kds-selecao__card">
            <header class="kds-selecao__cabeca">
              <p class="kds-selecao__eyebrow">Cozinha · KDS</p>
              <h1 class="kds-selecao__titulo">Selecione a unidade</h1>
              <p class="kds-selecao__empresa">${escapar(empresa)}</p>
            </header>
            <p class="kds-selecao__intro">
              Escolha a unidade operacional autorizada para esta sessão.
            </p>
            ${aviso}
            ${corpo}
            <div class="kds-selecao__acoes">
              <button type="button" class="kds-btn-atualizar kds-selecao__confirmar" data-acao="confirmar-unidade"
                ${podeConfirmar ? '' : 'disabled'}>
                ${estado.selecaoConfirmando ? 'Confirmando…' : 'Confirmar unidade'}
              </button>
              <button type="button" class="kds-btn-secundario" data-acao="recarregar-unidades"
                ${estado.selecaoCarregando || estado.selecaoConfirmando ? 'disabled' : ''}>
                Atualizar lista
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function htmlItem(item, operacoesEmCurso, card, instante) {
    const estado = String(item.estado_preparacao || '').toUpperCase();
    const operando = !!(operacoesEmCurso && operacoesEmCurso[item.id]);
    const tempos = calcularTemposItem(card, item, instante);
    let acao = '';
    let conclusao = '';
    if (estado === 'AGUARDANDO') {
      acao = `<div class="kds-item__acoes">
        <button type="button" class="kds-btn-operacao" data-acao="iniciar-preparo" data-item-id="${escapar(item.id)}"
          ${operando ? 'disabled' : ''}>
          ${operando ? 'PROCESSANDO…' : 'INICIAR PREPARO'}
        </button>
      </div>`;
    } else if (estado === 'EM_PREPARACAO') {
      acao = `<div class="kds-item__acoes">
        <button type="button" class="kds-btn-operacao kds-btn-operacao--pronto"
          data-acao="marcar-pronto" data-item-id="${escapar(item.id)}" ${operando ? 'disabled' : ''}>
          ${operando ? 'PROCESSANDO…' : 'MARCAR COMO PRONTO'}
        </button>
      </div>`;
    } else if (estado === 'PRONTO') {
      const operador = item.operador_pronto_id != null
        ? ` · Operador #${escapar(item.operador_pronto_id)}`
        : '';
      conclusao = `<div class="kds-item__conclusao">
        Concluído às ${escapar(formatarHora(item.pronto_em))} UTC${operador}
      </div>`;
    }
    const obs = item.observacoes_snapshot != null && String(item.observacoes_snapshot).trim() !== ''
      ? `<div class="kds-item__obs">${escapar(item.observacoes_snapshot)}</div>`
      : '';
    const temposEtapa = `<div class="kds-item__tempos">
      ${htmlCronometro('Espera', tempos.esperaInicio, tempos.esperaFim, tempos.esperaAtiva, instante)}
      ${htmlCronometro('Preparo', tempos.preparoInicio, tempos.preparoFim, tempos.preparoAtivo, instante)}
    </div>`;
    return `
      <div class="kds-item" data-item-id="${escapar(item.id)}">
        <div class="kds-item__linha">
          <span class="kds-item__qtd">${escapar(formatarQtd(item.qty_solicitada))}</span>
          <span class="kds-item__nome">${escapar(item.produto_nome_snapshot || 'Produto')}</span>
          <span class="kds-item__tipo">${escapar(item.tipo_item || '')}</span>
        </div>
        ${obs}
        ${temposEtapa}
        ${acao}
        ${conclusao}
      </div>`;
  }

  function htmlCard(card, operacoesEmCurso, retiradasEmCurso, instante) {
    const comanda = numeroComanda(card.itens);
    const chips = [
      comanda != null ? `Comanda ${comanda}` : null,
      card.numero_rodada != null ? `Rodada ${card.numero_rodada}` : null,
      card.sequencia_global != null ? `Seq. ${card.sequencia_global}` : null,
      card.operador_envio_id != null ? `Responsável #${card.operador_envio_id}` : null
    ].filter(Boolean).map((t) => `<span class="kds-chip">${escapar(t)}</span>`).join('');
    const tempos = calcularTemposItem(card, (card.itens || [])[0] || {}, instante);
    const retiradaEmCurso = !!(retiradasEmCurso && retiradasEmCurso[card.id]);
    const retirada = card.retirada_estado === 'RETIRADA'
      ? `<div class="kds-card__retirada">
          Retirada confirmada${card.retirada_em ? ` às ${escapar(formatarHora(card.retirada_em))} UTC` : ''}
          ${card.retirada_por != null ? ` · Responsável #${escapar(card.retirada_por)}` : ''}
        </div>`
      : card.retirada_estado === 'ASSUMIDA_RETIRADA'
        ? '<div class="kds-card__retirada">Retirada assumida; confirmação indisponível.</div>'
        : '';
    const acaoRetirada = card.pode_confirmar_retirada
      ? `<div class="kds-card__acoes">
          <button type="button" class="kds-btn-operacao kds-btn-operacao--retirada"
            data-acao="confirmar-retirada" data-rodada-id="${escapar(card.id)}"
            ${retiradaEmCurso ? 'disabled' : ''}>
            ${retiradaEmCurso ? 'PROCESSANDO…' : 'CONFIRMAR RETIRADA'}
          </button>
        </div>`
      : '';
    
    const acacaoCancelamento = (card.retirada_estado !== 'RETIRADA' && card.estado_preparacao !== 'CANCELADA')
      ? `<div class="kds-card__acoes">
          <button type="button" class="kds-btn-operacao kds-btn-operacao--cancelar"
            data-acao="cancelar-rodada" data-rodada-id="${escapar(card.id)}">
            CANCELAR
          </button>
        </div>`
      : '';

    return `
      <article class="kds-card" data-rodada-id="${escapar(card.id)}">
        <div class="kds-card__topo">
          <div class="kds-card__mesa">${escapar(rotuloMesa(card))}</div>
          <div class="kds-card__hora">
            Chegada ${escapar(formatarHora(card.enviada_em))} UTC
          </div>
        </div>
        <div class="kds-card__meta">${chips}</div>
        <div class="kds-card__tempos">
          ${htmlCronometro('Tempo total', tempos.chegadaEm, tempos.chegadaFim, tempos.chegadaAtiva, instante)}
          ${htmlCronometro(
            'Espera do garçom',
            tempos.esperaGarcomInicio,
            tempos.esperaGarcomFim,
            tempos.esperaGarcomAtiva,
            instante
          )}
        </div>
        ${(card.itens || []).map((item) => htmlItem(item, operacoesEmCurso, card, instante)).join('')}
        ${retirada}
        ${acaoRetirada}
        ${acacaoCancelamento}
      </article>`;
  }

  function htmlColuna(estado, cards, operacoesEmCurso, retiradasEmCurso, instante) {
    const lista = !cards.length
      ? `<div class="kds-vazio">Nenhum pedido</div>`
      : cards.map((card) => htmlCard(card, operacoesEmCurso, retiradasEmCurso, instante)).join('');
    return `
      <section class="kds-coluna ${CLASSES_COLUNA[estado]}" data-coluna="${estado}">
        <header class="kds-coluna__cabeca">
          <span>${escapar(ROTULOS_COLUNA[estado])}</span>
          <span class="kds-contador" data-contador="${estado}">${cards.length}</span>
        </header>
        <div class="kds-coluna__lista">${lista}</div>
      </section>`;
  }

  function htmlPainel(estado, instante) {
    const dist = estado.distribuicao || distribuirPorEstado(estado.rodadas || []);
    const operacoesEmCurso = estado.acoesEmCurso || {};
    const retiradasEmCurso = estado.retiradasEmCurso || {};
    const counts = contadores(dist);
    const ultima = estado.ultimaAtualizacao
      ? formatarDataHoraUtc(estado.ultimaAtualizacao)
      : '—';
    let statusClasse = 'kds-status--ok';
    let statusTexto = 'Atualizado';
    if (estado.carregando && !(estado.rodadas && estado.rodadas.length)) {
      statusClasse = 'kds-status--carregando';
      statusTexto = 'Carregando…';
    } else if (estado.carregando) {
      statusClasse = 'kds-status--carregando';
      statusTexto = 'Atualizando…';
    } else if (estado.erro) {
      statusClasse = 'kds-status--erro';
      statusTexto = 'Falha na atualização';
    }

    const unidade = estado.unidadeId != null ? `Unidade #${estado.unidadeId}` : 'Unidade —';
    const empresa = estado.empresaRotulo || (estado.empresaId != null ? `Empresa #${estado.empresaId}` : 'Empresa —');
    const aviso = estado.erro
      ? `<div class="kds-aviso" role="alert">${escapar(estado.erro)}</div>`
      : '';
    const feedback = estado.feedback
      ? `<div class="kds-feedback kds-feedback--${estado.feedbackTipo === 'erro' ? 'erro' : 'sucesso'}"
          role="${estado.feedbackTipo === 'erro' ? 'alert' : 'status'}" aria-live="polite">
          ${escapar(estado.feedback)}
        </div>`
      : '';

    const corpoVazioInicial = estado.carregando && !(estado.rodadas && estado.rodadas.length) && !estado.erro
      ? `<div class="kds-carregando-global">Carregando painel da cozinha…</div>`
      : `<div class="kds-colunas">
          ${htmlColuna('AGUARDANDO', dist.AGUARDANDO || [], operacoesEmCurso, retiradasEmCurso, instante)}
          ${htmlColuna('EM_PREPARACAO', dist.EM_PREPARACAO || [], operacoesEmCurso, retiradasEmCurso, instante)}
          ${htmlColuna('PRONTO', dist.PRONTO || [], operacoesEmCurso, retiradasEmCurso, instante)}
        </div>`;

    return `
      <div class="kds-painel" data-painel-kds="1">
        <header class="kds-cabecalho">
          <div>
            <div class="kds-cabecalho__marca">CDS Sistemas</div>
            <h1 class="kds-cabecalho__titulo">Cozinha <span>(KDS)</span></h1>
            <div class="kds-cabecalho__meta">
              <strong>${escapar(empresa)}</strong>
              · ${escapar(unidade)}
              · Última atualização: <strong data-kds-ultima>${escapar(ultima)} UTC</strong>
            </div>
          </div>
          <div class="kds-cabecalho__acoes">
            <span class="kds-status ${statusClasse}" data-kds-status="${escapar(statusClasse)}">
              <span class="kds-status__dot" aria-hidden="true"></span>
              ${escapar(statusTexto)}
            </span>
            <button type="button" class="kds-btn-secundario" data-acao="trocar-unidade"
              title="Voltar para a seleção de unidade de cozinha">
              Trocar unidade
            </button>
            <button type="button" class="kds-btn-atualizar" data-acao="atualizar"
              ${estado.carregando ? 'disabled' : ''}>
              Atualizar agora
            </button>
          </div>
        </header>
        ${aviso}
        ${feedback}
        ${corpoVazioInicial}
        <div class="visually-hidden" data-kds-contadores>
          Aguardando ${counts.AGUARDANDO}; Em preparação ${counts.EM_PREPARACAO}; Prontos ${counts.PRONTO}
        </div>
      </div>`;
  }

  function criarControlador(deps) {
    const fetchJson = deps.fetchJson;
    const agora = deps.agora || (() => new Date());
    const intervaloMs = deps.intervaloMs != null ? deps.intervaloMs : INTERVALO_MS;
    let timerCronometros = null;
    let timer = null;
    let seq = 0;
    let atualizarDepois = false;
    const estado = {
      ativo: false,
      carregando: false,
      emCurso: false,
      acoesEmCurso: Object.create(null),
      retiradasEmCurso: Object.create(null),
      modo: 'painel', // 'selecao' | 'painel'
      empresaId: deps.empresaId != null ? deps.empresaId : null,
      empresaRotulo: deps.empresaRotulo || '',
      unidadeId: null,
      rodadas: [],
      distribuicao: distribuirPorEstado([]),
      total: 0,
      ordenacao: null,
      ultimaAtualizacao: null,
      erro: '',
      feedback: '',
      feedbackTipo: '',
      teveSucesso: false,
      unidadesDisponiveis: [],
      unidadeSelecionadaId: null,
      selecaoCarregando: false,
      selecaoConfirmando: false,
      selecaoErro: '',
      selecaoCodigo: '',
      selecaoMensagemServidor: '',
      selecaoFalhaLista: false
    };

    function publicar() {
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
    }

    function iniciarCronometros() {
      if (timerCronometros != null || typeof deps.agendarIntervalo !== 'function') return;
      timerCronometros = deps.agendarIntervalo(() => {
        if (estado.ativo && estado.modo === 'painel' && typeof deps.atualizarCronometros === 'function') {
          deps.atualizarCronometros();
        }
      }, 1000);
    }

    function pararCronometros() {
      if (timerCronometros == null) return;
      if (typeof deps.cancelarIntervalo === 'function') deps.cancelarIntervalo(timerCronometros);
      timerCronometros = null;
    }

    function agendar() {
      if (!estado.ativo || estado.modo !== 'painel' || !deps.agendar) return;
      timer = deps.agendar(async () => {
        timer = null;
        if (!estado.ativo || estado.modo !== 'painel') return;
        await atualizar({ silencioso: true });
        agendar();
      }, intervaloMs);
    }

    function parar() {
      estado.ativo = false;
      if (timer != null && deps.cancelar) deps.cancelar(timer);
      timer = null;
      pararCronometros();
      atualizarDepois = false;
    }

    async function atualizar(opts) {
      const silencioso = !!(opts && opts.silencioso);
      if (!estado.ativo || estado.modo !== 'painel') return { ignorada: true };
      if (estado.emCurso) {
        if (opts && opts.forcar) atualizarDepois = true;
        return { ignorada: true, sobreposta: true };
      }
      estado.emCurso = true;
      estado.carregando = true;
      publicar();
      const ticket = ++seq;
      try {
        const data = await fetchJson('GET', `/cozinha/preparacao/painel?limite=${LIMITE_PAINEL}&offset=0`);
        if (!estado.ativo || ticket !== seq) return { obsoleta: true };
        estado.rodadas = Array.isArray(data && data.rodadas) ? data.rodadas : [];
        estado.distribuicao = distribuirPorEstado(estado.rodadas);
        estado.total = data && data.total != null ? Number(data.total) : estado.rodadas.length;
        estado.ordenacao = data && data.ordenacao ? data.ordenacao : null;
        if (data && data.unidade_id != null) estado.unidadeId = Number(data.unidade_id);
        if (data && data.empresa_id != null) estado.empresaId = Number(data.empresa_id);
        estado.ultimaAtualizacao = agora();
        estado.erro = '';
        estado.teveSucesso = true;
        return { ok: true, data };
      } catch (err) {
        if (!estado.ativo || ticket !== seq) return { obsoleta: true };
        estado.erro = mensagemDe(err);
        return { erro: err, preservouDados: estado.teveSucesso };
      } finally {
        if (ticket === seq) {
          estado.emCurso = false;
          estado.carregando = false;
          if (estado.ativo) publicar();
          if (atualizarDepois) {
            atualizarDepois = false;
            Promise.resolve().then(() => atualizar({ silencioso: false }));
          }
        }
      }
    }

    function localizarItem(itemId) {
      for (const rodada of estado.rodadas) {
        const item = (rodada.itens || []).find((candidato) => Number(candidato.id) === itemId);
        if (item) return { rodada, item };
      }
      return null;
    }

    async function operarItem(itemIdRaw, acao) {
      const itemId = Number(itemIdRaw);
      const operacao = acao === 'iniciar'
        ? {
          estadoEsperado: 'AGUARDANDO',
          estadoDestino: 'EM_PREPARACAO',
          caminho: 'iniciar',
          confirmar: 'Iniciar o preparo deste item?',
          sucesso: 'Preparo iniciado.'
        }
        : acao === 'pronto'
          ? {
            estadoEsperado: 'EM_PREPARACAO',
            estadoDestino: 'PRONTO',
            caminho: 'pronto',
            confirmar: 'Marcar este item como pronto?',
            sucesso: 'Item marcado como pronto.'
          }
          : null;
      if (!Number.isInteger(itemId) || itemId <= 0 || !operacao) {
        return { ignorada: true };
      }
      if (estado.acoesEmCurso[itemId]) return { ignorada: true, sobreposta: true };
      const encontrado = localizarItem(itemId);
      if (!encontrado || String(encontrado.item.estado_preparacao || '').toUpperCase() !== operacao.estadoEsperado) {
        estado.feedback = 'O item mudou de estado. Atualize o painel antes de tentar novamente.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }
      if (typeof deps.confirmar === 'function' && !deps.confirmar(operacao.confirmar)) {
        return { cancelada: true };
      }

      estado.acoesEmCurso[itemId] = true;
      estado.feedback = '';
      estado.feedbackTipo = '';
      publicar();
      const chave = typeof deps.gerarChaveIdempotencia === 'function'
        ? deps.gerarChaveIdempotencia(acao, itemId)
        : `kds:${acao}:${itemId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      try {
        const data = await fetchJson(
          'POST',
          `/cozinha/itens/${itemId}/${operacao.caminho}`,
          { idempotency_key: chave }
        );
        if (!data || data.success !== true || !data.item
          || Number(data.item.id) !== itemId
          || String(data.item.estado_preparacao || '').toUpperCase() !== operacao.estadoDestino) {
          throw Object.assign(new Error('O servidor não confirmou a transição do item.'), {
            codigo: 'RESPOSTA_TRANSICAO_INVALIDA'
          });
        }

        const atual = localizarItem(itemId);
        if (atual) {
          Object.assign(atual.item, data.item);
          if (acao === 'iniciar') {
            atual.item.iniciado_em = data.iniciado_em || atual.item.iniciado_em || null;
            atual.item.operador_inicio_id = data.operador_id != null
              ? Number(data.operador_id)
              : atual.item.operador_inicio_id || null;
          } else {
            atual.item.pronto_em = data.pronto_em
              || data.item.pronto_em
              || atual.item.pronto_em
              || null;
            atual.item.operador_pronto_id = data.operador_id != null
              ? Number(data.operador_id)
              : atual.item.operador_pronto_id || null;
          }
          if (data.rodada && data.rodada.estado_preparacao) {
            atual.rodada.estado_preparacao = data.rodada.estado_preparacao;
          }
        }
        estado.distribuicao = distribuirPorEstado(estado.rodadas);
        estado.feedback = operacao.sucesso;
        estado.feedbackTipo = 'sucesso';
        publicar();
        await atualizar({ silencioso: true, forcar: true });
        return { ok: true, data };
      } catch (err) {
        estado.feedback = mensagemDe(err);
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: err };
      } finally {
        delete estado.acoesEmCurso[itemId];
        publicar();
      }
    }

    async function confirmarRetirada(rodadaIdRaw) {
      const rodadaId = Number(rodadaIdRaw);
      if (!Number.isInteger(rodadaId) || rodadaId <= 0) return { ignorada: true };
      if (estado.retiradasEmCurso[rodadaId]) return { ignorada: true, sobreposta: true };
      const rodada = estado.rodadas.find((candidata) => Number(candidata.id) === rodadaId);
      if (!rodada || rodada.estado_preparacao !== 'PRONTA' || rodada.retirada_estado !== 'PENDENTE') {
        estado.feedback = 'A rodada mudou de estado. Atualize o painel antes de confirmar a retirada.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }
      if (typeof deps.confirmar === 'function'
        && !deps.confirmar('Confirmar a retirada desta rodada pelo garçom?')) {
        return { cancelada: true };
      }

      estado.retiradasEmCurso[rodadaId] = true;
      estado.feedback = '';
      estado.feedbackTipo = '';
      publicar();
      const chave = typeof deps.gerarChaveIdempotencia === 'function'
        ? deps.gerarChaveIdempotencia('retirada', rodadaId)
        : `kds:retirada:${rodadaId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      try {
        const data = await fetchJson(
          'POST',
          `/cozinha/rodadas/${rodadaId}/retirada`,
          { idempotency_key: chave }
        );
        if (!data || data.success !== true || !data.rodada
          || Number(data.rodada.id) !== rodadaId
          || data.rodada.retirada_estado !== 'RETIRADA') {
          throw Object.assign(new Error('O servidor não confirmou a retirada.'), {
            codigo: 'RESPOSTA_RETIRADA_INVALIDA'
          });
        }
        Object.assign(rodada, data.rodada);
        estado.distribuicao = distribuirPorEstado(estado.rodadas);
        estado.feedback = data.repetida ? 'Retirada já estava confirmada.' : 'Retirada confirmada.';
        estado.feedbackTipo = 'sucesso';
        publicar();
        await atualizar({ silencioso: true, forcar: true });
        return { ok: true, data };
      } catch (err) {
        estado.feedback = mensagemDe(err);
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: err };
      } finally {
        delete estado.retiradasEmCurso[rodadaId];
        publicar();
      }
    }

    async function cancelarRodada(rodadaIdRaw) {
      const rodadaId = Number(rodadaIdRaw);
      if (!Number.isInteger(rodadaId) || rodadaId <= 0) return { ignorada: true };
      if (estado.cancelamentosEmCurso === undefined) estado.cancelamentosEmCurso = {};
      if (estado.cancelamentosEmCurso[rodadaId]) return { ignorada: true, sobreposta: true };
      const rodada = estado.rodadas.find((candidata) => Number(candidata.id) === rodadaId);
      if (!rodada || rodada.retirada_estado === 'RETIRADA' || rodada.estado_preparacao === 'CANCELADA') {
        estado.feedback = 'A rodada já foi retirada ou cancelada. Não é possível cancelar.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }

      const motivo = prompt('Motivo do cancelamento:\n1) PRAZO_EXCEDIDO\n2) CLIENTE_DESISTIU\n3) CANCELAMENTO_IFOOD\n4) PEDIDO_DUPLICADO\n5) ERRO_LANCAMENTO\n6) FALTA_PRODUTO\n7) OUTRO\n\nDigite o número ou o motivo exato:');
      if (!motivo) return { cancelada: true };

      const motivosValidos = ['PRAZO_EXCEDIDO', 'CLIENTE_DESISTIU', 'CANCELAMENTO_IFOOD', 'PEDIDO_DUPLICADO', 'ERRO_LANCAMENTO', 'FALTA_PRODUTO', 'OUTRO'];
      let motivoFinal = motivosValidos[Number(motivo) - 1] || motivo;
      if (!motivosValidos.includes(motivoFinal)) {
        estado.feedback = 'Motivo inválido. Cancelamento não foi enviado.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }

      let justificativa = '';
      if (motivoFinal === 'OUTRO') {
        justificativa = prompt('Justificativa do cancelamento (obrigatória):');
        if (!justificativa || !String(justificativa).trim()) {
          estado.feedback = 'Justificativa obrigatória para motivo "OUTRO". Cancelamento não foi enviado.';
          estado.feedbackTipo = 'erro';
          publicar();
          return { erro: true };
        }
      }

      if (typeof deps.confirmar === 'function'
        && !deps.confirmar(`Confirmar cancelamento desta rodada?\nMotivo: ${motivoFinal}${justificativa ? '\nJustificativa: ' + justificativa : ''}`)) {
        return { cancelada: true };
      }

      estado.cancelamentosEmCurso[rodadaId] = true;
      estado.feedback = '';
      estado.feedbackTipo = '';
      publicar();
      const chave = typeof deps.gerarChaveIdempotencia === 'function'
        ? deps.gerarChaveIdempotencia('cancelamento', rodadaId)
        : `kds:cancelamento:${rodadaId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      try {
        const data = await fetchJson(
          'POST',
          `/cozinha/rodadas/${rodadaId}/cancelar`,
          {
            idempotency_key: chave,
            cancelamento_motivo: motivoFinal,
            cancelamento_justificativa: justificativa || null
          }
        );
        if (!data || data.success !== true || !data.rodada
          || Number(data.rodada.id) !== rodadaId
          || data.rodada.estado_preparacao !== 'CANCELADA') {
          throw Object.assign(new Error('O servidor não confirmou o cancelamento.'), {
            codigo: 'RESPOSTA_CANCELAMENTO_INVALIDA'
          });
        }
        Object.assign(rodada, data.rodada);
        estado.distribuicao = distribuirPorEstado(estado.rodadas);
        estado.feedback = data.repetida ? 'Cancelamento já estava registrado.' : 'Rodada cancelada com sucesso.';
        estado.feedbackTipo = 'sucesso';
        publicar();
        await atualizar({ silencioso: true, forcar: true });
        return { ok: true, data };
      } catch (err) {
        estado.feedback = mensagemDe(err);
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: err };
      } finally {
        delete estado.cancelamentosEmCurso[rodadaId];
        publicar();
      }
    }

    async function carregarUnidadesDisponiveis(opts) {
      const forcar = !!(opts && opts.forcar);
      // Não reexecuta automaticamente após falha de comunicação.
      if (estado.selecaoFalhaLista && !forcar) return { ignorada: true };
      if (estado.selecaoCarregando) return { ignorada: true };
      estado.selecaoCarregando = true;
      estado.selecaoErro = '';
      publicar();
      try {
        const data = await fetchJson('GET', '/cozinha/unidades-disponiveis');
        estado.unidadesDisponiveis = Array.isArray(data && data.unidades) ? data.unidades : [];
        estado.selecaoFalhaLista = false;
        estado.selecaoCodigo = (data && data.codigo) || '';
        estado.selecaoMensagemServidor = (data && data.mensagem) || '';
        // Não auto-seleciona nem auto-confirma a primeira unidade.
        estado.unidadeSelecionadaId = null;
        return { ok: true, data };
      } catch (err) {
        estado.selecaoFalhaLista = true;
        estado.unidadesDisponiveis = [];
        estado.selecaoCodigo = err && (err.codigo || err.code) ? String(err.codigo || err.code) : '';
        estado.selecaoMensagemServidor = '';
        estado.selecaoErro = mensagemDe(err);
        return { erro: err };
      } finally {
        estado.selecaoCarregando = false;
        publicar();
      }
    }

    function definirUnidadeSelecionada(id) {
      const n = Number(id);
      estado.unidadeSelecionadaId = Number.isInteger(n) && n > 0 ? n : null;
      publicar();
    }

    async function confirmarUnidade() {
      if (estado.selecaoConfirmando) return { ignorada: true };
      const id = Number(estado.unidadeSelecionadaId);
      if (!Number.isInteger(id) || id <= 0) {
        estado.selecaoErro = 'Selecione uma unidade para continuar.';
        publicar();
        return { ok: false };
      }
      estado.selecaoConfirmando = true;
      estado.selecaoErro = '';
      publicar();
      try {
        const data = await fetchJson('POST', '/cozinha/sessao/unidade', {
          unidade_cozinha_id: id
        });
        if (!data || !data.token) {
          throw Object.assign(new Error('Falha na emissão do novo token.'), {
            codigo: 'TOKEN_AUSENTE'
          });
        }
        // Claim do JWT é a única fonte autoritativa — não usar data.unidade_cozinha_id.
        const unidadeToken = exigirUnidadeNoJwt(data.token, id);
        if (typeof deps.aoAtualizarSessao !== 'function') {
          throw Object.assign(
            new Error('Persistência de sessão obrigatória ausente.'),
            { codigo: 'SESSAO_PERSISTENCIA_OBRIGATORIA' }
          );
        }
        await deps.aoAtualizarSessao(data);
        estado.modo = 'painel';
        estado.unidadeId = unidadeToken;
        estado.selecaoConfirmando = false;
        iniciarCronometros();
        publicar();
        await atualizar({ silencioso: false });
        agendar();
        return { ok: true, data };
      } catch (err) {
        estado.selecaoErro = mensagemDe(err);
        estado.selecaoConfirmando = false;
        estado.modo = 'selecao';
        // Permanece em modo seleção; painel/polling não iniciam.
        publicar();
        return { erro: err };
      }
    }

    async function iniciar(opts) {
      estado.ativo = true;
      estado.erro = '';
      const unidadeJwt = opts && opts.unidadeJwt != null
        ? opts.unidadeJwt
        : (typeof deps.lerUnidadeJwt === 'function' ? deps.lerUnidadeJwt() : null);
      if (unidadeJwt) {
        estado.modo = 'painel';
        estado.unidadeId = unidadeJwt;
        iniciarCronometros();
        await atualizar({ silencioso: false });
        agendar();
        return estado;
      }
      estado.modo = 'selecao';
      await carregarUnidadesDisponiveis();
      return estado;
    }

    /**
     * Volta à tela de seleção de unidade (para o poll do painel).
     * Não altera o JWT até o operador confirmar outra unidade.
     */
    async function voltarParaSelecao() {
      if (timer != null && deps.cancelar) deps.cancelar(timer);
      timer = null;
      pararCronometros();
      estado.modo = 'selecao';
      estado.unidadeSelecionadaId = null;
      estado.selecaoErro = '';
      estado.selecaoConfirmando = false;
      estado.selecaoFalhaLista = false;
      estado.erro = '';
      publicar();
      await carregarUnidadesDisponiveis({ forcar: true });
      return estado;
    }

    return {
      estado,
      iniciar,
      parar,
      atualizar,
      operarItem,
      confirmarRetirada,
      cancelarRodada,
      carregarUnidadesDisponiveis,
      definirUnidadeSelecionada,
      confirmarUnidade,
      voltarParaSelecao,
      html: () => (estado.modo === 'selecao'
        ? htmlSelecaoUnidade(estado)
        : htmlPainel(estado, agora()))
    };
  }

  async function requisitar(global, method, path, corpo) {
    const contexto = global.CdsEmpresaContexto;
    const headers = contexto && contexto.headersJson
      ? contexto.headersJson()
      : (contexto && contexto.headersAuth ? contexto.headersAuth() : { 'Content-Type': 'application/json' });
    const base = typeof global.API_URL === 'string' ? global.API_URL : '/api';
    const resp = await global.fetch(base + path, {
      method,
      headers,
      body: corpo && method !== 'GET' ? JSON.stringify(corpo) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error((data && (data.mensagem || data.error)) || 'Falha na operação.');
      err.codigo = (data && (data.codigo || data.code)) || null;
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  /**
   * Contrato IPC de electronAPI.cozinhaImpressao.estabelecerSessao
   * (electron-cozinha-impressao.js → canal cozinha-impressao:sessao-autenticada):
   * - Sucesso: { success: true, sessao: { empresaId, unidadeId }, contexto }
   * - Falha: Promise resolve com { success: false, codigo, erro }
   *   (não rejeita — validar success explicitamente).
   * - Também pode rejeitar em falha de bridge.
   */
  function interpretarRetornoEstabelecerSessao(retorno) {
    if (retorno && retorno.success === true) {
      return { ok: true, retorno };
    }
    const codigo = (retorno && (retorno.codigo || retorno.code))
      || 'SESSAO_ELECTRON_FALHA';
    const msg = (retorno && (retorno.erro || retorno.mensagem || retorno.error))
      || 'Falha ao atualizar sessão Electron.';
    const err = new Error(msg);
    err.codigo = codigo;
    err.retornoElectron = retorno || null;
    throw err;
  }

  /**
   * Persiste sessão somente após validação prévia do JWT pelo chamador.
   * Aguarda e valida retorno de estabelecerSessao quando a API existir.
   * Não altera o mecanismo de impressão do Sprint 06 — só notifica a sessão.
   */
  async function persistirSessao(global, data) {
    if (!data || !data.token) {
      throw Object.assign(new Error('Sessão sem token para persistir.'), {
        codigo: 'TOKEN_AUSENTE'
      });
    }
    // Contrato POST /cozinha/sessao/unidade sempre emite `user` com unidade_cozinha_id.
    // Exigir o campo evita token novo associado a user antigo no localStorage.
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) {
      throw Object.assign(
        new Error('Resposta de sessão sem usuário contextualizado.'),
        { codigo: 'SESSAO_USER_AUSENTE' }
      );
    }
    if (!global || !global.localStorage
      || typeof global.localStorage.setItem !== 'function'
      || typeof global.localStorage.getItem !== 'function'
      || typeof global.localStorage.removeItem !== 'function') {
      throw Object.assign(new Error('localStorage indisponível para persistir a sessão.'), {
        codigo: 'SESSAO_PERSISTENCIA_FALHA'
      });
    }

    let tokenAnterior;
    let userAnterior;
    let snapshotOk = false;
    try {
      tokenAnterior = global.localStorage.getItem('token');
      userAnterior = global.localStorage.getItem('user');
      snapshotOk = true;
    } catch (e) {
      throw Object.assign(
        new Error('Falha ao ler sessão anterior para rollback.'),
        { codigo: 'SESSAO_PERSISTENCIA_FALHA', cause: e }
      );
    }

    const restaurarAnterior = () => {
      if (!snapshotOk) {
        throw Object.assign(
          new Error('Rollback impossível: snapshot anterior indisponível.'),
          { codigo: 'SESSAO_ROLLBACK_FALHA' }
        );
      }
      try {
        if (tokenAnterior == null) global.localStorage.removeItem('token');
        else global.localStorage.setItem('token', tokenAnterior);
        if (userAnterior == null) global.localStorage.removeItem('user');
        else global.localStorage.setItem('user', userAnterior);
      } catch (e) {
        throw Object.assign(
          new Error('Falha ao restaurar sessão anterior no localStorage.'),
          { codigo: 'SESSAO_ROLLBACK_FALHA', cause: e }
        );
      }
    };

    const falhaPersistencia = (mensagem, cause) => {
      let rollbackErro = null;
      try {
        restaurarAnterior();
      } catch (rb) {
        rollbackErro = rb;
      }
      const err = Object.assign(new Error(mensagem), {
        codigo: 'SESSAO_PERSISTENCIA_FALHA',
        cause
      });
      if (rollbackErro) {
        err.rollbackErro = rollbackErro;
        err.codigo = 'SESSAO_ROLLBACK_FALHA';
      }
      return err;
    };

    try {
      global.localStorage.setItem('token', data.token);
    } catch (e) {
      throw falhaPersistencia('Falha ao gravar token no localStorage.', e);
    }

    try {
      global.localStorage.setItem('user', JSON.stringify(data.user));
    } catch (e) {
      // Token novo sem user novo — rollback integral obrigatório.
      throw falhaPersistencia(
        'Falha ao gravar usuário no localStorage após gravar o token.',
        e
      );
    }

    const estabelecer = global.electronAPI
      && global.electronAPI.cozinhaImpressao
      && typeof global.electronAPI.cozinhaImpressao.estabelecerSessao === 'function'
      ? global.electronAPI.cozinhaImpressao.estabelecerSessao.bind(global.electronAPI.cozinhaImpressao)
      : null;

    if (estabelecer) {
      try {
        const retorno = await estabelecer({ token: data.token });
        interpretarRetornoEstabelecerSessao(retorno);
      } catch (e) {
        let rollbackErro = null;
        try {
          restaurarAnterior();
        } catch (rb) {
          rollbackErro = rb;
        }
        const err = Object.assign(
          new Error(e && e.message ? e.message : 'Falha ao atualizar sessão Electron.'),
          {
            codigo: (e && e.codigo) || 'SESSAO_ELECTRON_FALHA',
            cause: e,
            retornoElectron: e && e.retornoElectron != null ? e.retornoElectron : null
          }
        );
        if (rollbackErro) {
          err.rollbackErro = rollbackErro;
          err.codigo = 'SESSAO_ROLLBACK_FALHA';
        }
        throw err;
      }
    }

    return {
      ok: true,
      electronAtualizado: !!estabelecer
    };
  }

  function montarNoNavegador(global) {
    const contexto = global.CdsEmpresaContexto;
    const empresa = contexto && contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    let control;
    control = criarControlador({
      empresaId: contexto && contexto.lerEmpresaId ? contexto.lerEmpresaId() : null,
      empresaRotulo: empresa
        ? (empresa.nome_fantasia || empresa.razao_social || (`Empresa #${empresa.id}`))
        : '',
      fetchJson: (method, path, corpo) => requisitar(global, method, path, corpo),
      agendar: (fn, ms) => global.setTimeout(fn, ms),
      cancelar: (id) => global.clearTimeout(id),
      agendarIntervalo: typeof global.setInterval === 'function'
        ? (fn, ms) => global.setInterval(fn, ms)
        : null,
      cancelarIntervalo: typeof global.clearInterval === 'function'
        ? (id) => global.clearInterval(id)
        : null,
      atualizarCronometros: () => atualizarCronometros(
        global.document && global.document.getElementById('page-content')
      ),
      confirmar: typeof global.confirm === 'function'
        ? global.confirm.bind(global)
        : null,
      lerUnidadeJwt: () => {
        try {
          return lerUnidadeCozinhaDoToken(global.localStorage && global.localStorage.getItem('token'));
        } catch (_e) {
          return null;
        }
      },
      aoAtualizarSessao: (data) => persistirSessao(global, data),
      aoMudar: () => {
        // Não redesenha se o ERP já navegou para outra página (ex.: Pedidos).
        if (global.CDS_ERP_ACTIVE_PAGE && global.CDS_ERP_ACTIVE_PAGE !== 'cozinha-kds') return;
        if (control && control.estado && control.estado.ativo === false) return;
        desenhar(global, control, global.document && global.document.getElementById('page-content'));
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
      desenhar(global, control, host);
      return control.estado;
    };
    return control;
  }

  function desenhar(global, control, host) {
    if (!host) return;
    host.innerHTML = control.html();
    atualizarCronometros(host);
    const selecao = host.querySelector('[data-painel-kds-selecao]');
    if (selecao) {
      selecao.querySelectorAll('input[name="kds-unidade"]').forEach((input) => {
        input.addEventListener('change', () => {
          control.definirUnidadeSelecionada(input.value);
        });
      });
      const conf = selecao.querySelector('[data-acao="confirmar-unidade"]');
      if (conf) conf.addEventListener('click', () => control.confirmarUnidade());
      const rec = selecao.querySelector('[data-acao="recarregar-unidades"]');
      if (rec) {
        rec.addEventListener('click', () => {
          control.carregarUnidadesDisponiveis({ forcar: true });
        });
      }
      return;
    }
    const raiz = host.querySelector('[data-painel-kds]');
    if (!raiz) return;
    const botao = raiz.querySelector('[data-acao="atualizar"]');
    if (botao) {
      botao.addEventListener('click', () => {
        control.atualizar({ silencioso: false });
      });
    }
    const trocar = raiz.querySelector('[data-acao="trocar-unidade"]');
    if (trocar) {
      trocar.addEventListener('click', () => {
        control.voltarParaSelecao();
      });
    }
    raiz.querySelectorAll('[data-acao="iniciar-preparo"], [data-acao="marcar-pronto"]')
      .forEach((botaoAcao) => {
        botaoAcao.addEventListener('click', () => {
          const acao = botaoAcao.getAttribute('data-acao') === 'iniciar-preparo'
            ? 'iniciar'
            : 'pronto';
          control.operarItem(botaoAcao.getAttribute('data-item-id'), acao);
        });
      });
    raiz.querySelectorAll('[data-acao="confirmar-retirada"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => {
        control.confirmarRetirada(botaoAcao.getAttribute('data-rodada-id'));
      });
    });
    raiz.querySelectorAll('[data-acao="cancelar-rodada"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => {
        control.cancelarRodada(botaoAcao.getAttribute('data-rodada-id'));
      });
    });
  }

  return {
    INTERVALO_MS,
    LIMITE_PAINEL,
    ESTADOS_COLUNA,
    ROTULOS_COLUNA,
    escapar,
    formatarHora,
    formatarDataHoraUtc,
    segundosEntre,
    formatarDuracao,
    calcularTemposItem,
    htmlCronometro,
    atualizarCronometros,
    formatarQtd,
    rotuloMesa,
    compararFifo,
    distribuirPorEstado,
    contadores,
    lerUnidadeCozinhaDoToken,
    exigirUnidadeNoJwt,
    interpretarRetornoEstabelecerSessao,
    htmlSelecaoUnidade,
    htmlPainel,
    persistirSessao,
    criarControlador,
    montarNoNavegador
  };
}));
