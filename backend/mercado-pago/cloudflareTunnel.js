/**
 * Prontidão do Cloudflare Tunnel nomeado.
 * Sem hostname, ID ou credencial inventados. Sem Quick Tunnel.
 * @module mercado-pago/cloudflareTunnel
 */
'use strict';

const DESTINO_LOCAL = 'http://127.0.0.1:3010';
const ROTA_CALLBACK = '/api/bancario/mercado-pago/oauth/callback';
const MSG_AGUARDANDO = 'PREPARADA, AGUARDANDO CONFIGURAÇÃO REAL DO CLOUDFLARE.';
const MSG_TUNNEL_NAO_ATIVADO = 'TUNNEL DE PRODUÇÃO AINDA NÃO ATIVADO POR AUSÊNCIA DE DOMÍNIO/CREDENCIAIS/CONFIGURAÇÃO REAL.';

function ler(env, chave) {
  const v = env[chave];
  if (v == null || !String(v).trim()) return null;
  return String(v).trim();
}

function hostnameValido(hostname) {
  if (!hostname) return false;
  if (/localhost/i.test(hostname)) return false;
  if (/trycloudflare\.com/i.test(hostname)) return false;
  if (/^https?:\/\//i.test(hostname)) return false;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(hostname);
}

function avaliarProntidaoTunnel(env = process.env) {
  const tunnelId = ler(env, 'CLOUDFLARE_TUNNEL_ID');
  const hostname = ler(env, 'CLOUDFLARE_TUNNEL_HOSTNAME');
  const credentialsFile = ler(env, 'CLOUDFLARE_CREDENTIALS_FILE');
  const motivos = [];
  if (!tunnelId) motivos.push('TUNNEL_ID_AUSENTE');
  if (!hostname) motivos.push('HOSTNAME_AUSENTE');
  else if (!hostnameValido(hostname)) motivos.push('HOSTNAME_INVALIDO');
  if (!credentialsFile) motivos.push('CREDENTIALS_FILE_AUSENTE');
  if (hostname && /trycloudflare\.com/i.test(hostname)) motivos.push('QUICK_TUNNEL_PROIBIDO');

  const configurado = motivos.length === 0;
  return {
    status: configurado ? 'CONFIGURADO' : 'NAO_CONFIGURADO',
    configurado,
    producao_ativada: false,
    decisao: 'NO-GO',
    mensagem: configurado ? MSG_AGUARDANDO : MSG_TUNNEL_NAO_ATIVADO,
    destino_local: DESTINO_LOCAL,
    origem_erp_proibida: 'http://127.0.0.1:3001',
    tunnel_id: tunnelId ? 'CONFIGURADO' : 'NAO_CONFIGURADO',
    hostname: hostname && hostnameValido(hostname) ? 'CONFIGURADO' : 'NAO_CONFIGURADO',
    credentials_file: credentialsFile ? 'CONFIGURADO' : 'NAO_CONFIGURADO',
    https_obrigatorio: true,
    quick_tunnel: false,
    motivos
  };
}

function montarIngressTunnel(env = process.env) {
  const prontidao = avaliarProntidaoTunnel(env);
  if (!prontidao.configurado) return null;
  const hostname = ler(env, 'CLOUDFLARE_TUNNEL_HOSTNAME');
  return [
    { hostname, service: DESTINO_LOCAL },
    { service: 'http_status:404' }
  ];
}

function montarYamlTunnel(env = process.env) {
  const prontidao = avaliarProntidaoTunnel(env);
  if (!prontidao.configurado) return null;
  const ingress = montarIngressTunnel(env);
  const lines = [
    'tunnel: ' + ler(env, 'CLOUDFLARE_TUNNEL_ID'),
    'credentials-file: ' + ler(env, 'CLOUDFLARE_CREDENTIALS_FILE'),
    'ingress:'
  ];
  ingress.forEach((item) => {
    if (item.hostname) {
      lines.push('  - hostname: ' + item.hostname);
      lines.push('    service: ' + item.service);
    } else {
      lines.push('  - service: ' + item.service);
    }
  });
  return lines.join('\n') + '\n';
}

function redirectUriProducaoConceitual(env = process.env) {
  const hostname = ler(env, 'CLOUDFLARE_TUNNEL_HOSTNAME');
  if (!hostname || !hostnameValido(hostname)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  return {
    status: 'PRONTO_PARA_CONFIGURAR',
    uri: 'https://' + hostname + ROTA_CALLBACK
  };
}

function yamlContemProibicoes(yaml) {
  if (!yaml) return false;
  return /127\.0\.0\.1:3001|localhost:3001|trycloudflare|0\.0\.0\.0:3010/.test(yaml);
}

module.exports = {
  DESTINO_LOCAL,
  ROTA_CALLBACK,
  MSG_AGUARDANDO,
  MSG_TUNNEL_NAO_ATIVADO,
  avaliarProntidaoTunnel,
  montarIngressTunnel,
  montarYamlTunnel,
  redirectUriProducaoConceitual,
  hostnameValido,
  yamlContemProibicoes
};
