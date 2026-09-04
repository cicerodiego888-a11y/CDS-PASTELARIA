/**
 * RC4.31.12 — Cliente HTTP para simulação MUC na compra manual.
 * Toda conversão de quantidade/custo passa pelo Motor Universal de Comercialização.
 */
(function (global) {
    'use strict';

    async function simularConversao(payload = {}) {
        const resp = await fetch(`${API_URL}/compras/simular-conversao-muc`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('token') || ''}`
            },
            body: JSON.stringify(payload)
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const err = new Error(json.mensagem || json.error || 'Falha na simulação MUC');
            err.codigo = json.codigo || 'CONVERSAO_INVALIDA';
            throw err;
        }
        return json.resultado || null;
    }

    global.CompraMucClient = Object.freeze({ simularConversao });
}(typeof window !== 'undefined' ? window : global));
