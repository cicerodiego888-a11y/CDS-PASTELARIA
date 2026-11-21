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
    root.loadCozinhaKds = function loadCozinhaKds(opts) {
      if (root.CdsCozinhaKds && typeof root.CdsCozinhaKds.parar === 'function') {
        root.CdsCozinhaKds.parar();
      }

      const painel = api.montarNoNavegador(root);
      root.CdsCozinhaKds = painel;
      const host = root.document && root.document.getElementById('page-content');
      return painel.iniciar(host, opts);
    };
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const INTERVALO_MS = 5000;
  const LIMITE_PAINEL = 100;
  const FUSO_EXIBICAO = 'America/Fortaleza';
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
    RETIRADO: 'kds-coluna--retirados',
    CANCELADO: 'kds-coluna--cancelados'
  });
  const ROTULO_CANCELADOS = 'Cancelados';
  const MOTIVOS_CANCELAMENTO = Object.freeze([
    ['PRAZO_EXCEDIDO', 'Prazo excedido'],
    ['CLIENTE_DESISTIU', 'Cliente desistiu'],
    ['CANCELAMENTO_IFOOD', 'Cancelamento iFood'],
    ['PEDIDO_DUPLICADO', 'Pedido duplicado'],
    ['ERRO_LANCAMENTO', 'Erro de lançamento'],
    ['FALTA_PRODUTO', 'Falta de produto'],
    ['OUTRO', 'Outro']
  ]);

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
    const partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO_EXIBICAO,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ms));
    const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
    return `${valores.hour}:${valores.minute}:${valores.second}`;
  }

  function formatarDataHoraLocal(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    const partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO_EXIBICAO,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
    return `${valores.day}/${valores.month}/${valores.year} ${valores.hour}:${valores.minute}:${valores.second}`;
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
    const retiradaConfirmada = card.retirada_confirmada_por_ledger === true;
    const canceladoEm = card.historico_cancelamento ? (item.cancelamento_em || card.cancelamento_em) : null;
    const chegadaFim = card.historico_cancelamento ? canceladoEm : (retiradaConfirmada ? card.retirada_em : null);
    const fimAusente = (card.historico_cancelamento || retiradaConfirmada) && !chegadaFim;
    const chegouSegundos = fimAusente
      ? null
      : segundosEntre(chegadaEm, chegadaFim, agoraMs);
    const estado = String(item.estado_preparacao || '').toUpperCase();
    const esperaFim = item.iniciado_em || chegadaFim;
    const esperaAtiva = !card.historico_cancelamento && !retiradaConfirmada && !esperaFim && estado === 'AGUARDANDO';
    let esperaSegundos = esperaFim || esperaAtiva
      ? segundosEntre(chegadaEm, esperaFim || null, agoraMs)
      : null;
    const preparoAtivo = !item.pronto_em && estado === 'EM_PREPARACAO' && !retiradaConfirmada && !card.historico_cancelamento;
    const preparoFim = item.pronto_em || (item.iniciado_em
      ? chegadaFim : null);
    let preparoSegundos = item.iniciado_em && (preparoFim || preparoAtivo)
      ? segundosEntre(item.iniciado_em, preparoFim || null, agoraMs)
      : null;
    const esperaGarcomAtiva = !!card.rodada_pronta_em && !retiradaConfirmada && !card.historico_cancelamento;
    const esperaGarcomSegundos = card.rodada_pronta_em
      && !fimAusente
      ? segundosEntre(
        card.rodada_pronta_em,
        chegadaFim,
        agoraMs
      )
      : null;
    let periodos = null;
    if (Array.isArray(item.eventos_preparacao)) {
      let etapa = 'AGUARDANDO';
      let inicio = chegadaEm;
      let espera = 0;
      let preparo = 0;
      let valido = Number.isFinite(parseServidor(inicio));
      for (const evento of item.eventos_preparacao) {
        const proxima = evento.tipo === 'PREPARACAO_INICIADA' ? 'EM_PREPARACAO'
          : evento.tipo === 'PREPARACAO_REVERTIDA' ? 'AGUARDANDO'
            : evento.tipo === 'ITEM_PRONTO' ? 'PRONTO'
              : evento.tipo === 'ITEM_CANCELADO' ? 'CANCELADO' : null;
        const permitida = (etapa === 'AGUARDANDO' && ['EM_PREPARACAO', 'CANCELADO'].includes(proxima))
          || (etapa === 'EM_PREPARACAO' && ['AGUARDANDO', 'PRONTO', 'CANCELADO'].includes(proxima))
          || (etapa === 'PRONTO' && proxima === 'CANCELADO');
        const duracao = parseServidor(evento.em) - parseServidor(inicio);
        if (!permitida || !evento.em || !Number.isFinite(duracao) || duracao < 0
          || (evento.tipo === 'ITEM_CANCELADO' && (!evento.estado_anterior || evento.estado_anterior !== etapa))) {
          valido = false;
          break;
        }
        if (etapa === 'AGUARDANDO') espera += duracao;
        if (etapa === 'EM_PREPARACAO') preparo += duracao;
        etapa = proxima;
        inicio = evento.em;
      }
      if (etapa !== estado) valido = false;
      const fim = chegadaFim;
      if (fimAusente) valido = false;
      if (valido && fim && ['AGUARDANDO', 'EM_PREPARACAO'].includes(etapa)) {
        const duracao = parseServidor(fim) - parseServidor(inicio);
        if (!Number.isFinite(duracao) || duracao < 0) valido = false;
        else if (etapa === 'AGUARDANDO') espera += duracao;
        else preparo += duracao;
      }
      const ativa = valido && !fim && ['AGUARDANDO', 'EM_PREPARACAO'].includes(etapa);
      const decorridos = ativa ? agoraMs - parseServidor(inicio) : 0;
      if (ativa && (!Number.isFinite(decorridos) || decorridos < 0)) valido = false;
      esperaSegundos = valido ? Math.floor((espera + (ativa && etapa === 'AGUARDANDO' ? decorridos : 0)) / 1000) : null;
      preparoSegundos = valido ? Math.floor((preparo + (ativa && etapa === 'EM_PREPARACAO' ? decorridos : 0)) / 1000) : null;
      periodos = {
        valido, esperaMs: espera, preparoMs: preparo,
        esperaInicio: ativa && etapa === 'AGUARDANDO' ? inicio : null,
        preparoInicio: ativa && etapa === 'EM_PREPARACAO' ? inicio : null
      };
    }
    return {
      chegada: chegouSegundos,
      espera: esperaSegundos,
      preparo: preparoSegundos,
      esperaGarcom: esperaGarcomSegundos,
      chegadaEm,
      chegadaFim,
      chegadaAtiva: !retiradaConfirmada && !card.historico_cancelamento,
      esperaInicio: chegadaEm,
      esperaFim: esperaFim || null,
      esperaAtiva,
      preparoInicio: item.iniciado_em || null,
      preparoFim: preparoFim || null,
      preparoAtivo,
      esperaGarcomInicio: card.rodada_pronta_em || null,
      esperaGarcomFim: chegadaFim || null,
      esperaGarcomAtiva,
      periodos
    };
  }

  function htmlTempoAcumulado(rotulo, baseMs, inicio, valido, agora) {
    const decorrido = inicio ? (agora instanceof Date ? agora.getTime() : Date.now()) - parseServidor(inicio) : 0;
    const segundos = valido && Number.isFinite(decorrido) && decorrido >= 0
      ? Math.floor((baseMs + decorrido) / 1000) : null;
    const atributos = valido && inicio
      ? ` data-kds-cronometro data-inicio="${escapar(inicio)}" data-fim="" data-base-ms="${baseMs}"`
      : '';
    return `<span class="kds-tempo"><span class="kds-tempo__rotulo">${escapar(rotulo)}</span>` +
      `<time class="kds-tempo__valor"${atributos}>${escapar(formatarDuracao(segundos))}</time></span>`;
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
      const baseMs = el.getAttribute('data-base-ms');
      if (baseMs != null) {
        const decorrido = agoraMs - parseServidor(el.getAttribute('data-inicio'));
        const base = Number(baseMs);
        el.textContent = formatarDuracao(Number.isFinite(decorrido) && decorrido >= 0 && Number.isFinite(base)
          ? Math.floor((base + decorrido) / 1000) : null);
        return;
      }
      const segundos = segundosEntre(
        el.getAttribute('data-inicio'),
        el.getAttribute('data-fim') || null,
        agoraMs
      );
      el.textContent = formatarDuracao(segundos);
    });
  }

  function formatarQtd(valor) {
    const n = Number(String(valor == null ? '' : valor).replace(',', '.'));
    if (!Number.isFinite(n)) return String(valor == null ? '' : valor);
    if (Number.isInteger(n)) return String(n);
    return String(n).replace(/\.?0+$/, '');
  }

  function parsearMilessimosUI(valor) {
    if (valor == null || (typeof valor === 'string' && !valor.trim())) return null;
    if (typeof valor === 'number' && !Number.isFinite(valor)) return null;
    const bruto = String(valor).trim();
    if (!/^\d+(?:[.,]\d{1,3})?$/.test(bruto)) return null;
    const partes = bruto.replace(',', '.').split('.');
    const millis = Number(partes[0]) * 1000 + Number(((partes[1] || '') + '000').slice(0, 3));
    return Number.isSafeInteger(millis) ? millis : null;
  }

  function formatarMilessimosUI(valor) {
    const millis = Number.isSafeInteger(valor) ? valor : parsearMilessimosUI(valor);
    if (!Number.isSafeInteger(millis) || millis < 0) return '—';
    return `${Math.floor(millis / 1000)},${String(millis % 1000).padStart(3, '0')}`;
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
      
      const retiradaConfirmada = rodada.retirada_confirmada_por_ledger === true;
      const retiradaDisponivel = rodada.estado_preparacao === 'PRONTA'
        && !retiradaConfirmada;
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
            retirada_confirmada_por_ledger: true,
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
            retirada_confirmada_por_ledger: false,
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
    ESTADOS_COLUNA.filter((estado) => estado !== 'RETIRADO').forEach((estado) => {
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

  function htmlItem(item, operacoesEmCurso, retiradasEmCurso, card, instante) {
    const estado = String(item.estado_preparacao || '').toUpperCase();
    const operando = !!(operacoesEmCurso && operacoesEmCurso[item.id]);
    const tempos = calcularTemposItem(card, item, instante);
    let acao = '';
    let conclusao = '';
    const somenteLeitura = !!card.historico_cancelamento;
    const pedidoCancelado = String(item.pedido_status || '').trim().toUpperCase() === 'CANCELADO';
    const retiradaComprovada = card.retirada_confirmada_por_ledger === true;
    const rodadaRetiradaLegada = card.retirada_estado === 'RETIRADA' && !retiradaComprovada;
    const bloqueioPreparo = somenteLeitura || retiradaComprovada || pedidoCancelado;
    if (!bloqueioPreparo && estado === 'AGUARDANDO') {
      acao = `<div class="kds-item__acoes">
        <button type="button" class="kds-btn-operacao" data-acao="iniciar-preparo" data-item-id="${escapar(item.id)}"
          ${operando ? 'disabled' : ''}>
          ${operando ? 'PROCESSANDO…' : 'INICIAR PREPARO'}
        </button>
      </div>`;
    } else if (!bloqueioPreparo && estado === 'EM_PREPARACAO') {
      acao = `<div class="kds-item__acoes">
        ${card.retirada_estado === 'PENDENTE' ? `<button type="button" class="kds-btn-operacao"
          data-acao="voltar-aguardando" data-item-id="${escapar(item.id)}" ${operando ? 'disabled' : ''}>
          ${operando ? 'PROCESSANDO…' : 'VOLTAR PARA AGUARDANDO'}
        </button>` : ''}
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
        Concluído às ${escapar(formatarHora(item.pronto_em))}${operador}
      </div>`;
    }
    const pendenteLedger = item.qty_pendente_retirada == null
      ? 0
      : Number(item.qty_pendente_retirada);
    const podeCancelarItem = card.retirada_estado === 'PENDENTE'
      && (!pedidoCancelado || (item.qty_pendente_retirada != null && pendenteLedger > 0));
    if (!somenteLeitura && podeCancelarItem
      && ['AGUARDANDO', 'EM_PREPARACAO', 'PRONTO'].includes(estado)) {
      acao += `<div class="kds-item__acoes"><button type="button" class="kds-btn-operacao kds-btn-operacao--cancelar"
        data-acao="cancelar-item" data-item-id="${escapar(item.id)}" ${operando ? 'disabled' : ''}>
        CANCELAR ITEM
      </button></div>`;
    }
    const obs = item.observacoes_snapshot != null && String(item.observacoes_snapshot).trim() !== ''
      ? `<div class="kds-item__obs">${escapar(item.observacoes_snapshot)}</div>`
      : '';
    const inicioPreparacao = item.iniciado_em
      ? `<div class="kds-item__obs">Preparo iniciado às ${escapar(formatarHora(item.iniciado_em))}</div>`
      : '';
    const temposEtapa = `<div class="kds-item__tempos">
      ${tempos.periodos
        ? htmlTempoAcumulado('Espera', tempos.periodos.esperaMs, tempos.periodos.esperaInicio, tempos.periodos.valido, instante)
        : htmlCronometro('Espera', tempos.esperaInicio, tempos.esperaFim, tempos.esperaAtiva, instante)}
      ${tempos.periodos
        ? htmlTempoAcumulado('Preparo', tempos.periodos.preparoMs, tempos.periodos.preparoInicio, tempos.periodos.valido, instante)
        : htmlCronometro('Preparo', tempos.preparoInicio, tempos.preparoFim, tempos.preparoAtivo, instante)}
      ${tempos.periodos && !tempos.periodos.valido ? '<span>Histórico de tempos incompleto</span>' : ''}
    </div>`;
    const quantidades = card.historico_cancelamento
      ? `<div class="kds-item__obs">Preparada: ${escapar(formatarQtd(item.qty_preparada || 0))} · Cancelada: ${escapar(formatarQtd(item.qty_cancelada || 0))}</div>`
      : '';
    const tipoBebida = String(item.tipo_item || '').toUpperCase() === 'BEBIDA';
    const quantidadeEmCurso = !!(retiradasEmCurso && retiradasEmCurso[item.id]);
    const quantidadePendenteEntrega = parsearMilessimosUI(item.qty_pendente_entrega);
    const quantidadeDisponivelRetirada = parsearMilessimosUI(tipoBebida
      ? item.qty_disponivel_retirada
      : item.qty_pendente_retirada);
    const acaoEntregaBebida = !somenteLeitura
      && !pedidoCancelado
      && tipoBebida
      && estado === 'PRONTO'
      && item.qty_pendente_entrega != null
      && Number.isSafeInteger(quantidadePendenteEntrega)
      && quantidadePendenteEntrega > 0
      ? `<div class="kds-item__acoes">
          <div class="kds-item__quantidade">
            <span>Entregar quantidade</span>
            <output>${escapar(formatarMilessimosUI(quantidadePendenteEntrega))}</output>
          </div>
          <button type="button" class="kds-btn-operacao"
            data-acao="entregar-bebida" data-item-id="${escapar(item.id)}"
            ${operando || quantidadeEmCurso ? 'disabled' : ''}>
            REGISTRAR ENTREGA
          </button>
        </div>`
      : '';
    const acaoRetiradaItem = !somenteLeitura
      && !pedidoCancelado
      && card.estado_preparacao === 'PRONTA'
      && estado === 'PRONTO'
      && item.qty_pendente_retirada != null
      && Number.isSafeInteger(quantidadeDisponivelRetirada)
      && quantidadeDisponivelRetirada > 0
      ? `<div class="kds-item__acoes">
          <div class="kds-item__quantidade">
            <span>Retirar quantidade</span>
            <output>${escapar(formatarMilessimosUI(quantidadeDisponivelRetirada))}</output>
          </div>
          <button type="button" class="kds-btn-operacao kds-btn-operacao--retirada"
            data-acao="confirmar-retirada-item" data-item-id="${escapar(item.id)}"
            ${operando || quantidadeEmCurso ? 'disabled' : ''}>
            CONFIRMAR RETIRADA
          </button>
        </div>`
      : '';
    const statusLedger = item.qty_pendente_retirada == null
      ? '<div class="kds-item__obs">Ledger individual indisponível; retirada bloqueada.</div>'
      : tipoBebida
        ? `<div class="kds-item__obs">Entregue: ${escapar(formatarQtd(item.qty_entregue || 0))} · Retirada líquida: ${escapar(formatarQtd(item.qty_retirada_liquida || 0))}</div>`
        : `<div class="kds-item__obs">Retirada líquida: ${escapar(formatarQtd(item.qty_retirada_liquida || 0))} · Pendente: ${escapar(formatarQtd(item.qty_pendente_retirada))}</div>`;
    return `
      <div class="kds-item" data-item-id="${escapar(item.id)}">
        <div class="kds-item__linha">
          <span class="kds-item__qtd">${escapar(formatarQtd(item.qty_solicitada))}</span>
          <span class="kds-item__nome">${escapar(item.produto_nome_snapshot || 'Produto')}</span>
          <span class="kds-item__tipo">${escapar(item.tipo_item || '')}</span>
        </div>
        ${(somenteLeitura && item.pedido_id != null) ? `<div class="kds-item__obs">Pedido #${escapar(item.pedido_id)}</div>` : ''}
        ${pedidoCancelado ? '<div class="kds-card__cancelamento" role="alert">Pedido comercial cancelado. Não prossiga com preparo, entrega ou retirada. Confirme a situação física e registre cancelamento operacional apenas com evidência.</div>' : ''}
        ${rodadaRetiradaLegada && !card.historico_cancelamento
          ? `<div class="kds-item__obs">Estado legado da rodada marcado como retirada às ${escapar(formatarHora(card.retirada_em))}; isso não comprova retirada individual.</div>` : ''}
        ${rodadaRetiradaLegada ? `<div class="kds-item__obs">Preparo: ${escapar(estado)}</div>` : ''}
        ${inicioPreparacao}
        ${obs}
        ${quantidades}
        ${statusLedger}
        ${temposEtapa}
        ${acao}
        ${acaoEntregaBebida}
        ${acaoRetiradaItem}
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
    const retirada = card.retirada_confirmada_por_ledger === true && card.historico_cancelamento
      ? `<div class="kds-card__retirada">Rodada retirada às ${escapar(formatarHora(card.retirada_em))}; item cancelado não retirado.</div>`
      : card.retirada_confirmada_por_ledger === true
      ? `<div class="kds-card__retirada">
          Retirada integral confirmada no ledger${card.retirada_em ? ` às ${escapar(formatarHora(card.retirada_em))}` : ''}.
        </div>`
      : card.retirada_estado === 'ASSUMIDA_RETIRADA'
        ? '<div class="kds-card__retirada">Retirada assumida; confirmação indisponível.</div>'
        : '';
    
    const acacaoCancelamento = (!card.historico_cancelamento && card.retirada_estado === 'PENDENTE' && card.estado_preparacao !== 'CANCELADA')
      ? `<div class="kds-card__acoes">
          <button type="button" class="kds-btn-operacao kds-btn-operacao--cancelar"
            data-acao="cancelar-rodada" data-rodada-id="${escapar(card.id)}">
            CANCELAR
          </button>
        </div>`
      : '';

    const cancelamento = card.historico_cancelamento
      ? `<div class="kds-card__cancelamento">
          ${card.historico_tipo === 'rodada' ? 'Cancelamento da rodada' : 'Item cancelado'} · Estado atual da rodada: ${escapar(card.estado_preparacao)}
          <br>
          Motivo: ${escapar(card.cancelamento_motivo || 'Não informado')}
          ${card.cancelamento_justificativa ? `<br>Justificativa: ${escapar(card.cancelamento_justificativa)}` : ''}
          <br>Operador: ${card.cancelamento_por != null ? `#${escapar(card.cancelamento_por)}` : 'Não informado'}
          · ${escapar(formatarDataHoraLocal(new Date(parseServidor(card.cancelamento_em))))}
          <br>Etapa: ${escapar(card.cancelamento_etapa || 'Não informada')}
          · Estado anterior: ${escapar(card.estado_anterior || 'Não informado')}
        </div>`
      : '';
    return `
      <article class="kds-card" data-rodada-id="${escapar(card.id)}">
        <div class="kds-card__topo">
          <div class="kds-card__mesa">${escapar(rotuloMesa(card))}</div>
          <div class="kds-card__hora">
            Chegada ${escapar(formatarHora(card.enviada_em))}
          </div>
        </div>
        <div class="kds-card__meta">${chips}</div>
        ${card.rodada_pronta_em
          ? `<div class="kds-card__meta">Preparação concluída às ${escapar(formatarHora(card.rodada_pronta_em))}</div>` : ''}
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
        ${(card.itens || []).map((item) => htmlItem(
          item, operacoesEmCurso, retiradasEmCurso, card, instante
        )).join('')}
        ${retirada}
        ${cancelamento}
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
          <span>${escapar(ROTULOS_COLUNA[estado] || ROTULO_CANCELADOS)}</span>
          <span class="kds-contador" data-contador="${estado}">${cards.length}</span>
        </header>
        <div class="kds-coluna__lista">${lista}</div>
      </section>`;
  }

  function htmlHistoricoLegado(estado, instante) {
    const disponivel = (valor) => valor == null || String(valor).trim() === '' ? 'Não disponível' : String(valor);
    const data = (valor) => {
      const ms = parseServidor(valor);
      return Number.isFinite(ms) ? formatarDataHoraLocal(new Date(ms)) : 'Não disponível';
    };
    const duracao = (valor) => valor == null ? 'Não reconstruível' : formatarDuracao(valor);
    const registros = (estado.legado || []).map((rodada) => {
      const fim = rodada.retirada_estado === 'RETIRADA' ? rodada.retirada_em
        : rodada.estado_preparacao === 'CANCELADA' ? rodada.cancelamento_em : null;
      const total = fim ? segundosEntre(rodada.enviada_em, fim, instante.getTime()) : null;
      const garcom = fim && (rodada.retirada_estado === 'RETIRADA' || rodada.cancelamento_etapa === 'PRONTA')
        ? segundosEntre(rodada.rodada_pronta_em, fim, instante.getTime()) : null;
      const itens = (rodada.itens || []).map((item) => {
        const cancelado = item.estado_preparacao === 'CANCELADO';
        const fimItem = cancelado ? item.cancelamento_em
          : rodada.retirada_estado === 'RETIRADA' ? rodada.retirada_em : null;
        const tempos = fimItem && !item.cancelamento_sem_evento
          && Array.isArray(item.eventos_preparacao) && item.eventos_preparacao.length
          ? calcularTemposItem({ ...rodada, historico_cancelamento: cancelado, cancelamento_em: null }, item, instante)
          : null;
        return `<div class="kds-item">
          <div class="kds-item__linha"><strong>${escapar(disponivel(item.produto_nome_snapshot))}</strong>
            · Item #${escapar(item.id)} · ${escapar(disponivel(item.estado_preparacao))}</div>
          <div class="kds-item__obs">Comanda: ${escapar(disponivel(item.numero_comanda))}
            · Pedido: ${escapar(disponivel(item.pedido_id))} · Tipo: ${escapar(disponivel(item.tipo_item))}</div>
          <div class="kds-item__obs">Solicitada: ${escapar(disponivel(item.qty_solicitada))}
            · Preparada: ${escapar(disponivel(item.qty_preparada))}
            · Cancelada: ${escapar(disponivel(item.qty_cancelada))}</div>
          ${cancelado ? `<div class="kds-item__obs">Cancelamento do item${item.cancelamento_sem_evento ? ' — evento ausente' : ''}
            · Motivo: ${escapar(disponivel(item.motivo_cancelamento))}
            · Justificativa: ${escapar(disponivel(item.cancelamento_justificativa))}
            · Operador: ${escapar(disponivel(item.operador_cancelamento_id))}
            · ${escapar(data(item.cancelamento_em))}</div>` : ''}
          <div class="kds-item__obs">Espera: ${escapar(duracao(tempos && tempos.espera))}
            · Preparação: ${escapar(duracao(tempos && tempos.preparo))}</div>
        </div>`;
      }).join('');
      return `<article class="kds-card" data-legado-rodada-id="${escapar(rodada.id)}">
        <div class="kds-card__topo"><strong>Mesa ${escapar(disponivel(rodada.mesa_numero))}</strong>
          <span>Rodada ${escapar(disponivel(rodada.numero_rodada))} · ID ${escapar(rodada.id)}</span></div>
        <div class="kds-card__meta">Estado da rodada: ${escapar(disponivel(rodada.estado_preparacao))}
          · Envio: ${escapar(data(rodada.enviada_em))}
          · Operador do envio: ${escapar(disponivel(rodada.operador_envio_id))}</div>
        <div class="kds-card__meta">Retirada: ${escapar(disponivel(rodada.retirada_estado))}
          ${rodada.retirada_sem_evento ? ' — evento ausente' : ''}
          · Horário: ${escapar(data(rodada.retirada_em))}
          · Operador: ${escapar(disponivel(rodada.retirada_por))}</div>
        ${rodada.estado_preparacao === 'CANCELADA' ? `<div class="kds-card__cancelamento">
          Cancelamento da rodada${rodada.cancelamento_sem_evento ? ' — evento ausente' : ''}
          · Motivo: ${escapar(disponivel(rodada.cancelamento_motivo))}
          · Justificativa: ${escapar(disponivel(rodada.cancelamento_justificativa))}
          · Operador: ${escapar(disponivel(rodada.cancelamento_por))}
          · Horário: ${escapar(data(rodada.cancelamento_em))}
          · Etapa: ${escapar(disponivel(rodada.cancelamento_etapa))}
        </div>` : ''}
        <div class="kds-card__meta">Total: ${escapar(duracao(total))}
          · Espera do garçom: ${escapar(duracao(garcom))}</div>
        ${itens}
      </article>`;
    }).join('');
    const paginas = estado.paginasLegado;
    return `<section class="kds-historico" aria-label="Histórico legado">
      <h2>Histórico legado</h2>
      <p>Registros com eventos ausentes; dados e estados apresentados conforme persistidos.</p>
      ${estado.erroLegado ? `<div class="kds-aviso" role="alert">${escapar(estado.erroLegado)}</div>` : ''}
      <div class="kds-coluna__lista">${registros || (estado.erroLegado ? ''
        : `<div class="kds-vazio">${estado.carregando ? 'Carregando histórico legado…' : 'Nenhum registro legado nesta página'}</div>`)}</div>
      <div class="kds-historico__paginacao">
        <button type="button" class="kds-btn-secundario" data-acao="pagina-legado-anterior"
          ${!paginas || paginas.indice <= 0 ? 'disabled' : ''}>Anterior</button>
        <span>Página ${paginas ? paginas.indice + 1 : 1} · Atualizar agora inicia uma nova consulta</span>
        <button type="button" class="kds-btn-secundario" data-acao="pagina-legado-proxima"
          ${!paginas || !paginas.proximo ? 'disabled' : ''}>Próxima</button>
      </div>
    </section>`;
  }

  function htmlPainel(estado, instante) {
    const dist = estado.distribuicao || distribuirPorEstado(estado.rodadas || []);
    const operacoesEmCurso = estado.acoesEmCurso || {};
    const retiradasEmCurso = estado.retiradasEmCurso || {};
    const counts = contadores(dist);
    const ultima = estado.ultimaAtualizacao
      ? formatarDataHoraLocal(estado.ultimaAtualizacao)
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
          ${htmlColuna('RETIRADO', dist.RETIRADO || [], operacoesEmCurso, retiradasEmCurso, instante)}
        </div>`;
    const pagina = (tipo, dados, total, semEvento) => `
      <div class="kds-historico__paginacao">
        <button type="button" class="kds-btn-secundario" data-acao="pagina-${tipo}-anterior" ${!dados || dados.indice <= 0 ? 'disabled' : ''}>Anterior</button>
        <span>Página ${dados ? dados.indice + 1 : 1} · ${total} rodadas no snapshot (use Atualizar agora para novos eventos)</span>
        <button type="button" class="kds-btn-secundario" data-acao="pagina-${tipo}-proxima" ${!dados || !dados.proximo ? 'disabled' : ''}>Próxima</button>
        ${semEvento ? `<span role="alert">${semEvento} rodada(s) sem evento histórico; consulte o histórico legado.</span>` : ''}
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
              · Última atualização: <strong data-kds-ultima>${escapar(ultima)}</strong>
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
            <button type="button" class="kds-btn-secundario" data-acao="historico-cancelados">
              ${estado.mostrarCancelados ? 'Ocultar cancelados' : 'Histórico de cancelados'}
            </button>
            <button type="button" class="kds-btn-secundario" data-acao="pedidos-cancelados">
              ${estado.mostrarPedidosCancelados ? 'Ocultar pedidos comerciais cancelados' : 'Pedidos comerciais cancelados'}
            </button>
            <button type="button" class="kds-btn-secundario" data-acao="historico-legado">
              ${estado.mostrarLegado ? 'Ocultar histórico legado' : 'Histórico legado'}
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
        ${pagina('retirados', estado.paginasRetirados, estado.totalRetirados || 0, estado.semEventoRetirados)}
        ${estado.mostrarCancelados ? `<div class="kds-historico">
          ${htmlColuna('CANCELADO', estado.cancelados || [], operacoesEmCurso, retiradasEmCurso, instante)}
          ${pagina('cancelados', estado.paginasCancelados, estado.totalCancelados || 0, estado.semEventoCancelados)}
        </div>` : ''}
        ${estado.mostrarLegado ? htmlHistoricoLegado(estado, instante) : ''}
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
    const chavesRetiradaPendentes = new Map();
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
      cancelados: [],
      mostrarCancelados: false,
      mostrarPedidosCancelados: false,
      legado: [],
      mostrarLegado: false,
      erroLegado: '',
      paginasLegado: { cursores: [null], indice: 0, proximo: null },
      paginasRetirados: { cursores: [null], indice: 0, proximo: null },
      paginasCancelados: { cursores: [null], indice: 0, proximo: null },
      totalRetirados: 0,
      totalCancelados: 0,
      semEventoRetirados: 0,
      semEventoCancelados: 0,
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
      if (typeof deps.fecharSolicitacaoCancelamento === 'function') deps.fecharSolicitacaoCancelamento();
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
        const retirados = estado.paginasRetirados;
        const cancelados = estado.paginasCancelados;
        const indiceCancelados = cancelados.indice;
        const cursorRetirados = retirados.cursores[retirados.indice];
        const cursorCancelados = cancelados.cursores[indiceCancelados];
        const data = await fetchJson('GET', `/cozinha/preparacao/painel?limite=${LIMITE_PAINEL}&offset=0&historicos=1&paginacao=cursor&incluir_pedidos_cancelados=${estado.mostrarPedidosCancelados ? '1' : '0'}${cursorRetirados ? `&cursor_retirados=${encodeURIComponent(cursorRetirados)}` : ''}${cursorCancelados ? `&cursor_cancelados=${encodeURIComponent(cursorCancelados)}` : ''}`);
        if (!estado.ativo || ticket !== seq) return { obsoleta: true };
        estado.rodadas = Array.isArray(data && data.rodadas) ? data.rodadas : [];
        if (data.historico_retirados && Array.isArray(data.historico_retirados.rodadas)) {
          estado.rodadas = estado.rodadas.concat(data.historico_retirados.rodadas);
          estado.totalRetirados = Number(data.historico_retirados.total) || 0;
          estado.semEventoRetirados = Number(data.historico_retirados.registros_sem_evento) || 0;
          retirados.cursores[retirados.indice] = data.historico_retirados.cursor_atual || null;
          retirados.proximo = data.historico_retirados.cursor_proximo || null;
        }
        if (estado.paginasCancelados === cancelados && cancelados.indice === indiceCancelados
          && data.historico_cancelados && Array.isArray(data.historico_cancelados.rodadas)) {
          estado.totalCancelados = Number(data.historico_cancelados.total) || 0;
          estado.semEventoCancelados = Number(data.historico_cancelados.registros_sem_evento) || 0;
          cancelados.cursores[indiceCancelados] = data.historico_cancelados.cursor_atual || null;
          cancelados.proximo = data.historico_cancelados.cursor_proximo || null;
          estado.cancelados = data.historico_cancelados.rodadas.flatMap((rodada) => {
            const evento = rodada.cancelamento_evento;
            const resumoRodada = evento ? [{
              ...rodada,
              itens: evento.item_ids == null ? rodada.itens : rodada.itens.filter((item) => evento.item_ids.includes(item.id)),
              historico_cancelamento: true,
              historico_tipo: 'rodada',
              cancelamento_motivo: evento.motivo,
              cancelamento_justificativa: evento.justificativa,
              cancelamento_por: evento.operador_id,
              cancelamento_em: evento.em,
              cancelamento_etapa: evento.etapa,
              estado_anterior: evento.etapa
            }] : [];
            return resumoRodada.concat(rodada.itens.map((item) => ({
              ...rodada,
              itens: [item],
              historico_cancelamento: true,
              historico_tipo: 'item',
              rodada_pronta_em: item.rodada_pronta_em_cancelamento
                || (item.cancelamento_etapa === 'PRONTA' ? rodada.rodada_pronta_em : null),
              cancelamento_motivo: item.cancelamento_motivo,
              cancelamento_justificativa: item.cancelamento_justificativa,
              cancelamento_por: item.cancelamento_por,
              cancelamento_em: item.cancelamento_em,
              cancelamento_etapa: item.cancelamento_etapa,
              estado_anterior: item.estado_anterior
            })));
          });
        }
        if (estado.mostrarLegado) {
          const paginas = estado.paginasLegado;
          const indice = paginas.indice;
          const cursor = paginas.cursores[indice];
          try {
            const legado = await fetchJson('GET', `/cozinha/preparacao/painel?historico=legado&limite=${LIMITE_PAINEL}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            if (!estado.ativo || ticket !== seq) return { obsoleta: true };
            if (estado.mostrarLegado && estado.paginasLegado === paginas && paginas.indice === indice) {
              if (!legado || !Array.isArray(legado.registros)) throw new Error('Resposta inválida do histórico legado.');
              estado.legado = legado.registros;
              paginas.cursores[indice] = legado.cursor_atual || null;
              paginas.proximo = legado.cursor_proximo || null;
              estado.erroLegado = '';
            }
          } catch (err) {
            if (!estado.ativo || ticket !== seq) return { obsoleta: true };
            if (estado.mostrarLegado && estado.paginasLegado === paginas && paginas.indice === indice) {
              estado.legado = [];
              estado.erroLegado = mensagemDe(err);
            }
          }
        }
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

    async function alternarHistoricoCancelados() {
      estado.mostrarCancelados = !estado.mostrarCancelados;
      if (estado.mostrarCancelados) {
        reiniciarHistorico('cancelados');
        estado.cancelados = [];
        estado.totalCancelados = 0;
        estado.semEventoCancelados = 0;
      }
      publicar();
      if (estado.mostrarCancelados) return atualizar({ forcar: true });
    }

    async function alternarPedidosCancelados() {
      estado.mostrarPedidosCancelados = !estado.mostrarPedidosCancelados;
      publicar();
      return atualizar({ forcar: true });
    }

    async function alternarHistoricoLegado() {
      estado.mostrarLegado = !estado.mostrarLegado;
      publicar();
      if (estado.mostrarLegado) return atualizar({ forcar: true });
    }

    async function mudarPaginaHistorico(tipo, direcao) {
      const chave = { retirados: 'paginasRetirados', cancelados: 'paginasCancelados', legado: 'paginasLegado' }[tipo];
      if (!chave) throw new Error('Histórico inválido.');
      const paginas = estado[chave];
      if (direcao < 0) {
        if (paginas.indice === 0) return;
        paginas.indice -= 1;
      } else {
        if (!paginas.proximo) return;
        paginas.cursores = paginas.cursores.slice(0, paginas.indice + 1);
        paginas.cursores.push(paginas.proximo);
        paginas.indice += 1;
      }
      if (tipo === 'legado') {
        estado.legado = [];
        estado.erroLegado = '';
      }
      await atualizar({ forcar: true });
    }

    function reiniciarHistorico(tipo) {
      const chave = { retirados: 'paginasRetirados', cancelados: 'paginasCancelados', legado: 'paginasLegado' }[tipo];
      if (!chave) throw new Error('Histórico inválido.');
      estado[chave] = { cursores: [null], indice: 0, proximo: null };
    }

    async function atualizarHistoricos() {
      reiniciarHistorico('retirados');
      reiniciarHistorico('cancelados');
      reiniciarHistorico('legado');
      estado.legado = [];
      estado.erroLegado = '';
      return atualizar({ forcar: true });
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
          sucesso: 'Preparo iniciado.'
        }
        : acao === 'pronto'
          ? {
            estadoEsperado: 'EM_PREPARACAO',
            estadoDestino: 'PRONTO',
            caminho: 'pronto',
            sucesso: 'Item marcado como pronto.'
          }
          : acao === 'voltar'
            ? {
              estadoEsperado: 'EM_PREPARACAO',
              estadoDestino: 'AGUARDANDO',
              caminho: 'aguardando',
              sucesso: 'Item retornado para aguardando.'
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
          } else if (acao === 'voltar') {
            atual.item.iniciado_em = null;
            atual.item.operador_inicio_id = null;
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

    async function registrarQuantidadeItem(itemIdRaw, tipo) {
      const itemId = Number(itemIdRaw);
      if (!Number.isInteger(itemId) || itemId <= 0) return { ignorada: true };
      if (estado.retiradasEmCurso[itemId]) return { ignorada: true, sobreposta: true };
      const encontrado = localizarItem(itemId);
      const item = encontrado && encontrado.item;
      const rodada = encontrado && encontrado.rodada;
      if (!item || !rodada || item.estado_preparacao !== 'PRONTO'
        || rodada.historico_cancelamento) {
        estado.feedback = 'O item não está disponível para esta operação. Atualize o painel.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }

      const bebida = String(item.tipo_item || '').toUpperCase() === 'BEBIDA';
      const saldoExibido = tipo === 'entrega'
        ? item.qty_pendente_entrega
        : bebida ? item.qty_disponivel_retirada : item.qty_pendente_retirada;
      const saldoMillis = parsearMilessimosUI(saldoExibido);
      if (
        (tipo === 'entrega' && (!bebida || item.estado_preparacao !== 'PRONTO'))
        || (tipo === 'retirada' && (rodada.estado_preparacao !== 'PRONTA'
          || item.qty_pendente_retirada == null))
        || !Number.isSafeInteger(saldoMillis)
        || saldoMillis <= 0
      ) {
        estado.feedback = 'O saldo calculado não está disponível. Atualize o painel antes de tentar novamente.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }

      estado.retiradasEmCurso[itemId] = true;
      estado.feedback = '';
      estado.feedbackTipo = '';
      publicar();
      const operacao = tipo === 'entrega' ? 'entrega-bebida' : 'retirada-item';
      const chavePendente = `${operacao}:${itemId}`;
      let chaveRegistrada = null;
      try {
        chaveRegistrada = chavesRetiradaPendentes.get(chavePendente);
        if (!chaveRegistrada) {
          const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
          const chaveNova = typeof deps.gerarChaveIdempotencia === 'function'
            ? deps.gerarChaveIdempotencia(operacao, itemId)
            : cryptoApi && typeof cryptoApi.randomUUID === 'function'
              ? cryptoApi.randomUUID()
              : cryptoApi && typeof cryptoApi.getRandomValues === 'function'
                ? Array.from(cryptoApi.getRandomValues(new Uint8Array(16)),
                  (byte) => byte.toString(16).padStart(2, '0')).join('')
                : `kds:${operacao}:${itemId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
          chaveRegistrada = chaveNova;
          chavesRetiradaPendentes.set(chavePendente, chaveRegistrada);
        }
        const path = tipo === 'entrega'
          ? `/cozinha/itens/${itemId}/bebida/entregar`
          : `/cozinha/itens/${itemId}/retirada-ledger`;
        const data = await fetchJson('POST', path, {
          idempotency_key: chaveRegistrada
        });
        const quantidadeConfirmada = tipo === 'entrega'
          ? parsearMilessimosUI(data && data.entrega && data.entrega.qty_entregue)
          : Number(data && data.qty_millis);
        const respostaValida = tipo === 'entrega'
          ? data && data.success === true && data.entrega && data.item
            && Number(data.item.id) === itemId && Number.isSafeInteger(quantidadeConfirmada)
            && quantidadeConfirmada > 0
          : data && data.success === true
            && Number(data.cozinha_item_id) === itemId
            && Number.isSafeInteger(quantidadeConfirmada) && quantidadeConfirmada > 0;
        if (!respostaValida) {
          throw Object.assign(new Error(
            tipo === 'entrega'
              ? 'O servidor não confirmou a entrega da bebida.'
              : 'O servidor não confirmou a retirada individual.'
          ), { codigo: 'RESPOSTA_LEDGER_ITEM_INVALIDA' });
        }
        estado.feedback = data.repetida
          ? 'Operação já estava registrada.'
          : tipo === 'entrega' ? 'Entrega da bebida registrada.' : 'Retirada individual registrada.';
        estado.feedbackTipo = 'sucesso';
        if (chavesRetiradaPendentes.get(chavePendente) === chaveRegistrada) {
          chavesRetiradaPendentes.delete(chavePendente);
        }
        publicar();
        await atualizar({ silencioso: true, forcar: true });
        return { ok: true, data };
      } catch (err) {
        estado.feedback = mensagemDe(err);
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: err };
      } finally {
        delete estado.retiradasEmCurso[itemId];
        publicar();
      }
    }

    function confirmarRetiradaItem(itemId) {
      return registrarQuantidadeItem(itemId, 'retirada');
    }

    function entregarBebida(itemId) {
      return registrarQuantidadeItem(itemId, 'entrega');
    }

    async function cancelarOperacao(tipo, idRaw) {
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) return { ignorada: true };
      let encontrado = tipo === 'item' ? localizarItem(id) : null;
      let rodada = encontrado ? encontrado.rodada : estado.rodadas.find((candidata) => Number(candidata.id) === id);
      let item = encontrado && encontrado.item;
      const chaveOperacao = `${tipo}:${id}`;
      if (estado.cancelamentosEmCurso === undefined) estado.cancelamentosEmCurso = {};
      if (estado.cancelamentosEmCurso[chaveOperacao]) return { ignorada: true, sobreposta: true };
      if (!rodada || (tipo === 'item' && !item) || rodada.retirada_estado !== 'PENDENTE' || rodada.estado_preparacao === 'CANCELADA') {
        estado.feedback = 'A rodada já foi retirada ou cancelada. Não é possível cancelar.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }

      if (typeof deps.solicitarCancelamento !== 'function') {
        estado.feedback = 'Não foi possível solicitar o motivo do cancelamento.';
        estado.feedbackTipo = 'erro';
        publicar();
        return { erro: true };
      }
      estado.cancelamentosEmCurso[chaveOperacao] = true;
      const empresaId = estado.empresaId;
      const unidadeId = estado.unidadeId;
      try {
        const dados = await deps.solicitarCancelamento(tipo, id);
        if (!dados) return { cancelada: true };
        const motivoFinal = String(dados.motivo || '').trim().toUpperCase();
        const justificativa = String(dados.justificativa || '').trim();
        if (!MOTIVOS_CANCELAMENTO.some(([codigo]) => codigo === motivoFinal)) {
          throw new Error('Motivo inválido. Cancelamento não foi enviado.');
        }
        if (motivoFinal === 'OUTRO' && !justificativa) {
          throw new Error('Justificativa obrigatória para motivo "OUTRO". Cancelamento não foi enviado.');
        }
        if (!estado.ativo || estado.modo !== 'painel'
          || estado.empresaId !== empresaId || estado.unidadeId !== unidadeId
          || (typeof deps.lerUnidadeJwt === 'function' && Number(deps.lerUnidadeJwt()) !== Number(unidadeId))) {
          throw new Error('O contexto da cozinha mudou. Cancelamento não foi enviado.');
        }
        encontrado = tipo === 'item' ? localizarItem(id) : null;
        rodada = encontrado ? encontrado.rodada : estado.rodadas.find((candidata) => Number(candidata.id) === id);
        item = encontrado && encontrado.item;
        if (!rodada || (tipo === 'item' && (!item || item.estado_preparacao === 'CANCELADO'))
          || rodada.retirada_estado !== 'PENDENTE' || rodada.estado_preparacao === 'CANCELADA') {
          throw new Error('A rodada ou o item não está mais disponível para cancelamento.');
        }
        estado.feedback = '';
        estado.feedbackTipo = '';
        publicar();
        const chave = typeof deps.gerarChaveIdempotencia === 'function'
          ? deps.gerarChaveIdempotencia(`cancelamento-${tipo}`, id)
          : `kds:cancelamento:${tipo}:${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
        const data = await fetchJson(
          'POST',
          `/cozinha/${tipo === 'item' ? 'itens' : 'rodadas'}/${id}/cancelar`,
          {
            idempotency_key: chave,
            motivo: motivoFinal,
            justificativa: justificativa || null
          }
        );
        if (!data || data.success !== true || !data.rodada
          || Number(data.rodada.id) !== Number(rodada.id)
          || (tipo === 'rodada' && data.rodada.estado_preparacao !== 'CANCELADA')
          || (tipo === 'item' && (!data.item || Number(data.item.id) !== id || data.item.estado_preparacao !== 'CANCELADO'))) {
          throw Object.assign(new Error('O servidor não confirmou o cancelamento.'), {
            codigo: 'RESPOSTA_CANCELAMENTO_INVALIDA'
          });
        }
        if (item) Object.assign(item, data.item);
        if (tipo === 'rodada') {
          (rodada.itens || []).forEach((i) => { i.estado_preparacao = 'CANCELADO'; });
        }
        Object.assign(rodada, data.rodada);
        reiniciarHistorico('cancelados');
        estado.distribuicao = distribuirPorEstado(estado.rodadas);
        estado.feedback = data.repetida ? 'Cancelamento já estava registrado.' : 'Cancelamento operacional registrado.';
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
        delete estado.cancelamentosEmCurso[chaveOperacao];
        publicar();
      }
    }

    function cancelarRodada(id) { return cancelarOperacao('rodada', id); }
    function cancelarItem(id) { return cancelarOperacao('item', id); }

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
        if (!estado.ativo) return { ignorada: true };
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
        if (!estado.ativo) return { ignorada: true };
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
      if (typeof deps.fecharSolicitacaoCancelamento === 'function') deps.fecharSolicitacaoCancelamento();
      if (timer != null && deps.cancelar) deps.cancelar(timer);
      timer = null;
      pararCronometros();
      seq += 1;
      estado.emCurso = false;
      estado.carregando = false;
      estado.rodadas = [];
      estado.cancelados = [];
      estado.legado = [];
      estado.mostrarLegado = false;
      estado.erroLegado = '';
      estado.distribuicao = distribuirPorEstado([]);
      reiniciarHistorico('retirados');
      reiniciarHistorico('cancelados');
      reiniciarHistorico('legado');
      estado.totalRetirados = 0;
      estado.totalCancelados = 0;
      estado.semEventoRetirados = 0;
      estado.semEventoCancelados = 0;
      estado.teveSucesso = false;
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
      confirmarRetiradaItem,
      entregarBebida,
      cancelarRodada,
      cancelarItem,
      alternarHistoricoCancelados,
      alternarPedidosCancelados,
      alternarHistoricoLegado,
      mudarPaginaHistorico,
      carregarUnidadesDisponiveis,
      definirUnidadeSelecionada,
      confirmarUnidade,
      voltarParaSelecao,
      atualizarHistoricos,
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
    const opcoes = {
      method, headers,
      body: corpo && method !== 'GET' ? JSON.stringify(corpo) : undefined
    };
    const tv = global.document && global.document.getElementById('cds-rede-status');
    let timer = null;
    let controller = null;
    const consulta = async () => {
      const resp = await global.fetch(base + path, opcoes);
      const data = await resp.json().catch(() => ({}));
      return { resp, data };
    };
    let resultado;
    try {
      if (tv && method === 'GET') {
        if (typeof global.AbortController === 'function') {
          controller = new global.AbortController();
          opcoes.signal = controller.signal;
        }
        resultado = await Promise.race([
          consulta(),
          new Promise((resolve, reject) => {
            timer = global.setTimeout(() => {
              reject(new Error('Tempo esgotado ao consultar a cozinha. A atualização será tentada novamente.'));
              if (controller) controller.abort();
            }, 10000);
          })
        ]);
      } else {
        resultado = await consulta();
      }
    } finally {
      if (timer != null) global.clearTimeout(timer);
    }
    const { resp, data } = resultado;
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

  function criarSolicitadorCancelamento(global) {
    let fecharAtual = null;

    function solicitar(tipo, id) {
      if (fecharAtual) throw new Error('Já existe um cancelamento em andamento.');
      const dialogo = global.document.createElement('dialog');
      dialogo.className = 'kds-dialogo-cancelamento';
      dialogo.setAttribute('aria-labelledby', 'kds-cancelamento-titulo');
      dialogo.innerHTML = `
        <form class="kds-dialogo-cancelamento__form">
          <h2 id="kds-cancelamento-titulo">Cancelar ${tipo === 'item' ? 'item' : 'rodada'}${id ? ` #${escapar(id)}` : ''}</h2>
          <p>Este cancelamento é somente operacional e não cancela o pedido ou pagamento.</p>
          <label for="kds-cancelamento-motivo">Motivo do cancelamento</label>
          <select id="kds-cancelamento-motivo">
            <option value="">Selecione um motivo</option>
            ${MOTIVOS_CANCELAMENTO.map(([codigo, rotulo]) => `<option value="${codigo}">${escapar(rotulo)}</option>`).join('')}
          </select>
          <label for="kds-cancelamento-justificativa">Justificativa <span>(obrigatória para Outro)</span></label>
          <textarea id="kds-cancelamento-justificativa" rows="3"></textarea>
          <div class="kds-dialogo-cancelamento__erro" role="alert"></div>
          <div class="kds-dialogo-cancelamento__acoes">
            <button type="button" data-acao="fechar">Voltar</button>
            <button type="submit" class="kds-dialogo-cancelamento__confirmar">Confirmar cancelamento</button>
          </div>
        </form>`;
      const form = dialogo.querySelector('form');
      const motivo = dialogo.querySelector('#kds-cancelamento-motivo');
      const justificativa = dialogo.querySelector('#kds-cancelamento-justificativa');
      const erro = dialogo.querySelector('.kds-dialogo-cancelamento__erro');
      const focoAnterior = global.document.activeElement;
      return new Promise((resolve, reject) => {
        function fechar(resultado) {
          fecharAtual = null;
          if (dialogo.open) dialogo.close();
          dialogo.remove();
          if (focoAnterior && focoAnterior.isConnected && typeof focoAnterior.focus === 'function') focoAnterior.focus();
          resolve(resultado);
        }
        fecharAtual = () => fechar(null);
        dialogo.addEventListener('cancel', (event) => {
          event.preventDefault();
          fechar(null);
        });
        dialogo.querySelector('[data-acao="fechar"]').addEventListener('click', () => fechar(null));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!motivo.value) {
            erro.textContent = 'Selecione um motivo.';
            motivo.focus();
            return;
          }
          if (motivo.value === 'OUTRO' && !justificativa.value.trim()) {
            erro.textContent = 'Informe a justificativa para o motivo Outro.';
            justificativa.focus();
            return;
          }
          fechar({ motivo: motivo.value, justificativa: justificativa.value.trim() });
        });
        try {
          global.document.body.appendChild(dialogo);
          dialogo.showModal();
          motivo.focus();
        } catch (err) {
          fecharAtual = null;
          dialogo.remove();
          reject(err);
        }
      });
    }

    return { solicitar, fechar: () => { if (fecharAtual) fecharAtual(); } };
  }

  function montarNoNavegador(global) {
    const contexto = global.CdsEmpresaContexto;
    const empresa = contexto && contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    const solicitador = criarSolicitadorCancelamento(global);
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
      solicitarCancelamento: solicitador.solicitar,
      fecharSolicitacaoCancelamento: solicitador.fechar,
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
    control.iniciar = async function iniciarNaTela(host, opts) {
      if (contexto && contexto.temEmpresaSelecionada && !contexto.temEmpresaSelecionada()) {
        if (host) {
          host.innerHTML = `<div class="alert alert-warning">${escapar(contexto.mensagemEmpresaObrigatoria())}</div>`;
        }
        return control.estado;
      }
      await originalIniciar(opts);
      if (control.estado.ativo) desenhar(global, control, host);
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
        control.atualizarHistoricos();
      });
    }
    const trocar = raiz.querySelector('[data-acao="trocar-unidade"]');
    if (trocar) {
      trocar.addEventListener('click', () => {
        control.voltarParaSelecao();
      });
    }
    const historico = raiz.querySelector('[data-acao="historico-cancelados"]');
    if (historico) historico.addEventListener('click', () => control.alternarHistoricoCancelados());
    const pedidosCancelados = raiz.querySelector('[data-acao="pedidos-cancelados"]');
    if (pedidosCancelados) pedidosCancelados.addEventListener('click', () => control.alternarPedidosCancelados());
    const legado = raiz.querySelector('[data-acao="historico-legado"]');
    if (legado) legado.addEventListener('click', () => control.alternarHistoricoLegado());
    ['retirados', 'cancelados', 'legado'].forEach((tipo) => {
      ['anterior', 'proxima'].forEach((sentido) => {
        const botaoPagina = raiz.querySelector(`[data-acao="pagina-${tipo}-${sentido}"]`);
        if (botaoPagina) botaoPagina.addEventListener('click', () =>
          control.mudarPaginaHistorico(tipo, sentido === 'anterior' ? -1 : 1));
      });
    });
    raiz.querySelectorAll('[data-acao="iniciar-preparo"], [data-acao="marcar-pronto"], [data-acao="voltar-aguardando"]')
      .forEach((botaoAcao) => {
        botaoAcao.addEventListener('click', () => {
          const nomeAcao = botaoAcao.getAttribute('data-acao');
          const acao = nomeAcao === 'iniciar-preparo'
            ? 'iniciar'
            : nomeAcao === 'voltar-aguardando' ? 'voltar' : 'pronto';
          control.operarItem(botaoAcao.getAttribute('data-item-id'), acao);
        });
      });
    raiz.querySelectorAll('[data-acao="confirmar-retirada-item"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => {
        control.confirmarRetiradaItem(botaoAcao.getAttribute('data-item-id'));
      });
    });
    raiz.querySelectorAll('[data-acao="entregar-bebida"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => {
        control.entregarBebida(botaoAcao.getAttribute('data-item-id'));
      });
    });
    raiz.querySelectorAll('[data-acao="cancelar-rodada"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => {
        control.cancelarRodada(botaoAcao.getAttribute('data-rodada-id'));
      });
    });
    raiz.querySelectorAll('[data-acao="cancelar-item"]').forEach((botaoAcao) => {
      botaoAcao.addEventListener('click', () => control.cancelarItem(botaoAcao.getAttribute('data-item-id')));
    });
  }

  return {
    INTERVALO_MS,
    LIMITE_PAINEL,
    ESTADOS_COLUNA,
    ROTULOS_COLUNA,
    escapar,
    formatarHora,
    formatarDataHoraLocal,
    segundosEntre,
    formatarDuracao,
    calcularTemposItem,
    htmlCronometro,
    atualizarCronometros,
    formatarQtd,
    parsearMilessimosUI,
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
    criarSolicitadorCancelamento,
    criarControlador,
    montarNoNavegador
  };
}));
