/**
 * Sprint 04.13 — ComprovanteAtendimentoModal.
 * Consome DTO/HTML oficiais. Não monta itens, totais ou NFC-e.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ComprovanteAtendimentoModal = api;
        root.abrirComprovanteAtendimento = api.abrir;
        root.notificarAtendimentoMuvSePresente = api.notificarSePresente;
        root.disponibilizarComprovanteAtendimentoMuv = api.notificarSePresente;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const MODAL_ID = 'muv-comprovante-atendimento-modal';
    const BARRA_ID = 'muv-comprovante-acao-barra';

    function client() {
        return (root && root.MuvComprovanteClient) || (typeof require === 'function'
            ? require('./muv-comprovante-client.js')
            : null);
    }

    function aplicarPreviewHtml(htmlOficial) {
        const body = typeof document !== 'undefined' ? document.getElementById('muv-comp-body') : null;
        if (!body) return;
        body.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'muv-comp-iframe';
        iframe.title = 'Preview oficial do comprovante';
        iframe.srcdoc = String(htmlOficial == null ? '' : htmlOficial);
        body.appendChild(iframe);
    }

    function garantirBarra() {
        if (typeof document === 'undefined') return null;
        let el = document.getElementById(BARRA_ID);
        if (el) return el;
        el = document.createElement('div');
        el.id = BARRA_ID;
        el.className = 'muv-comp-barra';
        el.hidden = true;
        el.innerHTML = '<button type="button" class="muv-comp-barra-btn" data-muv-acao="abrir">VER COMPROVANTE</button>';
        document.body.appendChild(el);
        el.querySelector('[data-muv-acao="abrir"]').addEventListener('click', function () {
            const id = el.getAttribute('data-atendimento-id');
            abrir(id);
        });
        return el;
    }

    function mostrarBarra(atendimentoId) {
        const el = garantirBarra();
        if (!el) return;
        el.setAttribute('data-atendimento-id', String(atendimentoId));
        el.hidden = false;
    }

    function garantirModal() {
        if (typeof document === 'undefined') return null;
        let el = document.getElementById(MODAL_ID);
        if (el) return el;
        el = document.createElement('div');
        el.id = MODAL_ID;
        el.className = 'muv-comp-overlay';
        el.hidden = true;
        el.innerHTML = [
            '<div class="muv-comp-dialog" role="dialog" aria-modal="true" aria-labelledby="muv-comp-titulo">',
            '  <header class="muv-comp-header">',
            '    <h2 id="muv-comp-titulo">Comprovante do atendimento</h2>',
            '    <button type="button" class="muv-comp-x" data-muv-acao="fechar" aria-label="Fechar">×</button>',
            '  </header>',
            '  <div class="muv-comp-banner" id="muv-comp-banner" hidden></div>',
            '  <div class="muv-comp-body" id="muv-comp-body"></div>',
            '  <footer class="muv-comp-acoes">',
            '    <button type="button" data-muv-acao="fechar">FECHAR</button>',
            '    <button type="button" data-muv-acao="preview">PREVIEW</button>',
            '    <button type="button" data-muv-acao="imprimir">PREPARAR IMPRESSÃO</button>',
            '  </footer>',
            '</div>'
        ].join('');
        document.body.appendChild(el);
        el.addEventListener('click', function (ev) {
            if (ev.target === el) fechar();
        });
        el.querySelectorAll('[data-muv-acao="fechar"]').forEach(function (btn) {
            btn.addEventListener('click', fechar);
        });
        el.querySelector('[data-muv-acao="preview"]').addEventListener('click', function () {
            const id = el.getAttribute('data-atendimento-id');
            carregar(id, { recarregar: true });
        });
        el.querySelector('[data-muv-acao="imprimir"]').addEventListener('click', function () {
            const id = el.getAttribute('data-atendimento-id');
            prepararImpressao(id);
        });
        return el;
    }

    function setBanner(estado, extra) {
        const el = typeof document !== 'undefined' ? document.getElementById('muv-comp-banner') : null;
        if (!el) return;
        const c = client();
        const msg = (c && c.mensagensEstado(estado)) || '';
        if (!msg && !extra) {
            el.hidden = true;
            el.textContent = '';
            el.className = 'muv-comp-banner';
            return;
        }
        el.hidden = false;
        el.className = `muv-comp-banner muv-comp-banner--${String(estado).toLowerCase()}`;
        el.textContent = extra ? `${msg} ${extra}`.trim() : msg;
    }

    function setBodyHtml(html) {
        const body = typeof document !== 'undefined' ? document.getElementById('muv-comp-body') : null;
        if (!body) return;
        body.innerHTML = html;
    }

    function iframePreview(htmlOficial) {
        return { tipo: 'html_oficial', conteudo: String(htmlOficial == null ? '' : htmlOficial) };
    }

    async function carregar(atendimentoId, opcoes) {
        const c = client();
        const id = c.extrairAtendimentoId(atendimentoId);
        const modal = garantirModal();
        if (!id || !modal) return;
        modal.setAttribute('data-atendimento-id', String(id));
        setBanner('CARREGANDO');
        setBodyHtml('<p class="muv-comp-loading">Carregando comprovante oficial…</p>');
        try {
            const dto = await c.obterComprovanteJson(id);
            const estado = c.classificarEstadoVisual(dto, false);
            setBanner(estado);
            const html = await c.obterComprovanteHtml(id);
            const textoHtml = typeof html === 'string' ? html : (html && html.conteudo) || '';
            aplicarPreviewHtml(textoHtml);
            modal.setAttribute('data-estado', estado);
        } catch (err) {
            const estado = 'ERRO_CARREGAMENTO';
            setBanner(estado, err && err.message ? String(err.message) : '');
            setBodyHtml('<p class="muv-comp-erro">Erro ao carregar o comprovante oficial.</p>');
            modal.setAttribute('data-estado', estado);
            if (opcoes && opcoes.throwOnError) throw err;
        }
    }

    async function prepararImpressao(atendimentoId) {
        const c = client();
        const id = c.extrairAtendimentoId(atendimentoId);
        if (!id) return;
        setBanner('CARREGANDO');
        try {
            const prep = await c.prepararImpressaoBrowser(id);
            const html = (prep && prep.conteudo) || '';
            aplicarPreviewHtml(html);
            const body = typeof document !== 'undefined' ? document.getElementById('muv-comp-body') : null;
            if (body) {
                const p = document.createElement('p');
                p.className = 'muv-comp-prep';
                p.textContent = 'Impressão BROWSER preparada pelo servidor. Nenhuma impressão automática foi disparada.';
                body.appendChild(p);
            }
            const estado = c.classificarEstadoVisual(
                { atendimento: { status: 'CONCLUIDO' }, fiscal: { status: 'PENDENTE' }, documentos_fiscais: [{}] },
                false
            );
            setBanner(estado, 'Preparação BROWSER concluída.');
            const modal = garantirModal();
            if (modal) modal.setAttribute('data-impressao-preparada', '1');
        } catch (err) {
            setBanner('ERRO_CARREGAMENTO', err && err.message ? String(err.message) : '');
        }
    }

    function abrir(atendimentoId) {
        const c = client();
        const id = c.extrairAtendimentoId(atendimentoId);
        if (!id) return false;
        if (root) root.ultimoAtendimentoIdMuv = id;
        const modal = garantirModal();
        if (!modal) return false;
        modal.hidden = false;
        carregar(id);
        return true;
    }

    function fechar() {
        const modal = typeof document !== 'undefined' ? document.getElementById(MODAL_ID) : null;
        if (modal) modal.hidden = true;
    }

    function notificarSePresente(resposta) {
        const c = client();
        const id = c.extrairAtendimentoId(resposta);
        if (!id) return false;
        if (root) root.ultimoAtendimentoIdMuv = id;
        mostrarBarra(id);
        return true;
    }

    return {
        abrir,
        fechar,
        carregar,
        prepararImpressao,
        notificarSePresente,
        iframePreview,
        MODAL_ID,
        BARRA_ID
    };
});
