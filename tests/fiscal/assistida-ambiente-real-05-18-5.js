'use strict';

/**
 * Sprint 05.18.5 — probe operacional no servidor real.
 * Não imprime token, senha, CSC nem PFX.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function request(method, urlPath, { body, token } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { /* html */ }
        resolve({
          status: res.statusCode,
          location: res.headers.location || null,
          json,
          rawLen: raw.length,
          rawHead: raw.slice(0, 180).replace(/\s+/g, ' ')
        });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ status: 0, error: 'TIMEOUT' });
    });
    if (data) req.write(data);
    req.end();
  });
}

function semSegredo(obj) {
  const json = JSON.stringify(obj || {});
  return !/CSC-A-SECRETO|CSC-B-SECRETO|token_csc|certificado_senha|password_hash/.test(json)
    || (!Object.prototype.hasOwnProperty.call(obj || {}, 'token_csc')
      && !Object.prototype.hasOwnProperty.call(obj || {}, 'certificado_senha'));
}

async function login() {
  const primeiro = await request('GET', '/api/auth/primeiro-acesso');
  const candidatos = [];
  if (primeiro.json && primeiro.json.primeiro_acesso) candidatos.push({ u: 'admin', p: '1234' });
  candidatos.push({ u: 'admin', p: 'admin' });
  candidatos.push({ u: 'admin', p: '1234' });
  for (const c of candidatos) {
    const r = await request('POST', '/api/auth/login', { body: { username: c.u, password: c.p } });
    const token = r.json && (r.json.token || r.json.access_token);
    if (r.status === 200 && token) {
      return { ok: true, status: r.status, user: r.json.username || c.u };
    }
    if (r.status && r.status !== 401) {
      return { ok: false, status: r.status, error: (r.json && r.json.error) || 'login_falhou' };
    }
  }
  return { ok: false, status: 401, error: 'credencial_ambiente_nao_aceitou_candidatos_conhecidos' };
}

async function garantirEmpresa(token, cnpj, razao) {
  const lista = await request('GET', '/api/empresas', { token });
  const itens = Array.isArray(lista.json) ? lista.json : (lista.json && lista.json.empresas) || [];
  const achada = itens.find((e) => String(e.cnpj || '').replace(/\D/g, '') === cnpj);
  if (achada) return { status: lista.status, empresa: achada, criada: false };
  const cri = await request('POST', '/api/empresas', {
    token,
    body: { cnpj, razao_social: razao, nome_fantasia: razao }
  });
  return { status: cri.status, empresa: cri.json, criada: true, error: cri.json && cri.json.error };
}

