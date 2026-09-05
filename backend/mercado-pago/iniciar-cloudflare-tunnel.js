/**
 * Recusa iniciar Tunnel sem configuração real.
 * Nunca executa Quick Tunnel.
 */
'use strict';

const { avaliarProntidaoTunnel, MSG_TUNNEL_NAO_ATIVADO } = require('./cloudflareTunnel');

const prontidao = avaliarProntidaoTunnel(process.env);
if (!prontidao.configurado) {
  console.error(MSG_TUNNEL_NAO_ATIVADO);
  process.exit(1);
}

console.error('Tunnel nomeado configurado no ambiente, mas esta sprint não inicia cloudflared automaticamente.');
process.exit(1);
