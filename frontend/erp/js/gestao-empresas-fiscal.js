/**
 * Sprint 05.11 — gestão visual de empresas + configuração fiscal por empresa.
 * Consome GET/PUT oficiais. Não calcula status fiscal no cliente.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.GestaoEmpresasFiscal = api;
        root.loadGestaoEmpresasFiscal = api.loadGestaoEmpresasFiscal;
        root.__CDS_EMPRESAS_MODULE_VERSION = '05.18';
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ESTADOS = Object.freeze({
        LOADING: 'LOADING',
        ERROR: 'ERROR',
        EMPTY: 'EMPTY',
        READY: 'READY',
        SAVING: 'SAVING',
        SUCCESS: 'SUCCESS'
    });

    const STATUS_VISUAL = Object.freeze({
        PRONTA: { texto: 'PRONTA', classe: 'bg-success', marca: '🟢' },
        INCOMPLETA: { texto: 'INCOMPLETA', classe: 'bg-warning text-dark', marca: '🟡' },
        INVALIDA: { texto: 'INVALIDA', classe: 'bg-danger', marca: '🔴' },
        DESATIVADA: { texto: 'DESATIVADA', classe: 'bg-secondary', marca: '⚪' }
    });

    const CAMPOS_FISCAIS_ENVIO = Object.freeze([
        'ambiente', 'serie', 'numero_atual', 'uf', 'codigo_uf',
        'token_csc', 'id_csc', 'ws_autorizacao', 'ws_retorno', 'ws_status',
        'csc_qrcode_url', 'consulta_chave_url',
        'ws_autorizacao_homologacao', 'ws_retorno_homologacao', 'ws_status_homologacao',
        'csc_qrcode_url_homologacao', 'consulta_chave_url_homologacao',
        'ws_autorizacao_producao', 'ws_retorno_producao', 'ws_status_producao',
        'csc_qrcode_url_producao', 'consulta_chave_url_producao',
        'crt', 'ie', 'im', 'cnae',
        'telefone', 'email', 'municipio_codigo', 'municipio_nome', 'cep',
        'logradouro', 'numero_endereco', 'bairro'
    ]);

    const CAMPOS_SEGREDO = Object.freeze([
        'token_csc', 'tokenCsc', 'csc', 'certificado_senha', 'certificadoSenha',
        'senha', 'certificado_path', 'certificadoPath', 'path'
    ]);

    function formatarCnpj(cnpj) {
        const d = String(cnpj || '').replace(/\D/g, '');
        if (d.length !== 14) return cnpj || '—';
        return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    }

    function rotuloStatusOficial(status) {
        const chave = String(status || '').toUpperCase();
        return STATUS_VISUAL[chave] || { texto: chave || '—', classe: 'bg-light text-dark', marca: '•' };
    }

    function juntarEmpresasComStatus(empresas, statusLista) {
        const porId = {};
        (statusLista || []).forEach(function (s) {
            if (s && s.empresa_id != null) porId[Number(s.empresa_id)] = s;
        });
        return (empresas || []).map(function (e) {
            const st = porId[Number(e.id)] || null;
            return {
                id: Number(e.id),
                cnpj: e.cnpj,
                razao_social: e.razao_social,
                nome_fantasia: e.nome_fantasia,
                inscricao_estadual: e.inscricao_estadual,
                inscricao_municipal: e.inscricao_municipal,
                ativo: e.ativo,
                status_fiscal: st ? st.status : null,
                campos_fiscal: st ? st.campos : null
            };
        });
    }

    function filtrarEmpresas(lista, termo) {
        const q = String(termo || '').trim().toLowerCase();
        if (!q) return lista || [];
        return (lista || []).filter(function (e) {
            return [e.razao_social, e.nome_fantasia, e.cnpj, String(e.id)]
                .some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
        });
    }

    function criarSessaoDetalhe() {
        return {
            empresa_id: null,
            empresa: null,
            fiscal: null,
            geracao: 0
        };
    }

    function abrirEmpresa(sessao, empresaId) {
        const id = Number(empresaId);
        return {
            empresa_id: id,
            empresa: null,
            fiscal: null,
            geracao: (sessao && sessao.geracao ? sessao.geracao : 0) + 1
        };
    }

    function empresaANaoCarregaB(sessao, empresaId) {
        return !!(sessao && Number(sessao.empresa_id) === Number(empresaId));
    }

    function urlGetFiscal(empresaId) {
        return `/api/empresas/${Number(empresaId)}/configuracao-fiscal`;
    }

    function urlPutFiscal(empresaId) {
        return `/api/empresas/${Number(empresaId)}/configuracao-fiscal`;
    }

    function urlStatusOficial() {
        return '/api/empresas/configuracao-fiscal/status';
    }

    function montarPayloadFiscal(campos, empresaIdUrl) {
        const out = {};
        const src = campos && typeof campos === 'object' ? campos : {};
        CAMPOS_FISCAIS_ENVIO.forEach(function (k) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) return;
            const v = src[k];
            if (v == null) return;
            if (typeof v === 'string' && v.trim() === '') return;
            out[k] = typeof v === 'string' ? v.trim() : v;
        });
        return out;
    }

    function payloadNaoSubstituiUrl(empresaIdUrl, payload) {
        const p = Object.assign({}, payload || {});
        delete p.empresa_id;
        delete p.empresaId;
        return { urlEmpresaId: Number(empresaIdUrl), payload: p };
    }

    function dtoNaoExpoeSegredos(dto) {
        if (!dto || typeof dto !== 'object') return true;
        return CAMPOS_SEGREDO.every(function (k) {
            if (!Object.prototype.hasOwnProperty.call(dto, k)) return true;
            const v = dto[k];
            return v === true || v === false || v == null;
        });
    }

    function certificadoIsolado(dtoA, dtoB) {
        if (!dtoA || !dtoB) return true;
        if (Number(dtoA.empresa_id) === Number(dtoB.empresa_id)) return true;
        return dtoA.certificado_nome !== dtoB.certificado_nome
            || Number(dtoA.empresa_id) !== Number(dtoB.empresa_id);
    }

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function recursoSemPrefixoApi(pathOuRecurso) {
        let p = String(pathOuRecurso || '').trim();
        if (!p) return '/';
        p = p.replace(/^https?:\/\/[^/]+/i, '');
        while (p === '/api' || p.indexOf('/api/') === 0) {
            p = p === '/api' ? '/' : p.slice(4);
        }
        if (p.charAt(0) !== '/') p = '/' + p;
        return p;
    }

    function urlAbsoluta(pathOuRecurso) {
        const p = String(pathOuRecurso || '');
        if (/^https?:\/\//i.test(p)) {
            return p.replace(/\/api\/api\//g, '/api/');
        }
        return `${baseApi()}${recursoSemPrefixoApi(p)}`;
    }

    function normalizarApiUrl(pathOuRecurso) {
        return urlAbsoluta(pathOuRecurso);
    }

    function versaoModuloEmpresas() {
        if (typeof globalThis.CDS_ERP_ASSET_VERSION === 'string' && globalThis.CDS_ERP_ASSET_VERSION) {
            return globalThis.CDS_ERP_ASSET_VERSION;
        }
        return '05172';
    }

    function logEmpresas(evento, extra) {
        try {
            console.info('[CDS EMPRESAS]', evento, Object.assign({
                versao: '05.18',
                arquivo: 'gestao-empresas-fiscal.js',
                origem: '/erp/js/gestao-empresas-fiscal.js?v=' + versaoModuloEmpresas()
            }, extra || {}));
        } catch (_e) { /* ignore */ }
    }

    function authHeaders(extra) {
        const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        try {
            const token = typeof localStorage !== 'undefined' && localStorage.getItem('token');
            if (token) h.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        return h;
    }

    function feedback(msg, tipo) {
        if (typeof globalThis.showNotification === 'function') {
            globalThis.showNotification(msg, tipo || 'success');
            return;
        }
        const el = document.getElementById('gef-feedback');
        if (el) el.textContent = msg;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function badgeStatus(status) {
        const v = rotuloStatusOficial(status);
        return `<span class="badge ${v.classe}">${v.marca} ${escapeHtml(v.texto)}</span>`;
    }

    function htmlFormNovaEmpresa() {
        return `
            <div class="card mt-3" data-gef-nova="1">
                <div class="card-body">
                    <h3 class="h5">NOVA EMPRESA</h3>
                    <p class="text-muted">Cadastre os dados gerais. Configuração fiscal e certificado só ficam disponíveis depois que a empresa existir.</p>
                    <h4 class="h6 mt-3">DADOS GERAIS</h4>
                    <div class="row g-2">
                        <div class="col-md-6"><label class="form-label">Razão social</label><input id="gef-n-razao" class="form-control"></div>
                        <div class="col-md-6"><label class="form-label">Nome fantasia</label><input id="gef-n-fantasia" class="form-control"></div>
                        <div class="col-md-4"><label class="form-label">CNPJ</label><input id="gef-n-cnpj" class="form-control"></div>
                        <div class="col-md-4"><label class="form-label">Inscrição Estadual</label><input id="gef-n-ie" class="form-control"></div>
                        <div class="col-md-4"><label class="form-label">Inscrição Municipal</label><input id="gef-n-im" class="form-control"></div>
                    </div>
                    <button type="button" class="btn btn-primary mt-3" id="gef-n-salvar">SALVAR EMPRESA</button>
                </div>
            </div>`;
    }

    function valUrlBloco(bloco, chave) {
        if (!bloco || typeof bloco !== 'object') return '';
        const v = bloco[chave];
        return v == null ? '' : String(v);
    }

    function htmlCampoUrl(id, label, valor) {
        return `<div class="col-12"><label class="form-label">${escapeHtml(label)}</label>
            <input id="${id}" class="form-control" value="${escapeHtml(valor)}" autocomplete="off"></div>`;
    }

    function htmlBlocosUrlsFiscais(fiscal) {
        const h = (fiscal && fiscal.urls_homologacao) || {};
        const p = (fiscal && fiscal.urls_producao) || {};
        return `
            <div data-gef-urls="1">
                <h5 class="h6 mt-4" data-gef-urls-bloco="homologacao">URLS HOMOLOGAÇÃO</h5>
                <p class="small text-muted">CONSULTAS</p>
                <div class="row g-2">
                    ${htmlCampoUrl('gef-h-qr', 'URL Consulta QRCode', valUrlBloco(h, 'consultaQr'))}
                    ${htmlCampoUrl('gef-h-chave', 'URL Consulta Chave', valUrlBloco(h, 'consultaChave'))}
                </div>
                <p class="small text-muted mt-3">SERVIÇOS SEFAZ</p>
                <div class="row g-2">
                    ${htmlCampoUrl('gef-h-aut', 'WS Autorização', valUrlBloco(h, 'autorizacao'))}
                    ${htmlCampoUrl('gef-h-ret', 'WS Retorno', valUrlBloco(h, 'retorno'))}
                    ${htmlCampoUrl('gef-h-st', 'WS Status', valUrlBloco(h, 'status'))}
                </div>
                <h5 class="h6 mt-4" data-gef-urls-bloco="producao">URLS PRODUÇÃO</h5>
                <p class="small text-muted">CONSULTAS</p>
                <div class="row g-2">
                    ${htmlCampoUrl('gef-p-qr', 'URL Consulta QRCode', valUrlBloco(p, 'consultaQr'))}
                    ${htmlCampoUrl('gef-p-chave', 'URL Consulta Chave', valUrlBloco(p, 'consultaChave'))}
                </div>
                <p class="small text-muted mt-3">SERVIÇOS SEFAZ</p>
                <div class="row g-2">
                    ${htmlCampoUrl('gef-p-aut', 'WS Autorização', valUrlBloco(p, 'autorizacao'))}
                    ${htmlCampoUrl('gef-p-ret', 'WS Retorno', valUrlBloco(p, 'retorno'))}
                    ${htmlCampoUrl('gef-p-st', 'WS Status', valUrlBloco(p, 'status'))}
                </div>
            </div>`;
    }

    function empresaNovaNaoMostraFiscal(html) {
        const h = String(html || '');
        return h.indexOf('data-gef-nova="1"') !== -1
            && h.indexOf('gef-n-razao') !== -1
            && h.indexOf('gef-ambiente') === -1
            && h.indexOf('gef-csc') === -1
            && h.indexOf('gef-pfx') === -1
            && h.indexOf('data-gef-tab="fiscal"') === -1;
    }

    function indicadorCscVisual(fiscal) {
        return fiscal && fiscal.csc_configurado ? 'CSC configurado' : 'CSC não configurado';
    }

    function indicadorCertificadoVisual(fiscal) {
        if (fiscal && fiscal.certificado_configurado) {
            return {
                marca: '●',
                texto: 'CERTIFICADO CONFIGURADO',
                nome: fiscal.certificado_nome || null
            };
        }
        return { marca: '○', texto: 'NÃO CONFIGURADO', nome: null };
    }

    function urlCertificadoUpload() {
        return '/api/fiscal/certificado/upload';
    }

    function chamadaSemApiDuplo(url) {
        return !/\/api\/api\//.test(String(url || ''));
    }

    function resolverEmpresaId(resposta) {
        if (resposta == null) return null;
        if (typeof resposta === 'number' || typeof resposta === 'string') {
            const direto = Number(resposta);
            return Number.isInteger(direto) && direto > 0 ? direto : null;
        }
        if (typeof resposta !== 'object') return null;
        const bruto = resposta.id != null
            ? resposta.id
            : (resposta.empresa_id != null
                ? resposta.empresa_id
                : (resposta.empresaId != null
                    ? resposta.empresaId
                    : (resposta.data && (resposta.data.id != null ? resposta.data.id : resposta.data.empresa_id))));
        const n = Number(bruto);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    function idEmpresaResposta(empresa) {
        return resolverEmpresaId(empresa);
    }

    function nuncaAssumeEmpresaUm(empresaId) {
        const n = Number(empresaId);
        return Number.isInteger(n) && n > 0;
    }

    function empresaIdDaEdicao(idTela, _idContextoOperacional) {
        const id = Number(idTela);
        if (!Number.isInteger(id) || id <= 0) return null;
        return id;
    }

    function fiscalVazio(empresaId) {
        return {
            empresa_id: empresaId != null ? Number(empresaId) : null,
            status: 'INCOMPLETA',
            csc_configurado: false,
            id_csc_configurado: false,
            certificado_configurado: false,
            certificado_nome: null,
            sefaz_configurado: false,
            ambiente: null,
            uf: null,
            serie: null,
            numero_atual: null,
            urls_homologacao: { autorizacao: '', retorno: '', status: '', consultaQr: '', consultaChave: '' },
            urls_producao: { autorizacao: '', retorno: '', status: '', consultaQr: '', consultaChave: '' }
        };
    }

    let _ui = {
        estado: ESTADOS.LOADING,
        lista: [],
        sessao: criarSessaoDetalhe(),
        saving: false,
        requestId: 0,
        aba: 'gerais',
        avisoStatusFiscal: ''
    };

    async function jsonFetch(url, opts) {
        const destino = urlAbsoluta(url);
        if (!chamadaSemApiDuplo(destino)) {
            const err = new Error('URL de API inválida.');
            err.code = 'URL_API_DUPLICADA';
            throw err;
        }
        const res = await fetch(destino, opts);
        logEmpresas('http', {
            endpoint: destino,
            metodo: (opts && opts.method) || 'GET',
            status: res.status,
            empresa_id: _ui.sessao && _ui.sessao.empresa_id
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            const err = new Error(data.error || data.message || 'Não foi possível carregar as informações.');
            err.code = data.code;
            err.status = res.status;
            throw err;
        }
        return data;
    }

    async function carregarLista() {
        _ui.estado = ESTADOS.LOADING;
        _ui.lista = [];
        pintarShell();
        try {
            const empresas = await jsonFetch('/empresas', { headers: authHeaders() });
            let status = [];
            try {
                status = await jsonFetch(urlStatusOficial(), { headers: authHeaders() });
                _ui.avisoStatusFiscal = '';
            } catch (_st) {
                status = [];
                _ui.avisoStatusFiscal = 'Não foi possível atualizar o status fiscal.';
            }
            _ui.lista = juntarEmpresasComStatus(empresas, status);
            _ui.estado = _ui.lista.length ? ESTADOS.READY : ESTADOS.EMPTY;
        } catch (err) {
            _ui.estado = ESTADOS.ERROR;
            _ui.erro = err.message;
        }
        pintarShell();
    }

    function pintarShell() {
        const root = document.getElementById('page-content');
        if (!root) return;
        if (_ui.estado === ESTADOS.LOADING) {
            root.innerHTML = '<div class="p-4" data-gef-estado="LOADING"><p>Carregando empresas...</p><div id="gef-detalhe"></div></div>';
            return;
        }
        if (_ui.estado === ESTADOS.ERROR) {
            root.innerHTML = `
                <div class="alert alert-danger" data-gef-estado="ERROR">
                    <p>Não foi possível carregar as informações.</p>
                    <p>${escapeHtml(_ui.erro || '')}</p>
                    <button type="button" class="btn btn-outline-danger" id="gef-retry">TENTAR NOVAMENTE</button>
                    <div id="gef-detalhe"></div>
                </div>`;
            const r = document.getElementById('gef-retry');
            if (r) r.addEventListener('click', carregarLista);
            return;
        }
        const busca = (document.getElementById('gef-busca') && document.getElementById('gef-busca').value) || '';
        const linhas = filtrarEmpresas(_ui.lista, busca);
        const empty = _ui.estado === ESTADOS.EMPTY || !linhas.length;
        root.innerHTML = `
            <div class="container-fluid py-3" data-gef-estado="${_ui.estado}">
                <nav aria-label="breadcrumb">
                    <ol class="breadcrumb">
                        <li class="breadcrumb-item"><a href="#" id="gef-voltar-cfg">Configurações Avançadas</a></li>
                        <li class="breadcrumb-item active">Empresas</li>
                    </ol>
                </nav>
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                        <h2 class="h4 mb-0">EMPRESAS</h2>
                        <p class="text-muted mb-0">Gerencie as empresas e configurações fiscais</p>
                    </div>
                    <button type="button" class="btn btn-primary" id="gef-nova">+ NOVA EMPRESA</button>
                </div>
                <p id="gef-feedback" class="small text-success"></p>
                <input id="gef-busca" class="form-control mb-3" placeholder="Buscar empresa" value="${escapeHtml(busca)}">
                ${empty
                    ? '<div class="alert alert-secondary" data-gef-estado="EMPTY">Nenhuma empresa cadastrada.</div>'
                    : `<div class="table-responsive"><table class="table table-hover align-middle">
                        <thead><tr>
                            <th>EMPRESA</th><th>FANTASIA</th><th>CNPJ</th>
                            <th>STATUS</th><th>STATUS FISCAL</th><th>AÇÕES</th>
                        </tr></thead>
                        <tbody>
                        ${linhas.map(function (e) {
                            return `<tr data-gef-empresa-lista="${e.id}">
                                <td>${escapeHtml(e.razao_social || '—')}</td>
                                <td>${escapeHtml(e.nome_fantasia || '—')}</td>
                                <td>${escapeHtml(formatarCnpj(e.cnpj))}</td>
                                <td>${Number(e.ativo) === 1 ? 'Ativa' : 'Inativa'}</td>
                                <td>Fiscal: ${badgeStatus(e.status_fiscal)}</td>
                                <td><button type="button" class="btn btn-sm btn-outline-primary" data-gef-abrir="${e.id}">Abrir / Editar</button></td>
                            </tr>`;
                        }).join('')}
                        </tbody></table></div>`}
                <div id="gef-detalhe"></div>
            </div>`;
        bindLista();
        if (_ui.sessao && _ui.sessao.empresa && nuncaAssumeEmpresaUm(_ui.sessao.empresa_id)) {
            pintarDetalhe();
        }
    }

    function bindLista() {
        const voltar = document.getElementById('gef-voltar-cfg');
        if (voltar) {
            voltar.addEventListener('click', function (ev) {
                ev.preventDefault();
                if (typeof globalThis.loadPage === 'function') globalThis.loadPage('configuracoes-avancadas');
            });
        }
        const busca = document.getElementById('gef-busca');
        if (busca) {
            busca.addEventListener('input', function () { pintarShell(); document.getElementById('gef-busca').focus(); });
        }
        document.querySelectorAll('[data-gef-abrir]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                abrirDetalhe(btn.getAttribute('data-gef-abrir'));
            });
        });
        const nova = document.getElementById('gef-nova');
        if (nova) nova.addEventListener('click', mostrarNovaEmpresa);
    }

    function mostrarNovaEmpresa() {
        _ui.sessao = criarSessaoDetalhe();
        const box = document.getElementById('gef-detalhe');
        if (!box) return;
        box.innerHTML = htmlFormNovaEmpresa();
        document.getElementById('gef-n-salvar').addEventListener('click', salvarNovaEmpresa);
    }

    async function salvarNovaEmpresa() {
        if (_ui.saving) return;
        _ui.saving = true;
        const btn = document.getElementById('gef-n-salvar');
        if (btn) btn.disabled = true;
        try {
            const criada = await jsonFetch('/empresas', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    razao_social: document.getElementById('gef-n-razao').value,
                    nome_fantasia: document.getElementById('gef-n-fantasia').value,
                    cnpj: document.getElementById('gef-n-cnpj').value,
                    inscricao_estadual: document.getElementById('gef-n-ie').value,
                    inscricao_municipal: document.getElementById('gef-n-im').value
                })
            });
            const novaId = resolverEmpresaId(criada);
            if (!novaId) {
                throw new Error('Empresa criada sem identificador oficial. Recarregue a lista e abra a empresa.');
            }
            feedback('Empresa cadastrada com sucesso.', 'success');
            try {
                await carregarLista();
            } catch (_e) { /* lista é secundária; a edição usa o id oficial */ }
            if (!_ui.lista.some(function (e) { return Number(e.id) === novaId; })) {
                _ui.lista = juntarEmpresasComStatus((_ui.lista || []).concat([criada]), []);
                _ui.estado = ESTADOS.READY;
                pintarShell();
            }
            _ui.aba = 'gerais';
            logEmpresas('empresa_criada', { empresa_id: novaId, loadPage: 'empresas' });
            await abrirDetalhe(novaId);
        } catch (err) {
            feedback(err.message, 'danger');
        } finally {
            _ui.saving = false;
            if (btn) btn.disabled = false;
        }
    }

    async function abrirDetalhe(empresaId) {
        _ui.sessao = abrirEmpresa(_ui.sessao, empresaId);
        const geracao = _ui.sessao.geracao;
        const box = document.getElementById('gef-detalhe');
        if (box) box.innerHTML = '<p data-gef-detalhe="LOADING">Carregando empresa...</p>';
        try {
            const empresa = await jsonFetch(`/empresas/${Number(empresaId)}`, { headers: authHeaders() });
            let fiscal = fiscalVazio(empresaId);
            try {
                fiscal = await jsonFetch(urlGetFiscal(empresaId), { headers: authHeaders() });
            } catch (_fe) {
                fiscal = fiscalVazio(empresaId);
            }
            if (geracao !== _ui.sessao.geracao) return;
            if (!empresaANaoCarregaB(_ui.sessao, empresaId)) return;
            _ui.sessao.empresa = empresa;
            _ui.sessao.fiscal = fiscal;
            pintarDetalhe();
            logEmpresas('edicao_renderizada', {
                empresa_id: Number(empresaId),
                abas: ['DADOS GERAIS', 'CONFIGURAÇÃO FISCAL', 'CERTIFICADO DIGITAL']
            });
        } catch (err) {
            if (geracao !== _ui.sessao.geracao) return;
            if (box) {
                box.innerHTML = `<div class="alert alert-danger">Não foi possível carregar as informações.
                    <button type="button" class="btn btn-sm btn-outline-danger" id="gef-det-retry">TENTAR NOVAMENTE</button></div>`;
                const r = document.getElementById('gef-det-retry');
                if (r) r.addEventListener('click', function () { abrirDetalhe(empresaId); });
            }
        }
    }

    function aplicarAba(box, tab) {
        _ui.aba = tab || 'gerais';
        box.querySelectorAll('[data-gef-tab]').forEach(function (x) {
            x.classList.toggle('active', x.getAttribute('data-gef-tab') === _ui.aba);
        });
        box.querySelectorAll('[data-gef-pane]').forEach(function (p) {
            p.hidden = p.getAttribute('data-gef-pane') !== _ui.aba;
        });
    }

    function htmlPainelEdicao(empresa, fiscal, avisoStatus) {
        const e = empresa || {};
        const f = fiscal || {};
        const cscTxt = indicadorCscVisual(f);
        const cert = indicadorCertificadoVisual(f);
        const ambProd = Number(f.ambiente) === 1 ? 'selected' : '';
        const ambHom = Number(f.ambiente) === 2 ? 'selected' : '';
        const aviso = avisoStatus
            ? `<div class="alert alert-warning" data-gef-aviso-status>
                        <p>${escapeHtml(avisoStatus)}</p>
                        <button type="button" class="btn btn-sm btn-outline-warning" id="gef-retry-status">TENTAR NOVAMENTE</button>
                    </div>`
            : '';
        return `
            <div class="card mt-3" data-gef-empresa="${e.id}" data-gef-edicao="1">
                <div class="card-header">
                    <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
                        <div>
                            <div class="text-muted small">EMPRESA</div>
                            <strong data-gef-topo-nome>${escapeHtml(e.razao_social || e.nome_fantasia || '')}</strong>
                            <div data-gef-topo-cnpj>CNPJ: ${escapeHtml(formatarCnpj(e.cnpj))}</div>
                            <div class="mt-1">STATUS FISCAL: ${badgeStatus(f.status)}</div>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="btn-group mb-3" role="group">
                        <button type="button" class="btn btn-outline-primary" data-gef-tab="gerais">DADOS GERAIS</button>
                        <button type="button" class="btn btn-outline-primary" data-gef-tab="fiscal">CONFIGURAÇÃO FISCAL</button>
                        <button type="button" class="btn btn-outline-primary" data-gef-tab="cert">CERTIFICADO DIGITAL</button>
                    </div>
                    ${aviso}
                    <div data-gef-pane="gerais">
                        <h4 class="h6">DADOS GERAIS</h4>
                        <div class="row g-2">
                            <div class="col-md-6"><label class="form-label">Razão social</label><input id="gef-razao" class="form-control" value="${escapeHtml(e.razao_social || '')}"></div>
                            <div class="col-md-6"><label class="form-label">Nome fantasia</label><input id="gef-fantasia" class="form-control" value="${escapeHtml(e.nome_fantasia || '')}"></div>
                            <div class="col-md-4"><label class="form-label">CNPJ</label><input id="gef-cnpj" class="form-control" value="${escapeHtml(e.cnpj || '')}"></div>
                            <div class="col-md-4"><label class="form-label">Inscrição Estadual</label><input id="gef-ie" class="form-control" value="${escapeHtml(e.inscricao_estadual || '')}"></div>
                            <div class="col-md-4"><label class="form-label">Inscrição Municipal</label><input id="gef-im" class="form-control" value="${escapeHtml(e.inscricao_municipal || '')}"></div>
                        </div>
                        <button type="button" class="btn btn-primary mt-3" id="gef-salvar-gerais">Salvar dados gerais</button>
                    </div>
                    <div data-gef-pane="fiscal" hidden>
                        <h4 class="h6">CONFIGURAÇÃO FISCAL</h4>
                        <p>Status oficial: ${badgeStatus(f.status)}</p>
                        <h5 class="h6 mt-3">IDENTIFICAÇÃO FISCAL</h5>
                        <div class="row g-2">
                            <div class="col-md-4"><label class="form-label">Ambiente</label>
                                <select id="gef-ambiente" class="form-select">
                                    <option value="">—</option>
                                    <option value="2" ${ambHom}>HOMOLOGAÇÃO</option>
                                    <option value="1" ${ambProd}>PRODUÇÃO</option>
                                </select>
                            </div>
                            <div class="col-md-2"><label class="form-label">UF</label><input id="gef-uf" class="form-control" maxlength="2" value="${escapeHtml(f.uf || '')}"></div>
                        </div>
                        <h5 class="h6 mt-3">NFC-e</h5>
                        <div class="row g-2">
                            <div class="col-md-3"><label class="form-label">Série</label><input id="gef-serie" class="form-control" value="${f.serie != null ? escapeHtml(String(f.serie)) : ''}"></div>
                            <div class="col-md-3"><label class="form-label">Próximo número</label><input id="gef-numero" class="form-control" value="${f.numero_atual != null ? escapeHtml(String(f.numero_atual)) : ''}"></div>
                        </div>
                        <h5 class="h6 mt-3">CÓDIGO DE SEGURANÇA DO CONTRIBUINTE</h5>
                        <p class="small" data-gef-csc-status>${escapeHtml(cscTxt)}</p>
                        <div class="row g-2">
                            <div class="col-md-6"><label class="form-label" data-gef-label-id-csc>ID CSC</label>
                                <input id="gef-id-csc" class="form-control" type="password" autocomplete="new-password" placeholder="${f.id_csc_configurado ? 'CONFIGURADO — informe para substituir' : ''}"></div>
                            <div class="col-md-6"><label class="form-label" data-gef-label-csc>CSC / TOKEN CSC</label>
                                <input id="gef-csc" class="form-control" type="password" autocomplete="new-password" placeholder="${f.csc_configurado ? 'CONFIGURADO — informe para substituir' : ''}"></div>
                        </div>
                        ${htmlBlocosUrlsFiscais(f)}
                        <button type="button" class="btn btn-primary mt-3" id="gef-salvar-fiscal">SALVAR CONFIGURAÇÃO FISCAL</button>
                    </div>
                    <div data-gef-pane="cert" hidden>
                        <h4 class="h6">CERTIFICADO DIGITAL DA EMPRESA</h4>
                        <p data-gef-cert-status>${cert.marca} ${escapeHtml(cert.texto)}</p>
                        <p data-gef-cert-nome>Arquivo: ${escapeHtml(cert.nome || '—')}</p>
                        <label class="form-label">ESCOLHER ARQUIVO</label>
                        <input type="file" id="gef-pfx" accept=".pfx" class="form-control mb-2">
                        <label class="form-label">Senha do certificado</label>
                        <input type="password" id="gef-pfx-senha" class="form-control" autocomplete="new-password">
                        <button type="button" class="btn btn-outline-primary mt-3" id="gef-upload-cert">ENVIAR CERTIFICADO</button>
                    </div>
                </div>
            </div>`;
    }

    function pintarDetalhe() {
        const e = _ui.sessao.empresa || {};
        const f = _ui.sessao.fiscal || {};
        const box = document.getElementById('gef-detalhe');
        if (!box) return;
        box.innerHTML = htmlPainelEdicao(e, f, _ui.avisoStatusFiscal);
        aplicarAba(box, _ui.aba || 'gerais');
        box.querySelectorAll('[data-gef-tab]').forEach(function (t) {
            t.addEventListener('click', function () {
                aplicarAba(box, t.getAttribute('data-gef-tab'));
            });
        });
        document.getElementById('gef-salvar-gerais').addEventListener('click', salvarGerais);
        document.getElementById('gef-salvar-fiscal').addEventListener('click', salvarFiscal);
        document.getElementById('gef-upload-cert').addEventListener('click', enviarCertificado);
        const retrySt = document.getElementById('gef-retry-status');
        if (retrySt) retrySt.addEventListener('click', carregarLista);
    }

    async function salvarGerais() {
        if (_ui.saving) return;
        const id = _ui.sessao.empresa_id;
        _ui.saving = true;
        const btn = document.getElementById('gef-salvar-gerais');
        if (btn) btn.disabled = true;
        try {
            await jsonFetch(`/empresas/${id}`, {
                method: 'PUT',
                headers: authHeaders({ 'X-Empresa-Id': String(id) }),
                body: JSON.stringify({
                    razao_social: document.getElementById('gef-razao').value,
                    nome_fantasia: document.getElementById('gef-fantasia').value,
                    cnpj: document.getElementById('gef-cnpj').value,
                    inscricao_estadual: document.getElementById('gef-ie').value,
                    inscricao_municipal: document.getElementById('gef-im').value
                })
            });
            feedback('Configuração salva com sucesso.', 'success');
            _ui.aba = 'gerais';
            await carregarLista();
            await abrirDetalhe(id);
        } catch (err) {
            feedback(err.message, 'danger');
        } finally {
            _ui.saving = false;
            if (btn) btn.disabled = false;
        }
    }

    async function salvarFiscal() {
        if (_ui.saving) return;
        const id = _ui.sessao.empresa_id;
        _ui.saving = true;
        const btn = document.getElementById('gef-salvar-fiscal');
        if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
        try {
            function valorCampo(idEl) {
                const el = document.getElementById(idEl);
                return el ? el.value : '';
            }
            const bruto = montarPayloadFiscal({
                ambiente: valorCampo('gef-ambiente'),
                uf: valorCampo('gef-uf'),
                serie: valorCampo('gef-serie'),
                numero_atual: valorCampo('gef-numero'),
                id_csc: valorCampo('gef-id-csc'),
                token_csc: valorCampo('gef-csc'),
                csc_qrcode_url_homologacao: valorCampo('gef-h-qr'),
                consulta_chave_url_homologacao: valorCampo('gef-h-chave'),
                ws_autorizacao_homologacao: valorCampo('gef-h-aut'),
                ws_retorno_homologacao: valorCampo('gef-h-ret'),
                ws_status_homologacao: valorCampo('gef-h-st'),
                csc_qrcode_url_producao: valorCampo('gef-p-qr'),
                consulta_chave_url_producao: valorCampo('gef-p-chave'),
                ws_autorizacao_producao: valorCampo('gef-p-aut'),
                ws_retorno_producao: valorCampo('gef-p-ret'),
                ws_status_producao: valorCampo('gef-p-st')
            }, id);
            const envio = payloadNaoSubstituiUrl(id, bruto);
            await jsonFetch(urlPutFiscal(envio.urlEmpresaId), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(envio.payload)
            });
            feedback('CONFIGURAÇÃO FISCAL SALVA', 'success');
            _ui.estado = ESTADOS.SUCCESS;
            _ui.aba = 'fiscal';
            await carregarLista();
            await abrirDetalhe(id);
        } catch (err) {
            feedback(err.message, 'danger');
        } finally {
            _ui.saving = false;
            if (btn) { btn.disabled = false; btn.textContent = 'SALVAR CONFIGURAÇÃO FISCAL'; }
        }
    }

    async function enviarCertificado() {
        if (_ui.saving) return;
        const id = empresaIdDaEdicao(_ui.sessao.empresa_id, null);
        const input = document.getElementById('gef-pfx');
        const senha = document.getElementById('gef-pfx-senha');
        if (!id) {
            feedback('empresa_id oficial é obrigatório para enviar o certificado.', 'danger');
            return;
        }
        if (!input || !input.files || !input.files.length) {
            feedback('Selecione um arquivo .pfx.', 'warning');
            return;
        }
        _ui.saving = true;
        const btn = document.getElementById('gef-upload-cert');
        if (btn) btn.disabled = true;
        try {
            const fd = new FormData();
            fd.append('certificado', input.files[0]);
            fd.append('empresa_id', String(id));
            if (senha && senha.value) fd.append('certificado_senha', senha.value);
            const headers = {};
            try {
                const token = localStorage.getItem('token');
                if (token) headers.Authorization = `Bearer ${token}`;
            } catch (_e) { /* ignore */ }
            const destCert = urlAbsoluta(urlCertificadoUpload());
            if (!chamadaSemApiDuplo(destCert)) throw new Error('URL de API inválida.');
            const res = await fetch(destCert, {
                method: 'POST',
                headers: headers,
                body: fd
            });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Falha no certificado.');
            if (senha) senha.value = '';
            if (input) input.value = '';
            feedback('CERTIFICADO DIGITAL CONFIGURADO COM SUCESSO', 'success');
            _ui.aba = 'cert';
            await carregarLista();
            await abrirDetalhe(id);
        } catch (err) {
            feedback(err.message, 'danger');
        } finally {
            _ui.saving = false;
            if (btn) btn.disabled = false;
        }
    }

    function loadGestaoEmpresasFiscal() {
        try {
            globalThis.__CDS_EMPRESAS_MODULE_VERSION = '05.18';
        } catch (_e) { /* ignore */ }
        logEmpresas('módulo carregado', { loadPage: 'empresas' });
        _ui = { estado: ESTADOS.LOADING, lista: [], sessao: criarSessaoDetalhe(), saving: false, requestId: 0, aba: 'gerais', avisoStatusFiscal: '' };
        carregarLista();
    }

    return {
        ESTADOS,
        STATUS_VISUAL,
        CAMPOS_SEGREDO,
        formatarCnpj,
        rotuloStatusOficial,
        juntarEmpresasComStatus,
        filtrarEmpresas,
        criarSessaoDetalhe,
        abrirEmpresa,
        empresaANaoCarregaB,
        urlGetFiscal,
        urlPutFiscal,
        urlStatusOficial,
        urlAbsoluta,
        normalizarApiUrl,
        versaoModuloEmpresas,
        recursoSemPrefixoApi,
        resolverEmpresaId,
        urlCertificadoUpload,
        idEmpresaResposta,
        fiscalVazio,
        htmlFormNovaEmpresa,
        htmlPainelEdicao,
        htmlBlocosUrlsFiscais,
        empresaNovaNaoMostraFiscal,
        indicadorCscVisual,
        indicadorCertificadoVisual,
        chamadaSemApiDuplo,
        nuncaAssumeEmpresaUm,
        empresaIdDaEdicao,
        montarPayloadFiscal,
        payloadNaoSubstituiUrl,
        dtoNaoExpoeSegredos,
        certificadoIsolado,
        loadGestaoEmpresasFiscal
    };
});