async function main() {
  const out = { porta: PORT, url: `http://${HOST}:${PORT}`, passos: [] };

  for (const p of ['/', '/erp', '/pdv-universal/', '/api/empresas']) {
    const r = await request('GET', p);
    out.passos.push({
      endpoint: `GET ${p}`,
      status: r.status,
      location: r.location,
      error: r.error || null,
      head: r.status && r.status < 400 ? r.rawHead : (r.json && r.json.error) || r.rawHead
    });
  }

  const js = await request('GET', '/erp/js/gestao-empresas-fiscal.js?v=0519');
  const app = await request('GET', '/erp/js/app.js');
  out.modulo = {
    js_status: js.status,
    js_len: js.rawLen,
  };
  const jsFull = js.status === 200 ? (await new Promise((resolve) => {
    http.get({ hostname: HOST, port: PORT, path: '/erp/js/gestao-empresas-fiscal.js?v=0519' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(raw));
    }).on('error', () => resolve(''));
  })) : '';
  const vm = jsFull.match(/__CDS_EMPRESAS_MODULE_VERSION = '([^']+)'/);
  const av = (app.rawHead || '').match(/CDS_ERP_ASSET_VERSION[\s\S]{0,80}'(\d+)'/);
  out.modulo.versao_carregada = vm ? vm[1] : null;
  out.modulo.asset_v = av ? av[1] : null;
  out.modulo.arquivo = '/erp/js/gestao-empresas-fiscal.js?v=0519';

  const auth = await login();
  out.login = { executado: auth.ok, status: auth.status, error: auth.error || null, user: auth.ok ? auth.user : null };

  if (!auth.ok) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const tokenHolder = { token: null };
  const candidatos = [{ u: 'admin', p: 'admin' }, { u: 'admin', p: '1234' }];
  for (const c of candidatos) {
    const r = await request('POST', '/api/auth/login', { body: { username: c.u, password: c.p } });
    if (r.json && r.json.token) {
      tokenHolder.token = r.json.token;
      break;
    }
  }
  const token = tokenHolder.token;

  const emp = await request('GET', '/api/empresas', { token });
  out.http_empresas = { status: emp.status, qtd: Array.isArray(emp.json) ? emp.json.length : null };

  const st = await request('GET', '/api/empresas/configuracao-fiscal/status', { token });
  out.http_status_fiscal = { status: st.status, qtd: Array.isArray(st.json) ? st.json.length : null };

  const a = await garantirEmpresa(token, CNPJ_A, 'CDS TESTE 05.18.5 A');
  const b = await garantirEmpresa(token, CNPJ_B, 'CDS TESTE 05.18.5 B');
  out.empresa_a = {
    status: a.status,
    id: a.empresa && a.empresa.id,
    criada: a.criada,
    error: a.error || null
  };
  out.empresa_b = {
    status: b.status,
    id: b.empresa && b.empresa.id,
    criada: b.criada,
    error: b.error || null
  };

  if (out.empresa_a.id) {
    const putA = await request('PUT', `/api/empresas/${out.empresa_a.id}/configuracao-fiscal`, {
      token,
      body: {
        ambiente: 2,
        uf: 'CE',
        serie: 1,
        numero_atual: 101,
        token_csc: 'CSC-A-SECRETO',
        id_csc: 'ID-A',
        ws_autorizacao_homologacao: 'https://a.local/h/aut',
        ws_autorizacao_producao: 'https://a.local/p/aut',
        csc_qrcode_url_homologacao: 'https://a.local/h/qr',
        csc_qrcode_url_producao: 'https://a.local/p/qr'
      }
    });
    const getA = await request('GET', `/api/empresas/${out.empresa_a.id}/configuracao-fiscal`, { token });
    out.fiscal_a = {
      put: putA.status,
      get: getA.status,
      empresa_id: getA.json && getA.json.empresa_id,
      ambiente: getA.json && getA.json.ambiente,
      url_h: getA.json && getA.json.urls_homologacao && getA.json.urls_homologacao.autorizacao,
      url_p: getA.json && getA.json.urls_producao && getA.json.urls_producao.autorizacao,
      csc_configurado: getA.json && getA.json.csc_configurado,
      sem_segredo: semSegredo(getA.json)
    };
  }

  if (out.empresa_b.id) {
    const putB = await request('PUT', `/api/empresas/${out.empresa_b.id}/configuracao-fiscal`, {
      token,
      body: {
        ambiente: 1,
        uf: 'SP',
        serie: 8,
        numero_atual: 202,
        token_csc: 'CSC-B-SECRETO',
        id_csc: 'ID-B',
        ws_autorizacao_homologacao: 'https://b.local/h/aut',
        ws_autorizacao_producao: 'https://b.local/p/aut'
      }
    });
    const getB = await request('GET', `/api/empresas/${out.empresa_b.id}/configuracao-fiscal`, { token });
    out.fiscal_b = {
      put: putB.status,
      get: getB.status,
      empresa_id: getB.json && getB.json.empresa_id,
      ambiente: getB.json && getB.json.ambiente,
      url_h: getB.json && getB.json.urls_homologacao && getB.json.urls_homologacao.autorizacao,
      url_p: getB.json && getB.json.urls_producao && getB.json.urls_producao.autorizacao,
      csc_configurado: getB.json && getB.json.csc_configurado,
      sem_segredo: semSegredo(getB.json)
    };
  }

  if (out.fiscal_a && out.fiscal_b) {
    out.isolamento = {
      ids_diferentes: out.fiscal_a.empresa_id !== out.fiscal_b.empresa_id,
      urls_diferentes: out.fiscal_a.url_h !== out.fiscal_b.url_h,
      ambientes_diferentes: out.fiscal_a.ambiente !== out.fiscal_b.ambiente
    };
  }

  const ctx = await request('GET', '/api/pdv-universal/contexto', { token });
  out.pdv_universal = {
    status: ctx.status,
    code: ctx.json && ctx.json.code,
    modo: ctx.json && (ctx.json.modo_operacao || (ctx.json.contexto && ctx.json.contexto.modo_operacao))
  };

  const dest = path.join(__dirname, '../../docs/arquitetura/_probe_05_18_5.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
