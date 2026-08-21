(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.CentralEntradasReviewUx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function podeMostrarBotaoImportarCompraCentral(status, parseDisponivel) {
    const statusNormalizado = String(status || '').trim();
    const parseOk = parseDisponivel === true || parseDisponivel === 1 || parseDisponivel === '1';
    return parseOk && ['PRONTA_IMPORTACAO', 'EM_IMPORTACAO', 'PRONTA_PARA_COMPRA', 'EM_COMPRA', 'REVISADA'].includes(statusNormalizado);
  }

  function montarRetornoCentralDepoisDaRevisao(documentoId, doc) {
    return {
      documentoId: Number(documentoId) || null,
      aba: 'resumo',
      focarImportarCompra: podeMostrarBotaoImportarCompraCentral(doc?.status, doc?.parseDisponivel),
      seletorImportarCompra: '#centralBtnAbrirCompra',
      status: String(doc?.status || '')
    };
  }

  function prepararFocoImportarCompraCentral({ documentoId, seletor = '#centralBtnAbrirCompra', timeoutMs = 250 } = {}) {
    return new Promise((resolve) => {
      const focar = () => {
        const btn = document.getElementById('centralBtnAbrirCompra');
        if (!btn) {
          resolve(false);
          return;
        }
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        btn.focus();
        btn.classList.add('btn-outline-light');
        resolve(true);
      };

      setTimeout(() => {
        requestAnimationFrame(() => focar());
      }, timeoutMs);
    });
  }

  return {
    podeMostrarBotaoImportarCompraCentral,
    montarRetornoCentralDepoisDaRevisao,
    prepararFocoImportarCompraCentral
  };
});
