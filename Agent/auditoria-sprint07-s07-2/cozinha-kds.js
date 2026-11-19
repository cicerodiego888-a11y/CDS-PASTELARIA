/**
 * Sprint 07 · S07-1 — Painel KDS (somente consulta).
 * Sprint 07 · S07-2 — Seleção segura de unidade operacional (JWT).
 * Consome GET /api/cozinha/preparacao/painel (contrato S07-0).
 * Sem mutação de estado de pedidos, sem dual-write, sem impressão.
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
  const ESTADOS_COLUNA = Object.freeze(['AGUARDANDO', 'EM_PREPARACAO', 'PRONTO']);
  const ROTULOS_COLUNA = Object.freeze({
    AGUARDANDO: 'Aguardando',
    EM_PREPARACAO: 'Em preparação',
    PRONTO: 'Prontos'
  });
  const CLASSES_COLUNA = Object.freeze({
    AGUARDANDO: 'kds-coluna--aguardando',
    EM_PREPARACAO: 'kds-coluna--preparacao',
    PRONTO: 'kds-coluna--prontos'
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
    const iso = /Z|[+-]\d{2}:\d{2}$/.test(texto) ? texto : `${texto}Z`;
    return Date.parse(iso);
  }

  function formatarHora(valor) {
    const ms = parseServidor(valor);
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function formatarDataHoraLocal(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    const dd = String(date.getDate()).padStart(2, '0');
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${dd}/${mo}/${yyyy} ${hh}:${mm}:${ss}`;
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
      PRONTO: []
    };
    (rodadas || []).forEach((rodada) => {
      if (!rodada) return;
      ESTADOS_COLUNA.forEach((estado) => {
        const itens = (rodada.itens || [])
          .filter((it) => String(it.estado_preparacao || '').toUpperCase() === estado)
          .slice()
          .sort(compararItensFifo);
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
          enviada_em: rodada.enviada_em,
          created_at: rodada.created_at,
          itens
        });
      });
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
      corpo = `<div class="kds-selecao__msg" data-kds-sem-unidades="1">
        Nenhuma unidade de cozinha autorizada para este usuário nesta empresa.
        Solicite o cadastro/vínculo ao administrador.
      </div>`;
    } else {
      const opcoes = (estado.unidadesDisponiveis || []).map((u) => {
        const sel = Number(estado.unidadeSelecionadaId) === Number(u.id) ? ' checked' : '';
        const rotulo = u.codigo ? `Unidade ${u.codigo}` : `Unidade #${u.id}`;
        return `<label class="kds-selecao__opcao">
          <input type="radio" name="kds-unidade" value="${escapar(u.id)}"${sel}>
          <span><strong>${escapar(rotulo)}</strong> <span class="kds-selecao__id">#${escapar(u.id)}</span></span>
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
        <header class="kds-cabecalho">
          <div>
            <h1 class="kds-cabecalho__titulo">Cozinha <span>(KDS)</span></h1>
            <div class="kds-cabecalho__meta">
              <strong>${escapar(empresa)}</strong>
              · Selecione a unidade operacional
            </div>
          </div>
        </header>
        <div class="kds-selecao__corpo">
          <p class="kds-selecao__intro">
            Escolha a unidade de cozinha autorizada para esta sessão.
            A seleção é obrigatória e será validada pelo servidor.
          </p>
          ${aviso}
          ${corpo}
          <div class="kds-selecao__acoes">
            <button type="button" class="kds-btn-atualizar" data-acao="confirmar-unidade"
              ${podeConfirmar ? '' : 'disabled'}>
              ${estado.selecaoConfirmando ? 'Confirmando…' : 'Confirmar unidade'}
            </button>
            <button type="button" class="kds-btn-secundario" data-acao="recarregar-unidades"
              ${estado.selecaoCarregando || estado.selecaoConfirmando ? 'disabled' : ''}>
              Atualizar lista
            </button>
          </div>
        </div>
      </div>`;
  }

  function htmlItem(item) {
    const obs = item.observacoes_snapshot != null && String(item.observacoes_snapshot).trim() !== ''
      ? `<div class="kds-item__obs">${escapar(item.observacoes_snapshot)}</div>`
      : '';
    return `
      <div class="kds-item" data-item-id="${escapar(item.id)}">
        <div class="kds-item__linha">
          <span class="kds-item__qtd">${escapar(formatarQtd(item.qty_solicitada))}</span>
          <span class="kds-item__nome">${escapar(item.produto_nome_snapshot || 'Produto')}</span>
          <span class="kds-item__tipo">${escapar(item.tipo_item || '')}</span>
        </div>
        ${obs}
      </div>`;
  }

  function htmlCard(card) {
    const comanda = numeroComanda(card.itens);
    const chips = [
      comanda != null ? `Comanda ${comanda}` : null,
      card.numero_rodada != null ? `Rodada ${card.numero_rodada}` : null,
      card.sequencia_global != null ? `Seq. ${card.sequencia_global}` : null
    ].filter(Boolean).map((t) => `<span class="kds-chip">${escapar(t)}</span>`).join('');
    return `
      <article class="kds-card" data-rodada-id="${escapar(card.id)}">
        <div class="kds-card__topo">
          <div class="kds-card__mesa">${escapar(rotuloMesa(card))}</div>
          <div class="kds-card__hora">${escapar(formatarHora(card.enviada_em || card.created_at))}</div>
        </div>
        <div class="kds-card__meta">${chips}</div>
        ${(card.itens || []).map(htmlItem).join('')}
      </article>`;
  }

  function htmlColuna(estado, cards) {
    const lista = !cards.length
      ? `<div class="kds-vazio">Nenhum pedido</div>`
      : cards.map(htmlCard).join('');
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

    const corpoVazioInicial = estado.carregando && !(estado.rodadas && estado.rodadas.length) && !estado.erro
      ? `<div class="kds-carregando-global">Carregando painel da cozinha…</div>`
      : `<div class="kds-colunas">
          ${htmlColuna('AGUARDANDO', dist.AGUARDANDO || [])}
          ${htmlColuna('EM_PREPARACAO', dist.EM_PREPARACAO || [])}
          ${htmlColuna('PRONTO', dist.PRONTO || [])}
        </div>`;

    return `
      <div class="kds-painel" data-painel-kds="1">
        <header class="kds-cabecalho">
          <div>
            <h1 class="kds-cabecalho__titulo">Cozinha <span>(KDS)</span></h1>
            <div class="kds-cabecalho__meta">
              <strong>${escapar(empresa)}</strong>
              · ${escapar(unidade)}
              · Última atualização: <strong data-kds-ultima>${escapar(ultima)}</strong>
              <span class="visually-hidden">${escapar(formatarDataHoraLocal(instante))}</span>
            </div>
          </div>
          <div class="kds-cabecalho__acoes">
            <span class="kds-status ${statusClasse}" data-kds-status="${escapar(statusClasse)}">
              <span class="kds-status__dot" aria-hidden="true"></span>
              ${escapar(statusTexto)}
            </span>
            <button type="button" class="kds-btn-atualizar" data-acao="atualizar"
              ${estado.carregando ? 'disabled' : ''}>
              Atualizar agora
            </button>
          </div>
        </header>
        ${aviso}
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
    let timer = null;
    let seq = 0;
    const estado = {
      ativo: false,
      carregando: false,
      emCurso: false,
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
      teveSucesso: false,
      unidadesDisponiveis: [],
      unidadeSelecionadaId: null,
      selecaoCarregando: false,
      selecaoConfirmando: false,
      selecaoErro: '',
      selecaoFalhaLista: false
    };

    function publicar() {
      if (deps.aoMudar && estado.ativo) deps.aoMudar();
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
    }

    async function atualizar(opts) {
      const silencioso = !!(opts && opts.silencioso);
      if (!estado.ativo || estado.modo !== 'painel') return { ignorada: true };
      if (estado.emCurso) return { ignorada: true, sobreposta: true };
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
        }
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
        // Não auto-seleciona nem auto-confirma a primeira unidade.
        estado.unidadeSelecionadaId = null;
        return { ok: true, data };
      } catch (err) {
        estado.selecaoFalhaLista = true;
        estado.unidadesDisponiveis = [];
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
        if (typeof deps.aoAtualizarSessao === 'function') {
          deps.aoAtualizarSessao(data);
        }
        const unidadeToken = lerUnidadeCozinhaDoToken(data.token);
        if (unidadeToken !== id && Number(data.unidade_cozinha_id) !== id) {
          throw Object.assign(new Error('Token recebido sem a unidade selecionada.'), {
            codigo: 'TOKEN_UNIDADE_DIVERGENTE'
          });
        }
        estado.modo = 'painel';
        estado.unidadeId = Number(data.unidade_cozinha_id) || id;
        estado.selecaoConfirmando = false;
        publicar();
        await atualizar({ silencioso: false });
        agendar();
        return { ok: true, data };
      } catch (err) {
        estado.selecaoErro = mensagemDe(err);
        estado.selecaoConfirmando = false;
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
        await atualizar({ silencioso: false });
        agendar();
        return estado;
      }
      estado.modo = 'selecao';
      await carregarUnidadesDisponiveis();
      return estado;
    }

    return {
      estado,
      iniciar,
      parar,
      atualizar,
      carregarUnidadesDisponiveis,
      definirUnidadeSelecionada,
      confirmarUnidade,
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

  function persistirSessao(global, data) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem('token', data.token);
        if (data.user) {
          global.localStorage.setItem('user', JSON.stringify(data.user));
        }
      }
    } catch (_e) { /* ignore */ }
    try {
      if (global.electronAPI
        && global.electronAPI.cozinhaImpressao
        && typeof global.electronAPI.cozinhaImpressao.estabelecerSessao === 'function') {
        global.electronAPI.cozinhaImpressao.estabelecerSessao({ token: data.token });
      }
    } catch (_e2) { /* ignore */ }
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
      lerUnidadeJwt: () => {
        try {
          return lerUnidadeCozinhaDoToken(global.localStorage && global.localStorage.getItem('token'));
        } catch (_e) {
          return null;
        }
      },
      aoAtualizarSessao: (data) => persistirSessao(global, data),
      aoMudar: () => desenhar(global, control, global.document && global.document.getElementById('page-content'))
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
  }

  return {
    INTERVALO_MS,
    LIMITE_PAINEL,
    ESTADOS_COLUNA,
    ROTULOS_COLUNA,
    escapar,
    formatarHora,
    formatarQtd,
    rotuloMesa,
    compararFifo,
    distribuirPorEstado,
    contadores,
    lerUnidadeCozinhaDoToken,
    htmlSelecaoUnidade,
    htmlPainel,
    criarControlador,
    montarNoNavegador
  };
}));
