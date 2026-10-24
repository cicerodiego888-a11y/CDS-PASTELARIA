# Microsprint — Ajuste CSP `frame-ancestors`

**Data:** 18/10/2026  
**Dependência:** Microsprint CSP Electron CDS  
**Aviso alvo:** diretiva `frame-ancestors` ignorada / inválida em `<meta http-equiv="Content-Security-Policy">`

Não houve commit, push, merge, acesso ao banco oficial nem consulta SEFAZ.

---

## 1. Causa

`frame-ancestors` **só é honrada em cabeçalho HTTP** (e mecanismos equivalentes de resposta). Em tag `<meta>`, navegadores **ignoram** a diretiva — o que gera aviso de console e não oferece proteção de framing.

A política anterior repetia `frame-ancestors 'none'` na meta dos HTMLs principais.

---

## 2. Correção

| Mecanismo | Constante | `frame-ancestors 'none'` |
|---|---|---|
| Cabeçalho HTTP (Express) | `CSP_HTTP` | **Mantido** |
| Session Electron (`onHeadersReceived`) | `CSP_HTTP` | **Mantido** (header único, substitui o do Express) |
| `<meta>` nos HTMLs | `CSP_META` | **Removido** |

Demais diretivas permanecem iguais entre meta e HTTP. **Não** foi reintroduzido `unsafe-eval`.

### Diferença documentada (única permitida)

> `frame-ancestors 'none'` existe apenas no cabeçalho HTTP / session Electron; omitido na meta porque navegadores ignoram essa diretiva em `<meta>`.

Fonte: `documentarDiferencaEntregaCsp()` em `cds-csp-policy.js`.

### Electron — sem headers duplicados/contraditórios

`electron-csp.js` remove qualquer `Content-Security-Policy` (e report-only) da resposta e define **um** valor `CSP_HTTP`. Assim Express + session não acumulam políticas conflitantes.

---

## 3. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `cds-csp-policy.js` | `CSP_META` / `CSP_HTTP`; validação por mecanismo |
| `backend/middleware/cspHeaders.js` | Usa `CSP_HTTP` + exige `frame-ancestors` |
| `electron-csp.js` | Usa `CSP_HTTP`; header único |
| `frontend/erp/index.html` | Meta sem `frame-ancestors` |
| `frontend/pdv/index.html` | Meta sem `frame-ancestors` |
| `frontend/shared/login.html` | Meta sem `frame-ancestors` |
| `frontend/pdv-universal/index.html` | Meta sem `frame-ancestors` |
| `tests/electron/csp-policy.test.js` | Cobertura meta vs HTTP |
| `scripts/verificar-csp-electron.js` | Confirma HTTP vs META + bloqueio eval |
| `docs/seguranca/microsprint-csp-frame-ancestors-relatorio.md` | Este relatório |

---

## 4. Testes (resultados reais)

### Isolados

```text
node --test tests/electron/csp-policy.test.js
→ 10/10 pass
```

Cobertura relevante:

- Meta (login, ERP, PDV, PDV Universal) **sem** `frame-ancestors`
- Header HTTP nas mesmas rotas HTML **com** `frame-ancestors 'none'`
- Central de Entradas no bundle ERP (mesma meta/CSP do ERP)
- Sem `unsafe-eval` em meta e HTTP

### Runtime Electron

```text
.\node_modules\.bin\electron.cmd scripts\verificar-csp-electron.js
→ PASS
  - eval bloqueado
  - new Function bloqueado
  - CSP_HTTP mantém frame-ancestors 'none'
  - CSP_META sem frame-ancestors
  - session com header único
```

### Escopo UI (estático + HTTP)

Login, ERP, PDV e Central de Entradas validados via assets HTML + header nas rotas estáticas correspondentes (sem boot do banco oficial / SEFAZ).

---

## 5. Decisão

| Critério | Status |
|---|---|
| `frame-ancestors` removido da meta | Sim |
| `frame-ancestors 'none'` mantido no HTTP | Sim |
| `unsafe-eval` ausente | Sim |
| eval/new Function bloqueados (Electron) | Sim |
| Headers Electron sem duplicata contraditória | Sim |
| Remoção do HTTP só para silenciar aviso | **Não feita** |
