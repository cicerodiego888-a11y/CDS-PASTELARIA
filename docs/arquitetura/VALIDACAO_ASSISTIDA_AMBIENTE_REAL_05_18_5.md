# Validação assistida — ambiente real (05.18.5)

## Ambiente

- Comando oficial: `npm start` (Electron + backend no mesmo processo)
- Porta oficial: `process.env.PORT || 3001`
- Observado: `http://127.0.0.1:3001`
- Processo: terminal com `npm start` (pid da sessão Electron/Node)
- Banco: o do boot oficial (`C:\ProgramData\MercantilFiscal\dados\mercadao.db` nas sessões anteriores)

## HTTP sem autenticação (executado)

| Endpoint | Esperado | Real |
|---|---|---|
| GET / | redirect login | 302 → `/login?next=%2F` |
| GET /erp | ERP ou redirect | 301 `/erp/` depois **200** |
| GET /pdv-universal/ | HTML PDV Universal | **200** |
| GET /api/empresas | 401 sem token | **401** Acesso negado |

Sem `/api/api`.

ERP HTML ao vivo: `data-page="configuracoes-avancadas"` presente; **sem** `data-page="empresas"` na sidebar.

JS ao vivo: `/erp/js/gestao-empresas-fiscal.js?v=05172` **200**, `__CDS_EMPRESAS_MODULE_VERSION = '05.18'`.

## Login

Electron registrou `AUTH_LOGIN_DURATION` (operador logou na UI).

Login HTTP com candidatos conhecidos de diagnóstico (`admin`/`admin`, `admin`/`1234`) → **401**.

Token da sessão Electron **não** está disponível para o agente. Nenhuma API autenticada foi chamada. Token não foi registrado.

## Visual / Empresas A-B / PFX / PDV contexto

Não executados: o agente não controla a janela Electron e não obteve JWT.

UPLOAD REAL DO PFX NÃO EXECUTADO — sem sessão HTTP e sem arquivo de teste no agente.

## Motor / URL

Sem emissão. Encadeamento permanece o da 05.18.3 (transporte mockado em testes Node).

## Correções

Nenhuma. Falha observada: falta de credencial HTTP, não bug de rota.
